import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import {
  assertWorktreePathAvailableForTemplateUpgrade,
  createLockedTemplateUpgradeWorktree,
  findGitWorktreeRecord,
  isTemplateUpgradeLockedWorktree,
  listGitWorktrees,
  moveLockedTemplateUpgradeWorktree,
  removeTemplateUpgradeWorktree,
  TEMPLATE_UPGRADE_LOCK_PREFIX,
  templateUpgradeLockReason,
} from "../../../src/template-upgrade-worktree-lock.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  initRepository,
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

interface RefusalPayload {
  readonly status: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly repair: string;
  };
}

async function makeCleanUpgradeFixture(name: string) {
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
  const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const applyArgs = applyNoCheckJsonArgs(repo, targetCommit);
  const temporaryWorktree = join(repo, ".worktrees", "template-upgrade-tmp");
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
    branch,
    repo,
    runtime,
    stdout,
    stderr,
    applyArgs,
    temporaryWorktree,
    targetWorktree,
  };
}

function parseRefusal(stderr: string): RefusalPayload {
  return JSON.parse(stderr) as RefusalPayload;
}

test(
  "refuses and preserves an unlocked owner worktree at the temporary worktree path",
  async () => {
    const setup = await makeCleanUpgradeFixture("owner-tmp-worktree-app");
    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.temporaryWorktree,
      "HEAD",
    );
    const trackedReadme = join(setup.temporaryWorktree, "README.md");
    const editedReadme = `${readFileSync(trackedReadme, "utf8")}\nowner tmp edit\n`;
    writeFileSync(trackedReadme, editedReadme);
    const ownerNotes = join(setup.temporaryWorktree, "owner-notes.txt");
    writeFileSync(ownerNotes, "owner private notes\n");

    const run = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(run.exitCode).toBe(4);
    expect(run.stdout).toBe("");
    const payload = parseRefusal(run.stderr);
    expect(payload.status).toBe("refused");
    expect(payload.error.code).toBe("worktree_not_owned");
    expect(payload.error.message).toContain(setup.temporaryWorktree);
    expect(payload.error.repair).toContain(setup.temporaryWorktree);
    expect(existsSync(setup.temporaryWorktree)).toBe(true);
    expect(readFileSync(trackedReadme, "utf8")).toBe(editedReadme);
    expect(readFileSync(ownerNotes, "utf8")).toBe("owner private notes\n");
    expect(git(setup.repo, "branch", "--list", setup.branch)).toBe("");
  },
  processWatchdog(4),
);

test(
  "refuses and preserves a worktree locked for another reason, a plain folder, or a plain file at the temporary path",
  async () => {
    const setup = await makeCleanUpgradeFixture("other-lock-tmp-app");
    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.temporaryWorktree,
      "HEAD",
    );
    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      "owner wip lock",
      setup.temporaryWorktree,
    );
    const note = join(setup.temporaryWorktree, "keep.txt");
    writeFileSync(note, "locked by owner\n");

    const lockedRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(lockedRun.exitCode).toBe(4);
    expect(lockedRun.stdout).toBe("");
    const lockedPayload = parseRefusal(lockedRun.stderr);
    expect(lockedPayload.status).toBe("refused");
    expect(lockedPayload.error.code).toBe("worktree_not_owned");
    expect(lockedPayload.error.message).toContain(setup.temporaryWorktree);
    expect(lockedPayload.error.repair).toContain("git worktree unlock");
    expect(readFileSync(note, "utf8")).toBe("locked by owner\n");

    git(setup.repo, "worktree", "unlock", setup.temporaryWorktree);
    git(setup.repo, "worktree", "remove", "--force", setup.temporaryWorktree);

    mkdirSync(setup.temporaryWorktree, { recursive: true });
    writeFileSync(join(setup.temporaryWorktree, "folder-note.txt"), "keep\n");
    const folderRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(folderRun.exitCode).toBe(4);
    const folderPayload = parseRefusal(folderRun.stderr);
    expect(folderPayload.error.code).toBe("worktree_not_owned");
    expect(folderPayload.error.message).toContain(setup.temporaryWorktree);
    expect(folderPayload.error.repair).toContain(setup.temporaryWorktree);
    expect(
      readFileSync(join(setup.temporaryWorktree, "folder-note.txt"), "utf8"),
    ).toBe("keep\n");

    const fileSetup = await makeCleanUpgradeFixture("plain-file-tmp-app");
    mkdirSync(join(fileSetup.repo, ".worktrees"), { recursive: true });
    writeFileSync(fileSetup.temporaryWorktree, "plain file content\n");
    const fileRun = await invokeTemplateUpgradeMain(
      fileSetup.stdout,
      fileSetup.stderr,
      fileSetup.applyArgs,
      fileSetup.runtime,
    );
    expect(fileRun.exitCode).toBe(4);
    const filePayload = parseRefusal(fileRun.stderr);
    expect(filePayload.error.code).toBe("worktree_not_owned");
    expect(filePayload.error.message).toContain(fileSetup.temporaryWorktree);
    expect(filePayload.error.repair).toContain(fileSetup.temporaryWorktree);
    expect(readFileSync(fileSetup.temporaryWorktree, "utf8")).toBe(
      "plain file content\n",
    );
  },
  processWatchdog(4),
);

test(
  "refuses and preserves an unlocked or foreign-locked owner worktree at the target worktree path",
  async () => {
    const setup = await makeCleanUpgradeFixture("owner-target-worktree-app");
    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.targetWorktree,
      "HEAD",
    );
    const ownerNotes = join(setup.targetWorktree, "owner-target.txt");
    writeFileSync(ownerNotes, "owner work at target path\n");

    const unlockedRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(unlockedRun.exitCode).toBe(4);
    expect(unlockedRun.stdout).toBe("");
    const unlockedPayload = parseRefusal(unlockedRun.stderr);
    expect(unlockedPayload.status).toBe("refused");
    expect(unlockedPayload.error.code).toBe("worktree_not_owned");
    expect(unlockedPayload.error.message).toContain(setup.targetWorktree);
    expect(unlockedPayload.error.repair).toContain(setup.targetWorktree);
    expect(existsSync(setup.targetWorktree)).toBe(true);
    expect(readFileSync(ownerNotes, "utf8")).toBe(
      "owner work at target path\n",
    );
    expect(git(setup.repo, "branch", "--list", setup.branch)).toBe("");

    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      "manual backup",
      setup.targetWorktree,
    );
    const foreignLockRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(foreignLockRun.exitCode).toBe(4);
    const foreignPayload = parseRefusal(foreignLockRun.stderr);
    expect(foreignPayload.error.code).toBe("worktree_not_owned");
    expect(foreignPayload.error.message).toContain(setup.targetWorktree);
    expect(foreignPayload.error.repair).toContain("git worktree unlock");
    expect(readFileSync(ownerNotes, "utf8")).toBe(
      "owner work at target path\n",
    );
  },
  processWatchdog(4),
);

test(
  "locks worktrees it creates through move and replaces leftovers locked by template-upgrade",
  async () => {
    const setup = await makeCleanUpgradeFixture("locked-leftover-app");
    const addOnLines = readFileSync(
      join(setup.repo, "tests/add-on-start-up.test.ts"),
      "utf8",
    ).split("\n");
    const describeIndex = addOnLines.findIndex((line) =>
      line.includes("describe("),
    );
    const editIndex = describeIndex >= 0 ? describeIndex : 0;
    addOnLines[editIndex] = (addOnLines[editIndex] ?? "").replace(
      '"',
      '"owner-lock-test ',
    );
    commitIn(setup.repo, "owner conflict edit", {
      "tests/add-on-start-up.test.ts": addOnLines.join("\n"),
    });

    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.temporaryWorktree,
      "HEAD",
    );
    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${setup.targetCommit}`,
      setup.temporaryWorktree,
    );
    writeFileSync(
      join(setup.temporaryWorktree, "stale-tmp.txt"),
      "interrupted temporary run\n",
    );

    const conflictRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(conflictRun.exitCode).toBe(2);
    expect(existsSync(setup.temporaryWorktree)).toBe(false);
    expect(existsSync(setup.targetWorktree)).toBe(true);
    const porcelain = gitOutput(setup.repo, "worktree", "list", "--porcelain");
    expect(porcelain).toContain(`worktree ${setup.targetWorktree}`);
    expect(porcelain).toContain(
      `locked template-upgrade ${setup.targetCommit}`,
    );

    const rerunUnchanged = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(rerunUnchanged.exitCode).toBe(2);
    const porcelainAfterRerun = gitOutput(
      setup.repo,
      "worktree",
      "list",
      "--porcelain",
    );
    expect(porcelainAfterRerun).toContain(
      `locked template-upgrade ${setup.targetCommit}`,
    );

    writeFileSync(
      join(setup.targetWorktree, "tests/add-on-start-up.test.ts"),
      addOnLines.join("\n"),
    );
    const resolvedRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(resolvedRun.exitCode).toBe(0);
    expect(JSON.parse(resolvedRun.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    expect(existsSync(setup.targetWorktree)).toBe(false);
    expect(worktrees(setup.repo)).toHaveLength(1);
  },
  processWatchdog(4),
);

test(
  "converges cleanly on rerun when a previous run stopped mid-way leaving a locked temporary worktree",
  async () => {
    const setup = await makeCleanUpgradeFixture("midway-converge-app");
    const refRepo = await bootstrapGeneratedRepository(
      folder,
      setup.templateClone,
      setup.baseCommit,
      "midway-converge-app",
    );
    const refRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      applyNoCheckJsonArgs(refRepo, setup.targetCommit),
      setup.runtime,
    );
    expect(refRun.exitCode).toBe(0);
    const expectedTree = git(refRepo, "rev-parse", `${setup.branch}^{tree}`);

    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.temporaryWorktree,
      "HEAD",
    );
    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${setup.targetCommit}`,
      setup.temporaryWorktree,
    );
    writeFileSync(
      join(setup.temporaryWorktree, "partial-merge.txt"),
      "stopped mid-way\n",
    );

    const converged = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(converged.exitCode).toBe(0);
    expect(JSON.parse(converged.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    expect(git(setup.repo, "rev-parse", `${setup.branch}^{tree}`)).toBe(
      expectedTree,
    );
    expect(existsSync(setup.temporaryWorktree)).toBe(false);
    expect(existsSync(setup.targetWorktree)).toBe(false);
    expect(worktrees(setup.repo)).toHaveLength(1);
  },
  processWatchdog(4),
);

test(
  "already-done never removes a clean unlocked owner worktree at the target or temporary path",
  async () => {
    const setup = await makeCleanUpgradeFixture("already-done-unlocked-app");
    const first = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(first.exitCode).toBe(0);

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
      "add",
      "--quiet",
      "--detach",
      setup.temporaryWorktree,
      "HEAD",
    );

    const rerun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      setup.applyArgs,
      setup.runtime,
    );
    expect(rerun.exitCode).toBe(0);
    const payload = JSON.parse(rerun.stdout) as {
      status: string;
      worktree?: string;
      leftoverWorktreeNotice?: string;
    };
    expect(payload.status).toBe("already-done");
    expect(payload.worktree).toBe(setup.targetWorktree);
    expect(payload.leftoverWorktreeNotice).toContain("not locked");
    expect(payload.leftoverWorktreeNotice).not.toContain("\n");
    expect(existsSync(setup.targetWorktree)).toBe(true);
    expect(existsSync(setup.temporaryWorktree)).toBe(true);
  },
  processWatchdog(4),
);

async function captureCliRefusal(
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
  throw new Error("Expected a CliError refusal.");
}

test("worktree lock helpers require a template-upgrade lock prefix and preserve lock through move", async () => {
  const repo = folder("wt-lock-unit-");
  initRepository(repo);
  const { sha } = commitIn(repo, "init", { "README.md": "hello\n" });
  const targetCommit = "0123456789abcdef0123456789abcdef01234567";
  expect(TEMPLATE_UPGRADE_LOCK_PREFIX).toBe("template-upgrade ");
  expect(templateUpgradeLockReason(targetCommit)).toBe(
    `template-upgrade ${targetCommit}`,
  );

  const sourcePath = join(repo, ".worktrees", "template-upgrade-tmp");
  const targetPath = join(repo, ".worktrees", "template-upgrade-0123456");
  await createLockedTemplateUpgradeWorktree({
    repository: repo,
    worktreePath: sourcePath,
    commit: sha,
    targetCommit,
    env: gitEnv,
  });
  const createdRecord = findGitWorktreeRecord(repo, sourcePath, gitEnv);
  expect(createdRecord).toBeDefined();
  expect(
    createdRecord !== undefined &&
      isTemplateUpgradeLockedWorktree(createdRecord),
  ).toBe(true);
  expect(createdRecord?.lockReason).toBe(`template-upgrade ${targetCommit}`);
  expect(
    listGitWorktrees(repo, gitEnv).some(
      (entry) => entry.lockReason === `template-upgrade ${targetCommit}`,
    ),
  ).toBe(true);

  await moveLockedTemplateUpgradeWorktree({
    repository: repo,
    sourceWorktree: sourcePath,
    targetWorktree: targetPath,
    env: gitEnv,
  });
  const movedRecord = findGitWorktreeRecord(repo, targetPath, gitEnv);
  expect(movedRecord).toBeDefined();
  expect(
    movedRecord !== undefined && isTemplateUpgradeLockedWorktree(movedRecord),
  ).toBe(true);
  expect(movedRecord?.lockReason).toBe(`template-upgrade ${targetCommit}`);
  await removeTemplateUpgradeWorktree(repo, targetPath, gitEnv);
  expect(existsSync(targetPath)).toBe(false);

  const noReasonPath = join(repo, ".worktrees", "template-upgrade-tmp");
  git(repo, "worktree", "add", "--quiet", "--detach", noReasonPath, sha);
  git(repo, "worktree", "lock", noReasonPath);
  const noReasonRefusal = await captureCliRefusal(() =>
    removeTemplateUpgradeWorktree(repo, noReasonPath, gitEnv),
  );
  expect(noReasonRefusal.code).toBe("worktree_not_owned");
  expect(noReasonRefusal.message).toContain(noReasonPath);
  expect(noReasonRefusal.repair).toContain("git worktree unlock");
  expect(existsSync(noReasonPath)).toBe(true);

  git(repo, "worktree", "unlock", noReasonPath);
  git(
    repo,
    "worktree",
    "lock",
    "--reason",
    "template-upgrade-wrong-prefix",
    noReasonPath,
  );
  const wrongPrefixRefusal = await captureCliRefusal(() =>
    assertWorktreePathAvailableForTemplateUpgrade(repo, noReasonPath, gitEnv),
  );
  expect(wrongPrefixRefusal.code).toBe("worktree_not_owned");
  expect(wrongPrefixRefusal.message).toContain("template-upgrade-wrong-prefix");
  expect(existsSync(noReasonPath)).toBe(true);

  git(repo, "worktree", "unlock", noReasonPath);
  rmSync(noReasonPath, { recursive: true, force: true });
  const prunableRefusal = await captureCliRefusal(() =>
    removeTemplateUpgradeWorktree(repo, noReasonPath, gitEnv),
  );
  expect(prunableRefusal.code).toBe("worktree_not_owned");
  expect(findGitWorktreeRecord(repo, noReasonPath, gitEnv)).toBeDefined();
});
