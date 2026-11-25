import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import {
  templateUpgradeApply,
  templateUpgradePlan,
} from "../../../src/template-upgrade-apply.ts";
import { withTemplateUpgradeTrees } from "../../../src/template-upgrade-bootstrap.ts";
import {
  decodeUtf8Strict,
  gitCommitIdentityArgs,
  gitDiffFiles,
  gitMergeFile,
  lstatIfPresent,
  readCommittedBytes,
  readCommittedBytesAt,
  resolveTemplateCommit,
  runGitCommand,
  runGitText,
  TEMPLATE_UPGRADE_FLOOR,
  toolchainEnvironment,
  verifyGitRepository,
  verifyTemplateAncestry,
  withoutGitLocation,
} from "../../../src/template-upgrade-git.ts";
import { resolveTemplateUpgradeInputs } from "../../../src/template-upgrade-inputs.ts";
import { removeTemplateUpgradeWorktree } from "../../../src/template-upgrade-worktree-lock.ts";
import {
  findConflictMarkerFiles,
  templateUpgradeBranchName,
  templateUpgradeCommitMessage,
  treesEqual,
} from "../../../src/template-upgrade-worktree.ts";
import { main } from "../../../src/template-upgrade.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  initRepository,
} from "../../support/git-fixture.ts";
import { siblingKernel, trialBase } from "../../support/kernel-sibling.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import { cloneTemplateAtHead } from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

async function captureAsyncCliError(
  run: () => Promise<unknown>,
): Promise<CliError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected an async CliError refusal.");
}

function captureCliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a CliError refusal.");
}

const DEFAULT_KERNEL_PIN = `github:nathanvale/agent-cli-kernel#${trialBase}`;

function makeTemplateHistory() {
  return {
    templateRoot: ROOT,
    baseCommit: TEMPLATE_UPGRADE_FLOOR,
    targetCommit: git(ROOT, "rev-parse", "HEAD"),
  };
}

function makeStampedRepository(
  stamp: Record<string, unknown>,
  packageName?: string,
  kernelPinSpecifier: string | null = DEFAULT_KERNEL_PIN,
  stampFile = ".template.json",
) {
  const repository = folder("upgrade-repo-");
  initRepository(repository);
  const files: Record<string, string> = {
    [stampFile]: `${JSON.stringify(stamp, null, 2)}\n`,
  };
  if (packageName !== undefined) {
    const manifest: Record<string, unknown> = { name: packageName };
    if (kernelPinSpecifier !== null) {
      manifest.dependencies = { "agent-cli-kernel": kernelPinSpecifier };
    }
    files["package.json"] = `${JSON.stringify(manifest, null, 2)}\n`;
  }
  const initial = commitIn(repository, "initial", files);
  return { repository, head: initial.sha };
}

test("refuses a path that is not a git repository or is a subfolder", () => {
  const plain = folder("not-a-repo-");
  const missing = join(plain, "does-not-exist");
  expect(captureCliError(() => verifyGitRepository(plain, gitEnv)).code).toBe(
    "not_git_repository",
  );
  expect(captureCliError(() => verifyGitRepository(missing, gitEnv)).code).toBe(
    "not_git_repository",
  );

  const repository = folder("nested-repo-");
  initRepository(repository);
  commitIn(repository, "init", { "README.md": "hi\n" });
  const subfolder = join(repository, "sub");
  mkdirSync(subfolder);
  expect(
    captureCliError(() => verifyGitRepository(subfolder, gitEnv)).code,
  ).toBe("not_git_repository");
});

test("refuses a repository with no HEAD commit and one with no committed stamp", () => {
  const emptyRepo = folder("empty-repo-");
  initRepository(emptyRepo);
  expect(
    captureCliError(() => verifyGitRepository(emptyRepo, gitEnv)).code,
  ).toBe("repository_head_missing");

  const { templateRoot, baseCommit } = makeTemplateHistory();
  const unstamped = folder("unstamped-repo-");
  initRepository(unstamped);
  commitIn(unstamped, "init", { "package.json": '{"name":"demo"}\n' });
  write(
    unstamped,
    ".template.json",
    JSON.stringify({
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    }),
  );
  const refusal = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: unstamped,
      targetRef: "HEAD",
      env: gitEnv,
    }),
  );
  expect(refusal.code).toBe("stamp_missing");
  expect(refusal.repair).toContain(".template.json");
});

test("refuses templateDirty: true from HEAD even when working tree is edited", () => {
  const { templateRoot, baseCommit } = makeTemplateHistory();
  const { repository } = makeStampedRepository(
    {
      name: "demo",
      templateRevision: baseCommit,
      templateDirty: true,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  write(
    repository,
    ".template.json",
    JSON.stringify({
      name: "demo",
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    }),
  );
  const refusal = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository,
      targetRef: "HEAD",
      env: gitEnv,
    }),
  );
  expect(refusal.code).toBe("template_dirty");
});

test("refuses base commit missing from template history and non-descendant downgrades", () => {
  const { templateRoot, baseCommit, targetCommit } = makeTemplateHistory();
  const unknownBase = makeStampedRepository(
    {
      name: "demo",
      templateRevision: "a".repeat(40),
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  expect(
    captureCliError(() =>
      resolveTemplateUpgradeInputs({
        templateRoot,
        repository: unknownBase.repository,
        targetRef: "HEAD",
        env: gitEnv,
      }),
    ).code,
  ).toBe("base_commit_missing");

  const newerRepo = makeStampedRepository(
    {
      name: "demo",
      templateRevision: targetCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  expect(
    captureCliError(() =>
      resolveTemplateUpgradeInputs({
        templateRoot,
        repository: newerRepo.repository,
        targetRef: baseCommit,
        env: gitEnv,
      }),
    ).code,
  ).toBe("target_not_descendant");

  expect(
    captureCliError(() =>
      resolveTemplateCommit(templateRoot, "refs/heads/no-such-branch", gitEnv),
    ).code,
  ).toBe("target_ref_invalid");
});

test("reads repository name from stamp first and falls back to HEAD:package.json", () => {
  const { templateRoot, baseCommit, targetCommit } = makeTemplateHistory();
  const fromStamp = makeStampedRepository(
    {
      name: "from-stamp",
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "from-package",
  );
  expect(
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: fromStamp.repository,
      targetRef: "HEAD",
      env: gitEnv,
    }),
  ).toMatchObject({
    baseCommit,
    targetCommit,
    repositoryName: "from-stamp",
    sourcePacket: "/abs/packet",
  });

  const fromPackage = makeStampedRepository(
    {
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "legacy-name",
  );
  expect(
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: fromPackage.repository,
      targetRef: "HEAD",
      env: gitEnv,
    }).repositoryName,
  ).toBe("legacy-name");
});

test("refuses when HEAD:package.json has no non-empty string name even if stamp has name", () => {
  const { templateRoot, baseCommit, targetCommit } = makeTemplateHistory();
  const baseStamp = {
    name: "skills-private",
    templateRevision: baseCommit,
    templateDirty: false,
    sourcePacket: "/abs/packet",
  };
  for (const manifest of [
    { dependencies: { "agent-cli-kernel": DEFAULT_KERNEL_PIN } },
    { name: "", dependencies: { "agent-cli-kernel": DEFAULT_KERNEL_PIN } },
    { name: "   ", dependencies: { "agent-cli-kernel": DEFAULT_KERNEL_PIN } },
    { name: 42, dependencies: { "agent-cli-kernel": DEFAULT_KERNEL_PIN } },
  ]) {
    const repository = folder("missing-package-name-");
    initRepository(repository);
    commitIn(repository, "initial", {
      ".template.json": `${JSON.stringify(baseStamp, null, 2)}\n`,
      "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    });
    const refusal = captureCliError(() =>
      resolveTemplateUpgradeInputs({
        templateRoot,
        repository,
        targetRef: targetCommit,
        env: gitEnv,
      }),
    );
    expect(refusal.code).toBe("repository_name_missing");
    expect(refusal.message).toContain("package.json");
    expect(refusal.message).toContain('"name"');
    expect(refusal.repair).toContain("package.json");
  }
});

test("returns up-to-date and writes nothing when base equals target", async () => {
  const { templateRoot, targetCommit } = makeTemplateHistory();
  const { repository } = makeStampedRepository(
    {
      name: "demo",
      templateRevision: targetCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);

  const planExit = await main(["plan", "--repository", repository, "--json"], {
    templateRoot,
    env: gitEnv,
  });
  expect(planExit).toBe(0);
  expect(stderr()).toBe("");
  expect(JSON.parse(stdout())).toMatchObject({
    action: "plan",
    status: "up-to-date",
    baseCommit: targetCommit,
    targetCommit,
    rows: [],
    templateCopyChanges: [],
  });

  const inputs = resolveTemplateUpgradeInputs({
    templateRoot,
    repository,
    targetRef: "HEAD",
    env: gitEnv,
  });
  const planDirect = await templateUpgradePlan(inputs, gitEnv);
  expect(planDirect.status).toBe("up-to-date");
  const applyDirect = await templateUpgradeApply(inputs, {
    skipCheckCommand: true,
    env: gitEnv,
  });
  expect(applyDirect.exitCode).toBe(0);
  expect(applyDirect.result.status).toBe("up-to-date");
  expect(existsSync(join(repository, ".worktrees"))).toBe(false);
});

test("refuses when the template upgrade branch already exists from another HEAD", async () => {
  const { templateRoot, baseCommit, targetCommit } = makeTemplateHistory();
  const { repository } = makeStampedRepository(
    {
      name: "demo",
      templateRevision: baseCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  const branch = templateUpgradeBranchName(baseCommit, targetCommit);
  git(repository, "branch", branch);
  commitIn(repository, "advance head", { "owner.txt": "moved\n" });

  const inputs = resolveTemplateUpgradeInputs({
    templateRoot,
    repository,
    targetRef: "HEAD",
    env: gitEnv,
  });
  const refusal = await captureAsyncCliError(() =>
    templateUpgradeApply(inputs, { skipCheckCommand: true, env: gitEnv }),
  );
  expect(refusal.code).toBe("branch_exists_other_head");
  expect(refusal.message).toBe(
    `branch ${branch} already exists from another commit`,
  );
});

test("refuses a base commit older than the template upgrade floor before regenerating", () => {
  const { templateRoot, targetCommit } = makeTemplateHistory();
  const preFloorCommit = git(
    templateRoot,
    "rev-parse",
    `${TEMPLATE_UPGRADE_FLOOR}~1`,
  );
  const oldRepo = makeStampedRepository(
    {
      name: "demo",
      templateRevision: preFloorCommit,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  const refusal = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: oldRepo.repository,
      targetRef: targetCommit,
      env: gitEnv,
    }),
  );
  expect(refusal.code).toBe("base_commit_unsupported");
  expect(refusal.message).toContain(TEMPLATE_UPGRADE_FLOOR.slice(0, 7));
  expect(refusal.message).toContain("--profile");
  expect(refusal.repair).toContain("newer template");
  expect(refusal.repair).toContain("by hand");
});

test("refuses when HEAD:package.json has a missing or non-full agent-cli-kernel Pin", () => {
  const { templateRoot, baseCommit, targetCommit } = makeTemplateHistory();
  const baseStamp = {
    name: "demo",
    templateRevision: baseCommit,
    templateDirty: false,
    sourcePacket: "/abs/packet",
  };
  const noPackage = makeStampedRepository(baseStamp, undefined, null);
  const missingPackage = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: noPackage.repository,
      targetRef: targetCommit,
      env: gitEnv,
    }),
  );
  expect(missingPackage.code).toBe("repository_pin_missing");
  expect(missingPackage.repair).toContain("package.json");

  const noKernelDep = makeStampedRepository(baseStamp, "demo", null);
  const missingKernel = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: noKernelDep.repository,
      targetRef: targetCommit,
      env: gitEnv,
    }),
  );
  expect(missingKernel.code).toBe("repository_pin_missing");
  expect(missingKernel.repair).toContain("agent-cli-kernel");

  const shortPinRepo = makeStampedRepository(
    baseStamp,
    "demo",
    "github:nathanvale/agent-cli-kernel#c084594",
  );
  const shortPin = captureCliError(() =>
    resolveTemplateUpgradeInputs({
      templateRoot,
      repository: shortPinRepo.repository,
      targetRef: targetCommit,
      env: gitEnv,
    }),
  );
  expect(shortPin.code).toBe("repository_pin_invalid");
  expect(shortPin.repair).toContain("40-character");

  const branchPinRepo = makeStampedRepository(
    baseStamp,
    "demo",
    "github:nathanvale/agent-cli-kernel#main",
  );
  expect(
    captureCliError(() =>
      resolveTemplateUpgradeInputs({
        templateRoot,
        repository: branchPinRepo.repository,
        targetRef: targetCommit,
        env: gitEnv,
      }),
    ).code,
  ).toBe("repository_pin_invalid");
});

test("withTemplateUpgradeTrees refuses a failing bootstrap, quotes its error, names moving the Pin in repair, and cleans up", async () => {
  const { templateClone } = cloneTemplateAtHead(folder);
  const failingBootstrap =
    'process.stderr.write(JSON.stringify({error:{message:"planted boom",repair:"fix it"}})); process.exit(1);\n';
  const first = commitIn(templateClone, "broken base", {
    "src/bootstrap.ts": failingBootstrap,
  });
  const second = commitIn(templateClone, "broken target", {
    "README.md": "next\n",
  });
  const { repository } = makeStampedRepository(
    {
      name: "demo",
      templateRevision: first.sha,
      templateDirty: false,
      sourcePacket: "/abs/packet",
    },
    "demo",
  );
  const inputs = resolveTemplateUpgradeInputs({
    templateRoot: templateClone,
    repository,
    targetRef: second.sha,
    env: gitEnv,
  });
  const refusal = await captureAsyncCliError(() =>
    withTemplateUpgradeTrees(
      inputs,
      { ...gitEnv, KERNEL_REPOSITORY: siblingKernel() },
      () => Promise.resolve("unreachable"),
    ),
  );
  expect(refusal.code).toBe("regeneration_failed");
  expect(refusal.message).toContain("planted boom");
  expect(refusal.repair).toContain("Pin");
});

test("template upgrade environment, UTF-8 decoding, merge-file, and diff helpers enforce strictness", async () => {
  const scratch = folder("git-utils-");
  const stripped = withoutGitLocation({
    GIT_DIR: join(scratch, "git-dir"),
    KEEP: "yes",
  });
  expect(stripped).toEqual({ KEEP: "yes" });
  const binA = join(scratch, "bin-a");
  const binB = join(scratch, "bin-b");
  const nodeBin = join(scratch, "repo", "node_modules", ".bin");
  expect(
    toolchainEnvironment({
      GIT_WORK_TREE: join(scratch, "work"),
      PATH: `${binA}:${nodeBin}:${binB}`,
    }),
  ).toEqual({ PATH: `${binA}:${binB}` });
  expect(
    captureCliError(() =>
      decodeUtf8Strict(new Uint8Array([0xff, 0xfe]), "sample"),
    ).code,
  ).toBe("invalid_utf8");

  expect(await lstatIfPresent(join(scratch, "missing"))).toBeUndefined();
  const ours = join(scratch, "ours.txt");
  const base = join(scratch, "base.txt");
  const next = join(scratch, "next.txt");
  writeFileSync(ours, "a\nb\nc\n");
  writeFileSync(base, "a\nb\nc\n");
  writeFileSync(next, "a\nb\nd\n");
  expect(gitMergeFile(ours, base, next, gitEnv)).toBe("clean");
  const diff = await gitDiffFiles({
    oldPath: base,
    newPath: next,
    relativePath: "README.md",
    env: gitEnv,
  });
  expect(diff).toContain("--- old/README.md");
  expect(diff).toContain("+++ new/README.md");
  expect(diff).toContain("-c");
  expect(diff).toContain("+d");
});

test("template upgrade tree comparison, conflict scanning, and git worktree helpers behave consistently", async () => {
  const left = folder("cmp-left-");
  const right = folder("cmp-right-");
  write(left, "file.txt", "<<<<<<< ours\nx\n=======\ny\n>>>>>>> new\n");
  write(right, "file.txt", "<<<<<<< ours\nx\n=======\ny\n>>>>>>> new\n");
  expect(await treesEqual(left, right)).toBe(true);
  expect(await findConflictMarkerFiles(left)).toEqual(["file.txt"]);
  write(right, "file.txt", "resolved\n");
  expect(await treesEqual(left, right)).toBe(false);
  expect(await findConflictMarkerFiles(right)).toEqual([]);

  const repo = folder("wt-utils-");
  initRepository(repo);
  const { sha } = commitIn(repo, "init", { "a.txt": "1\n" });
  expect(readCommittedBytes(repo, "a.txt", gitEnv)).toEqual(
    new Uint8Array(Buffer.from("1\n")),
  );
  expect(readCommittedBytesAt(repo, sha, "a.txt", gitEnv)).toEqual(
    new Uint8Array(Buffer.from("1\n")),
  );
  expect(readCommittedBytes(repo, "absent.txt", gitEnv)).toBeUndefined();
  expect(
    gitCommitIdentityArgs(repo, {
      GIT_AUTHOR_NAME: "author",
      GIT_AUTHOR_EMAIL: "author@example.com",
    }),
  ).toEqual([]);
  verifyTemplateAncestry(
    ROOT,
    TEMPLATE_UPGRADE_FLOOR,
    git(ROOT, "rev-parse", "HEAD"),
    gitEnv,
  );
  expect(
    runGitText(
      repo,
      ["rev-parse", "HEAD"],
      { code: "err", message: "err", repair: "rep" },
      { env: gitEnv },
    ),
  ).toBe(sha);
  expect(
    runGitCommand(repo, ["status", "--porcelain"], { env: gitEnv }).exitCode,
  ).toBe(0);
  const wt = join(repo, ".worktrees", "sample");
  mkdirSync(join(repo, ".worktrees"), { recursive: true });
  git(repo, "worktree", "add", "--quiet", "--detach", wt, sha);
  git(repo, "worktree", "lock", "--reason", `template-upgrade ${sha}`, wt);
  await removeTemplateUpgradeWorktree(repo, wt, gitEnv);
  expect(existsSync(wt)).toBe(false);
  expect(templateUpgradeCommitMessage("1234567890", "abcdef0123")).toBe(
    "Upgrade template 1234567 to abcdef0",
  );
});
