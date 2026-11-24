import { expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import { mergeTemplateUpgradeTrees } from "../../../src/template-upgrade-merge.ts";
import { removeTemplateUpgradeWorktree } from "../../../src/template-upgrade-worktree-lock.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  worktrees,
} from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

async function makeConflictingRepository() {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateUpgradeChanges(templateClone);
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "worktree-safety-app",
  );
  const addOnLines = readFileSync(
    join(repo, "tests/add-on-start-up.test.ts"),
    "utf8",
  ).split("\n");
  const describeIndex = addOnLines.findIndex((line) =>
    line.includes("describe("),
  );
  const editIndex = describeIndex >= 0 ? describeIndex : 0;
  addOnLines[editIndex] = (addOnLines[editIndex] ?? "").replace(
    '"',
    '"owner-edited ',
  );
  commitIn(repo, "owner conflict edit", {
    "tests/add-on-start-up.test.ts": addOnLines.join("\n"),
  });
  return { templateClone, baseCommit, targetCommit, repo };
}

test(
  "refuses a committed symbolic link ancestor folder in both plan and apply without touching external files",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "linked-config-app",
    );
    const externalConfig = join(folder("external-config-"), "config");
    cpSync(join(repo, "config"), externalConfig, { recursive: true });
    git(repo, "rm", "--quiet", "-r", "--", "config");
    symlinkSync(externalConfig, join(repo, "config"));
    git(repo, "add", "--", "config");
    git(repo, "commit", "--quiet", "-m", "replace config folder with symlink");

    const externalFile = join(externalConfig, "platform-rules.mjs");
    const externalBefore = readFileSync(externalFile, "utf8");
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(planRun.exitCode).toBe(2);
    expect(planRun.stdout).toBe("");
    const planError = JSON.parse(planRun.stderr) as {
      status: string;
      error: { code: string; message: string; repair: string };
    };
    expect(planError.status).toBe("refused");
    expect(planError.error.code).toBe("symlink_ancestor");
    expect(planError.error.message).toContain("config");
    expect(planError.error.repair).toContain("config");
    expect(readFileSync(externalFile, "utf8")).toBe(externalBefore);
    expect(existsSync(join(externalConfig, "host-platform-rules.mjs"))).toBe(
      false,
    );

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(2);
    expect(applyRun.stdout).toBe("");
    const applyError = JSON.parse(applyRun.stderr) as {
      status: string;
      error: { code: string; message: string; repair: string };
    };
    expect(applyError.status).toBe("refused");
    expect(applyError.error.code).toBe("symlink_ancestor");
    expect(applyError.error.message).toContain("config");
    expect(readFileSync(externalFile, "utf8")).toBe(externalBefore);
    expect(existsSync(join(externalConfig, "host-platform-rules.mjs"))).toBe(
      false,
    );
    expect(existsSync(join(repo, ".worktrees"))).toBe(false);
  },
  processWatchdog(4),
);

test(
  "refuses when .worktrees itself is a symbolic link before writing anything",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "linked-worktrees-app",
    );
    const externalWorktrees = folder("external-worktrees-");
    symlinkSync(externalWorktrees, join(repo, ".worktrees"));
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(planRun.exitCode).toBe(2);
    expect(JSON.parse(planRun.stderr)).toMatchObject({
      status: "refused",
      error: { code: "symlink_ancestor" },
    });

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(2);
    const applyError = JSON.parse(applyRun.stderr) as {
      status: string;
      error: { code: string; message: string; repair: string };
    };
    expect(applyError.status).toBe("refused");
    expect(applyError.error.code).toBe("symlink_ancestor");
    expect(applyError.error.message).toContain(".worktrees");
    expect(applyError.error.repair).toContain(".worktrees");
    expect(worktrees(repo)).toHaveLength(1);
  },
  processWatchdog(4),
);

test(
  "refuses and preserves an existing upgrade worktree whose HEAD is older than the repository HEAD",
  async () => {
    const { templateClone, targetCommit, repo } =
      await makeConflictingRepository();
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const applyArgs = applyNoCheckJsonArgs(repo, targetCommit);

    const firstRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(firstRun.exitCode).toBe(2);
    const firstPayload = JSON.parse(firstRun.stdout) as { worktree: string };
    const worktreePath = firstPayload.worktree;
    const ownerResolutionFile = join(worktreePath, "owner-resolution.txt");
    writeFileSync(ownerResolutionFile, "owner work must survive\n");
    const partialPath = join(worktreePath, "tests/add-on-start-up.test.ts");
    const partialContent = `${readFileSync(partialPath, "utf8")}\n// partial\n`;
    writeFileSync(partialPath, partialContent);

    commitIn(repo, "advance repository head", {
      "owner-note.txt": "new commit on main\n",
    });

    const rerun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(rerun.exitCode).toBe(4);
    expect(rerun.stdout).toBe("");
    const errorPayload = JSON.parse(rerun.stderr) as {
      status: string;
      error: { code: string; message: string; repair: string };
    };
    expect(errorPayload.status).toBe("refused");
    expect(errorPayload.error.code).toBe("worktree_exists_other_head");
    expect(errorPayload.error.message).toContain(worktreePath);
    expect(errorPayload.error.repair).toContain(worktreePath);
    expect(errorPayload.error.repair).toContain(
      `bun run upgrade recover --repository ${repo} --to ${targetCommit.slice(0, 7)}`,
    );
    expect(errorPayload.error.repair).not.toContain("--force");
    expect(existsSync(ownerResolutionFile)).toBe(true);
    expect(readFileSync(ownerResolutionFile, "utf8")).toBe(
      "owner work must survive\n",
    );
    expect(readFileSync(partialPath, "utf8")).toBe(partialContent);
  },
  processWatchdog(4),
);

test(
  "plan and removeWorktreeIfPresent never prune unrelated missing worktree registrations",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "worktree-preserve-app",
    );
    const vanished = join(folder("vanished-worktree-"), "gone");
    git(repo, "worktree", "add", "--quiet", "--detach", vanished, "HEAD");
    rmSync(vanished, { recursive: true, force: true });
    const listBefore = gitOutput(repo, "worktree", "list", "--porcelain");
    expect(listBefore).toContain("prunable");

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const planRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(planRun.exitCode).toBe(0);
    expect(gitOutput(repo, "worktree", "list", "--porcelain")).toBe(listBefore);

    const ownedWorktree = join(repo, ".worktrees", "template-upgrade-tmp");
    git(repo, "worktree", "add", "--quiet", "--detach", ownedWorktree, "HEAD");
    git(
      repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${targetCommit}`,
      ownedWorktree,
    );
    rmSync(ownedWorktree, { recursive: true, force: true });
    await removeTemplateUpgradeWorktree(repo, ownedWorktree, gitEnv);
    expect(gitOutput(repo, "worktree", "list", "--porcelain")).toBe(listBefore);
  },
  processWatchdog(4),
);

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

test("refuses symlink ancestor folders in old, new, or target trees before writing any file", async () => {
  const oldDir = folder("sym-old-");
  const newDir = folder("sym-new-");
  const oursDir = folder("sym-ours-");
  const outside = folder("sym-outside-");
  write(outside, "rules.mjs", "outside-original\n");
  write(oldDir, "AGENTS.md", "old-agents\n");
  write(newDir, "AGENTS.md", "new-agents\n");
  write(oursDir, "AGENTS.md", "old-agents\n");
  write(oldDir, "config/rules.mjs", "old-rules\n");
  write(newDir, "config/rules.mjs", "new-rules\n");
  symlinkSync(outside, join(oursDir, "config"));

  const targetRefusal = await captureAsyncCliError(() =>
    mergeTemplateUpgradeTrees(oldDir, newDir, oursDir),
  );
  expect(targetRefusal.code).toBe("symlink_ancestor");
  expect(targetRefusal.message).toContain('symbolic link ancestor "config"');
  expect(targetRefusal.repair).toContain("config");
  expect(readFileSync(join(outside, "rules.mjs"), "utf8")).toBe(
    "outside-original\n",
  );
  expect(readFileSync(join(oursDir, "AGENTS.md"), "utf8")).toBe("old-agents\n");

  const newTreeOld = folder("sym-new-old-");
  const newTreeNew = folder("sym-new-new-");
  const newTreeOurs = folder("sym-new-ours-");
  const newOutside = folder("sym-new-outside-");
  write(newOutside, "rules.mjs", "from-outside\n");
  write(newTreeOld, "config/rules.mjs", "old-rules\n");
  symlinkSync(newOutside, join(newTreeNew, "config"));
  write(newTreeOurs, "config/rules.mjs", "old-rules\n");
  const newRefusal = await captureAsyncCliError(() =>
    mergeTemplateUpgradeTrees(newTreeOld, newTreeNew, newTreeOurs),
  );
  expect(newRefusal.code).toBe("symlink_ancestor");
  expect(newRefusal.message).toContain('symbolic link ancestor "config"');

  const oldTreeOld = folder("sym-old-old-");
  const oldTreeNew = folder("sym-old-new-");
  const oldTreeOurs = folder("sym-old-ours-");
  const oldOutside = folder("sym-old-outside-");
  write(oldOutside, "rules.mjs", "from-old-outside\n");
  symlinkSync(oldOutside, join(oldTreeOld, "config"));
  write(oldTreeNew, "config/rules.mjs", "new-rules\n");
  write(oldTreeOurs, "config/rules.mjs", "ours-rules\n");
  const oldRefusal = await captureAsyncCliError(() =>
    mergeTemplateUpgradeTrees(oldTreeOld, oldTreeNew, oldTreeOurs),
  );
  expect(oldRefusal.code).toBe("symlink_ancestor");
  expect(oldRefusal.message).toContain('symbolic link ancestor "config"');
});

test(
  "refuses and preserves a non-worktree directory sitting at the target worktree path",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "plain-dir-worktree-app",
    );
    const plainDir = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    mkdirSync(plainDir, { recursive: true });
    writeFileSync(join(plainDir, "keep-me.txt"), "do not delete\n");

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(run.exitCode).toBe(4);
    expect(JSON.parse(run.stderr)).toMatchObject({
      status: "refused",
      error: { code: "worktree_not_owned" },
    });
    expect(readFileSync(join(plainDir, "keep-me.txt"), "utf8")).toBe(
      "do not delete\n",
    );
  },
  processWatchdog(4),
);

async function makePublishedUpgradeRepository(name: string) {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateUpgradeChanges(templateClone);
  const target7 = targetCommit.slice(0, 7);
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${target7}`;
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    name,
  );
  commitIn(repo, "owner baseline commit", { "owner-note.txt": "baseline\n" });
  const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const applyJsonArgs = applyNoCheckJsonArgs(repo, targetCommit);
  const initial = await invokeTemplateUpgradeMain(
    stdout,
    stderr,
    applyJsonArgs,
    runtime,
  );
  expect(initial.exitCode).toBe(0);
  const targetWorktree = join(
    repo,
    ".worktrees",
    `template-upgrade-${target7}`,
  );
  return {
    repo,
    branch,
    targetCommit,
    targetWorktree,
    runtime,
    stdout,
    stderr,
    applyJsonArgs,
  };
}

test(
  "already-done leaves a leftover target worktree at another commit untouched and reports one line explaining why",
  async () => {
    const setup = await makePublishedUpgradeRepository(
      "already-done-other-app",
    );
    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.targetWorktree,
      "HEAD^",
    );
    const ownerFile = join(setup.targetWorktree, "owner-edit.txt");
    writeFileSync(ownerFile, "do not delete\n");

    const jsonRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyJsonArgs,
      setup.runtime,
    );
    expect(jsonRun.exitCode).toBe(0);
    const payload = JSON.parse(jsonRun.stdout) as {
      status: string;
      branch: string;
      worktree?: string;
      leftoverWorktreeNotice?: string;
    };
    expect(payload.status).toBe("already-done");
    expect(payload.branch).toBe(setup.branch);
    expect(payload.worktree).toBe(setup.targetWorktree);
    expect(payload.leftoverWorktreeNotice).toContain(setup.targetWorktree);
    expect(payload.leftoverWorktreeNotice).not.toContain("\n");
    expect(readFileSync(ownerFile, "utf8")).toBe("do not delete\n");

    const textRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      [
        "apply",
        "--repository",
        setup.repo,
        "--to",
        setup.targetCommit,
        "--no-check",
      ],
      setup.runtime,
    );
    expect(textRun.exitCode).toBe(0);
    const textLines = textRun.stdout.trimEnd().split("\n");
    expect(textLines).toHaveLength(5);
    expect(textLines[0]).toBe(
      `Template upgrade: already-done on branch ${setup.branch}`,
    );
    expect(textLines[1]).toBe(`Target commit: ${setup.targetCommit}`);
    expect(textLines[2]).toBe("bun install: skipped (already-done)");
    expect(textLines[3]).toBe("bun run check: skipped (already-done)");
    expect(textLines[4]).toContain(setup.targetWorktree);
    expect(readFileSync(ownerFile, "utf8")).toBe("do not delete\n");
  },
  processWatchdog(4),
);

test(
  "already-done leaves a dirty leftover worktree at the published commit and removes it once clean",
  async () => {
    const setup = await makePublishedUpgradeRepository("already-done-own-app");
    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.targetWorktree,
      setup.branch,
    );
    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${setup.targetCommit}`,
      setup.targetWorktree,
    );
    const ownerFile = join(setup.targetWorktree, "owner-edit.txt");
    writeFileSync(ownerFile, "owner edit on published commit\n");

    const dirtyRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyJsonArgs,
      setup.runtime,
    );
    expect(dirtyRun.exitCode).toBe(0);
    const dirtyPayload = JSON.parse(dirtyRun.stdout) as {
      status: string;
      worktree?: string;
      leftoverWorktreeNotice?: string;
    };
    expect(dirtyPayload.status).toBe("already-done");
    expect(dirtyPayload.worktree).toBe(setup.targetWorktree);
    expect(dirtyPayload.leftoverWorktreeNotice).toContain("uncommitted");
    expect(readFileSync(ownerFile, "utf8")).toBe(
      "owner edit on published commit\n",
    );

    rmSync(ownerFile);
    const cleanRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyJsonArgs,
      setup.runtime,
    );
    expect(cleanRun.exitCode).toBe(0);
    const cleanPayload = JSON.parse(cleanRun.stdout) as {
      status: string;
      worktree?: string;
      leftoverWorktreeNotice?: string;
    };
    expect(cleanPayload.status).toBe("already-done");
    expect(cleanPayload.worktree).toBeUndefined();
    expect(cleanPayload.leftoverWorktreeNotice).toBeUndefined();
    expect(existsSync(setup.targetWorktree)).toBe(false);
  },
  processWatchdog(4),
);
