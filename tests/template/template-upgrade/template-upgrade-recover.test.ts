import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { templateUpgradeRecover } from "../../../src/template-upgrade-recover.ts";
import { createTemplateUpgradeRecoverResult } from "../../../src/template-upgrade-report.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitOutput,
  worktrees,
} from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

interface RefusalPayload {
  readonly status: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly repair: string;
    readonly retrySafe: boolean;
  };
}

interface RecoverPayload {
  readonly schemaVersion: number;
  readonly action: string;
  readonly status: string;
  readonly targetCommit: string;
  readonly worktree: string;
  readonly branch: string;
  readonly commit: string;
  readonly patchPath: string;
  readonly rerunCommand: string;
}

function parseRefusal(stderr: string): RefusalPayload {
  return JSON.parse(stderr) as RefusalPayload;
}

function parseRecover(stdout: string): RecoverPayload {
  return JSON.parse(stdout) as RecoverPayload;
}

function writeScriptedGit(
  prefix: string,
  failCondition: string,
  errorMessage: string,
) {
  const binFolder = folder(prefix);
  const ledger = join(binFolder, "git-calls.log");
  const realGit = Bun.which("git") ?? "git";
  const gitPath = join(binFolder, "git");
  writeFileSync(
    gitPath,
    `#!/bin/sh
echo "$*" >> ${JSON.stringify(ledger)}
if ${failCondition}; then
  echo ${JSON.stringify(errorMessage)} >&2
  exit 1
fi
exec ${JSON.stringify(realGit)} "$@"
`,
  );
  chmodSync(gitPath, 0o755);
  return {
    ledger,
    env: {
      ...templateUpgradeEnv(),
      PATH: `${binFolder}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function collectFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
  return found;
}

async function createFailedApplyWorktree(name: string) {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateLintChange(templateClone);
  const target7 = targetCommit.slice(0, 7);
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    name,
  );
  const failCheckBun = writeScriptedBun(
    folder,
    "scripted-bun-recover-fail-",
    `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  echo "planted check failure" >&2
  exit 1
fi
exit 0
`,
  );
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const failedRun = await invokeTemplateUpgradeMain(
    stdout,
    stderr,
    ["apply", "--repository", repo, "--to", targetCommit],
    { templateRoot: templateClone, env: failCheckBun.env },
  );
  expect(failedRun.exitCode).toBe(1);
  const targetWorktree = join(
    repo,
    ".worktrees",
    `template-upgrade-${target7}`,
  );
  return {
    templateClone,
    baseCommit,
    targetCommit,
    target7,
    repo,
    targetWorktree,
    stdout,
    stderr,
    runtime: { templateRoot: templateClone, env: templateUpgradeEnv() },
  };
}

test(
  "recovers a real failed upgrade apply worktree into a scrap branch and matching patch without --force, refuses repeat recover, and lets apply start clean",
  async () => {
    const setup = await createFailedApplyWorktree("recover-e2e-app");
    const porcelainBefore = gitOutput(
      setup.repo,
      "worktree",
      "list",
      "--porcelain",
    );
    expect(porcelainBefore).toContain(`worktree ${setup.targetWorktree}`);
    expect(porcelainBefore).toContain(
      `locked template-upgrade ${setup.targetCommit}`,
    );
    const resolvedLockPath = git(
      setup.targetWorktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "locked",
    );
    expect(readFileSync(resolvedLockPath, "utf8").trim()).toBe(
      `template-upgrade ${setup.targetCommit}`,
    );
    expect(
      gitOutput(
        setup.targetWorktree,
        "status",
        "--porcelain=v1",
        "--untracked-files=all",
      ),
    ).not.toBe("");

    writeFileSync(
      join(setup.targetWorktree, "recovery-extra.txt"),
      "untracked recovery note\n",
    );

    commitIn(setup.repo, "advance head after failed upgrade", {
      "owner-after-failure.txt": "new commit on main\n",
    });

    const hooksDir = folder("recover-hooks-");
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    git(setup.repo, "config", "core.hooksPath", hooksDir);

    const blockedApply = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      setup.runtime,
    );
    expect(blockedApply.exitCode).toBe(4);
    const blockedPayload = parseRefusal(blockedApply.stderr);
    expect(blockedPayload.error.code).toBe("worktree_exists_other_head");
    expect(blockedPayload.error.repair).toContain(
      `bun run upgrade recover --repository ${setup.repo} --to ${setup.target7}`,
    );
    expect(blockedPayload.error.repair).not.toContain("--force");

    const loggingGit = writeScriptedGit(
      "git-no-force-check-",
      'printf "%s" "$*" | grep -q "worktree remove.*--force"',
      "forbidden --force on worktree remove",
    );
    const recoveredRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      recoverJsonArgs(setup.repo, setup.targetCommit),
      { templateRoot: setup.templateClone, env: loggingGit.env },
    );
    expect(recoveredRun.exitCode).toBe(0);
    expect(recoveredRun.stderr).toBe("");
    const payload = parseRecover(recoveredRun.stdout);
    const expectedBranch = `template-upgrade/${setup.target7}-failed-1`;
    const expectedPatch = join(
      setup.repo,
      ".worktrees",
      `template-upgrade-${setup.target7}-failed-1.patch`,
    );
    const expectedRerun = `bun run upgrade apply --repository ${setup.repo} --to ${setup.target7}`;
    expect(payload).toEqual({
      schemaVersion: 1,
      action: "recover",
      status: "recovered",
      targetCommit: setup.targetCommit,
      worktree: setup.targetWorktree,
      branch: expectedBranch,
      commit: git(setup.repo, "rev-parse", expectedBranch),
      patchPath: expectedPatch,
      rerunCommand: expectedRerun,
    });
    expect(existsSync(setup.targetWorktree)).toBe(false);
    expect(existsSync(resolvedLockPath)).toBe(false);
    expect(worktrees(setup.repo)).toHaveLength(1);
    expect(git(setup.repo, "branch", "--list", expectedBranch)).toBe(
      expectedBranch,
    );
    expect(
      git(setup.repo, "show", `${expectedBranch}:recovery-extra.txt`),
    ).toBe("untracked recovery note");
    const branchDiff = gitOutput(
      setup.repo,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--binary",
      `${expectedBranch}^`,
      expectedBranch,
    );
    expect(readFileSync(expectedPatch, "utf8")).toBe(branchDiff);
    expect(readFileSync(loggingGit.ledger, "utf8")).toContain(
      `worktree remove ${setup.targetWorktree}`,
    );
    expect(readFileSync(loggingGit.ledger, "utf8")).not.toContain("--force");
    expect(gitOutput(setup.repo, "status", "--porcelain=v1")).toBe("");

    const secondRecover = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      recoverJsonArgs(setup.repo, setup.targetCommit),
      setup.runtime,
    );
    expect(secondRecover.exitCode).toBe(4);
    expect(secondRecover.stdout).toBe("");
    const secondPayload = parseRefusal(secondRecover.stderr);
    expect(secondPayload.status).toBe("refused");
    expect(secondPayload.error.code).toBe("worktree_missing");
    expect(secondPayload.error.retrySafe).toBe(true);
    expect(secondPayload.error.repair).not.toBe("");

    git(setup.repo, "config", "--unset", "core.hooksPath");

    const followUpApply = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      setup.runtime,
    );
    expect(followUpApply.exitCode).toBe(0);
    expect(JSON.parse(followUpApply.stdout)).toMatchObject({
      action: "apply",
      status: "applied",
    });
    expect(git(setup.repo, "branch", "--list", expectedBranch)).toBe(
      expectedBranch,
    );
    expect(existsSync(expectedPatch)).toBe(true);
  },
  processWatchdog(6),
);

test(
  "picks lowest unused n across scrap branches and patch files, prints text output, and supports in-process calls",
  async () => {
    const setup = await createFailedApplyWorktree("recover-index-app");
    git(setup.repo, "branch", `template-upgrade/${setup.target7}-failed-1`);
    writeFileSync(
      join(
        setup.repo,
        ".worktrees",
        `template-upgrade-${setup.target7}-failed-2.patch`,
      ),
      "existing patch 2\n",
    );
    git(setup.repo, "branch", `template-upgrade/${setup.target7}-failed-4`);

    const textRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      ["recover", "--repository", setup.repo, "--to", setup.targetCommit],
      setup.runtime,
    );
    expect(textRun.exitCode).toBe(0);
    expect(textRun.stderr).toBe("");
    const branch3 = `template-upgrade/${setup.target7}-failed-3`;
    const patch3 = join(
      setup.repo,
      ".worktrees",
      `template-upgrade-${setup.target7}-failed-3.patch`,
    );
    expect(textRun.stdout).toContain(branch3);
    expect(textRun.stdout).toContain(patch3);
    expect(textRun.stdout).toContain(
      `bun run upgrade apply --repository ${setup.repo} --to ${setup.target7}`,
    );
    expect(existsSync(patch3)).toBe(true);
    expect(
      readFileSync(
        join(
          setup.repo,
          ".worktrees",
          `template-upgrade-${setup.target7}-failed-2.patch`,
        ),
        "utf8",
      ),
    ).toBe("existing patch 2\n");

    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.targetWorktree,
      "HEAD",
    );
    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${setup.targetCommit}`,
      setup.targetWorktree,
    );
    writeFileSync(
      join(setup.targetWorktree, "in-process.txt"),
      "in-process edit\n",
    );
    const directResult = await templateUpgradeRecover({
      templateRoot: setup.templateClone,
      repository: setup.repo,
      targetRef: setup.targetCommit,
      env: setup.runtime.env,
    });
    expect(directResult.branch).toBe(
      `template-upgrade/${setup.target7}-failed-5`,
    );
    expect(directResult.patchPath).toBe(
      join(
        setup.repo,
        ".worktrees",
        `template-upgrade-${setup.target7}-failed-5.patch`,
      ),
    );
    expect(
      createTemplateUpgradeRecoverResult({
        targetCommit: directResult.targetCommit,
        worktree: directResult.worktree,
        branch: directResult.branch,
        commit: directResult.commit,
        patchPath: directResult.patchPath,
        rerunCommand: directResult.rerunCommand,
      }),
    ).toEqual(directResult);
  },
  processWatchdog(6),
);

test(
  "refuses missing, prunable, unowned, foreign-locked, plain-entry, and symlinked worktrees without touching them",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const target7 = targetCommit.slice(0, 7);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "recover-refusals-app",
    );
    const targetWorktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${target7}`,
    );
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const recoverArgs = recoverJsonArgs(repo, targetCommit);

    const expectRefusal = async (
      expectedCode: string,
      expectedMessage: string,
      expectedExit = 4,
      expectedRetrySafe?: boolean,
    ) => {
      const run = await invokeTemplateUpgradeMain(
        stdout,
        stderr,
        recoverArgs,
        runtime,
      );
      expect(run.exitCode).toBe(expectedExit);
      const payload = parseRefusal(run.stderr);
      expect(payload.status).toBe("refused");
      expect(payload.error.code).toBe(expectedCode);
      if (expectedRetrySafe !== undefined) {
        expect(payload.error.retrySafe).toBe(expectedRetrySafe);
      }
      expect(payload.error.message).toContain(expectedMessage);
    };

    await expectRefusal(
      "worktree_missing",
      `no failed upgrade worktree found at ${targetWorktree}`,
      4,
      true,
    );

    git(repo, "worktree", "add", "--quiet", "--detach", targetWorktree, "HEAD");
    const ownerFile = join(targetWorktree, "owner-work.txt");
    writeFileSync(ownerFile, "do not touch\n");

    await expectRefusal(
      "worktree_not_owned",
      "not locked by template-upgrade",
      4,
      false,
    );
    expect(readFileSync(ownerFile, "utf8")).toBe("do not touch\n");
    expect(
      git(repo, "branch", "--list", `template-upgrade/${target7}-failed-*`),
    ).toBe("");

    git(
      repo,
      "worktree",
      "lock",
      "--reason",
      "manual owner lock",
      targetWorktree,
    );
    await expectRefusal("worktree_not_owned", "manual owner lock", 4, false);
    expect(readFileSync(ownerFile, "utf8")).toBe("do not touch\n");

    git(repo, "worktree", "unlock", targetWorktree);
    rmSync(ownerFile);
    git(repo, "worktree", "remove", targetWorktree);

    mkdirSync(targetWorktree, { recursive: true });
    writeFileSync(join(targetWorktree, "plain.txt"), "plain folder\n");
    await expectRefusal("worktree_not_owned", "plain folder", 4, false);
    expect(readFileSync(join(targetWorktree, "plain.txt"), "utf8")).toBe(
      "plain folder\n",
    );
    rmSync(targetWorktree, { recursive: true, force: true });

    const externalTarget = folder("recover-symlink-target-");
    symlinkSync(externalTarget, targetWorktree);
    await expectRefusal("symlink_ancestor", target7, 2);
    expect(lstatSync(targetWorktree).isSymbolicLink()).toBe(true);
    rmSync(targetWorktree);

    git(repo, "worktree", "add", "--quiet", "--detach", targetWorktree, "HEAD");
    git(
      repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${targetCommit}`,
      targetWorktree,
    );
    rmSync(targetWorktree, { recursive: true, force: true });
    await expectRefusal(
      "worktree_missing",
      `no failed upgrade worktree directory found at ${targetWorktree}`,
      4,
      true,
    );
  },
  processWatchdog(6),
);

function recoverJsonArgs(repo: string, targetCommit: string): string[] {
  return ["recover", "--repository", repo, "--to", targetCommit, "--json"];
}

async function assertRecoverStepFailure(options: {
  readonly appName: string;
  readonly gitPrefix: string;
  readonly failCondition: string;
  readonly errorMessage: string;
  readonly expectedCode: string;
  readonly expectPatchBeforeRetry: boolean;
}): Promise<void> {
  const setup = await createFailedApplyWorktree(options.appName);
  const failingGit = writeScriptedGit(
    options.gitPrefix,
    options.failCondition,
    options.errorMessage,
  );
  const args = recoverJsonArgs(setup.repo, setup.targetCommit);
  const failRun = await invokeTemplateUpgradeMain(
    setup.stdout,
    setup.stderr,
    args,
    { templateRoot: setup.templateClone, env: failingGit.env },
  );
  expect(failRun.exitCode).toBe(1);
  const branch1 = `template-upgrade/${setup.target7}-failed-1`;
  const patch1 = join(
    setup.repo,
    ".worktrees",
    `template-upgrade-${setup.target7}-failed-1.patch`,
  );
  const failPayload = parseRefusal(failRun.stderr);
  expect(failPayload.error.code).toBe(options.expectedCode);
  expect(failPayload.error.message).toContain(branch1);
  if (options.expectPatchBeforeRetry) {
    expect(failPayload.error.message).toContain(patch1);
  }
  expect(failPayload.error.repair).not.toBe("");
  expect(existsSync(setup.targetWorktree)).toBe(true);
  expect(existsSync(patch1)).toBe(options.expectPatchBeforeRetry);
  expect(gitOutput(setup.repo, "worktree", "list", "--porcelain")).toContain(
    `locked template-upgrade ${setup.targetCommit}`,
  );

  const retryRun = await invokeTemplateUpgradeMain(
    setup.stdout,
    setup.stderr,
    args,
    setup.runtime,
  );
  expect(retryRun.exitCode).toBe(0);
  const retryPayload = parseRecover(retryRun.stdout);
  expect(retryPayload.branch).toBe(branch1);
  expect(retryPayload.patchPath).toBe(patch1);
  expect(existsSync(setup.targetWorktree)).toBe(false);
  expect(existsSync(patch1)).toBe(true);
  expect(readFileSync(patch1, "utf8")).toBe(
    gitOutput(
      setup.repo,
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--binary",
      `${branch1}^`,
      branch1,
    ),
  );
  expect(
    git(
      setup.repo,
      "branch",
      "--list",
      `template-upgrade/${setup.target7}-failed-2`,
    ),
  ).toBe("");
}

test(
  "refuses with worktree_patch_failed, worktree_unlock_failed, and worktree_remove_failed without partial removal",
  async () => {
    await assertRecoverStepFailure({
      appName: "recover-patch-fail-",
      gitPrefix: "git-diff-fail-",
      failCondition: 'printf "%s" "$*" | grep -q -- " diff --no-color"',
      errorMessage: "simulated git diff failure",
      expectedCode: "worktree_patch_failed",
      expectPatchBeforeRetry: false,
    });
    await assertRecoverStepFailure({
      appName: "recover-unlock-fail-",
      gitPrefix: "git-unlock-fail-",
      failCondition: 'printf "%s" "$*" | grep -q "worktree unlock"',
      errorMessage: "simulated git worktree unlock failure",
      expectedCode: "worktree_unlock_failed",
      expectPatchBeforeRetry: true,
    });
    await assertRecoverStepFailure({
      appName: "recover-remove-fail-",
      gitPrefix: "git-remove-fail-",
      failCondition: 'printf "%s" "$*" | grep -q "worktree remove"',
      errorMessage: "simulated git worktree remove failure",
      expectedCode: "worktree_remove_failed",
      expectPatchBeforeRetry: true,
    });
  },
  processWatchdog(6),
);

test("no repair line or document under src/ or docs/ tells the caller to pass --force to git worktree remove", () => {
  const candidates = [
    ...collectFiles(join(ROOT, "src")),
    ...collectFiles(join(ROOT, "docs")),
  ];
  const violations: string[] = [];
  const forceRemovePattern =
    /git\s+worktree\s+remove[\s\S]{0,120}?(?:--force\b|\s-f\b)|--force\b[\s\S]{0,120}?git\s+worktree\s+remove/;
  for (const filePath of candidates) {
    const text = readFileSync(filePath, "utf8");
    const match = forceRemovePattern.exec(text);
    if (match !== null) {
      violations.push(`${filePath}: ${match[0].replaceAll("\n", " ").trim()}`);
    }
  }
  expect(violations).toEqual([]);
  expect(
    readFileSync(join(ROOT, "docs/template-upgrade.md"), "utf8"),
  ).not.toContain("--force");
  expect(
    readFileSync(join(ROOT, "src/template-upgrade-recover.ts"), "utf8"),
  ).not.toContain("--force");
});
