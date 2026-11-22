import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCommittedBytesAt } from "../../../src/template-upgrade-git.ts";
import {
  isTemplateUpgradeConflict,
  mergeTemplateUpgradeTrees,
} from "../../../src/template-upgrade-merge.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  gitResult,
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

async function makeTemplateDeletedConflictRepo() {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateUpgradeChanges(templateClone);
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "delete-conflict-keep-app",
  );
  const ownerContent = `${readFileSync(join(repo, "tests/pointer-skills.test.ts"), "utf8")}\nexport const ownerKept = true;\n`;
  commitIn(repo, "owner edits file template will delete", {
    "tests/pointer-skills.test.ts": ownerContent,
  });
  return { templateClone, targetCommit, branch, repo, ownerContent };
}

async function makeOwnerDeletedConflictRepo() {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateUpgradeChanges(templateClone);
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "owner-deleted-conflict-app",
  );
  git(repo, "rm", "--quiet", "--", "tests/add-on-start-up.test.ts");
  git(repo, "commit", "--quiet", "-m", "owner removes add-on test");
  const templateContent = gitOutput(
    templateClone,
    "show",
    `${targetCommit}:generated-repository/application/tests/add-on-start-up.test.ts`,
  );
  return { templateClone, targetCommit, branch, repo, templateContent };
}

test(
  "conflict-delete where template deleted an owner-edited file resolves by removing markers to keep it",
  async () => {
    const setup = await makeTemplateDeletedConflictRepo();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(2);
    const payload = JSON.parse(first.stdout) as {
      status: string;
      conflicts: string[];
      worktree: string;
    };
    expect(payload.status).toBe("conflicts");
    expect(payload.conflicts).toEqual(["tests/pointer-skills.test.ts"]);
    const conflictFile = join(payload.worktree, "tests/pointer-skills.test.ts");
    const markedText = readFileSync(conflictFile, "utf8");
    expect(markedText).toContain("<<<<<<< ours\n");
    expect(markedText).toContain("export const ownerKept = true;");
    expect(markedText).toContain(
      "=======\n>>>>>>> new (deleted by template)\n",
    );

    const unchanged = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(unchanged.exitCode).toBe(2);
    expect(
      readFileSync(conflictFile, "utf8").match(/^<<<<<<< ours$/gm)?.length,
    ).toBe(1);

    writeFileSync(conflictFile, setup.ownerContent);
    const kept = await invokeTemplateUpgradeMain(stdout, stderr, args, runtime);
    expect(kept.exitCode).toBe(0);
    expect(JSON.parse(kept.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    expect(
      gitOutput(
        setup.repo,
        "show",
        `${setup.branch}:tests/pointer-skills.test.ts`,
      ),
    ).toBe(setup.ownerContent);
  },
  processWatchdog(4),
);

test(
  "conflict-delete where template deleted an owner-edited file resolves by deleting the file",
  async () => {
    const setup = await makeTemplateDeletedConflictRepo();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(2);
    const worktree = (JSON.parse(first.stdout) as { worktree: string })
      .worktree;
    rmSync(join(worktree, "tests/pointer-skills.test.ts"));
    const deleted = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(deleted.exitCode).toBe(0);
    expect(JSON.parse(deleted.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    const branchFiles = git(
      setup.repo,
      "ls-tree",
      "-r",
      "--name-only",
      setup.branch,
    ).split("\n");
    expect(branchFiles).not.toContain("tests/pointer-skills.test.ts");
  },
  processWatchdog(4),
);

test(
  "conflict-delete where owner deleted a template-changed file resolves by taking the template file",
  async () => {
    const setup = await makeOwnerDeletedConflictRepo();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(2);
    const payload = JSON.parse(first.stdout) as {
      status: string;
      conflicts: string[];
      worktree: string;
    };
    expect(payload.status).toBe("conflicts");
    expect(payload.conflicts).toEqual(["tests/add-on-start-up.test.ts"]);
    const conflictFile = join(
      payload.worktree,
      "tests/add-on-start-up.test.ts",
    );
    expect(existsSync(conflictFile)).toBe(true);
    const markedText = readFileSync(conflictFile, "utf8");
    expect(markedText).toContain("<<<<<<< ours (deleted by owner)\n=======\n");
    expect(markedText).toContain("template-edited");
    expect(markedText).toContain("\n>>>>>>> new\n");

    writeFileSync(conflictFile, `${markedText}\n`);
    const inProgress = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(inProgress.exitCode).toBe(5);
    expect(JSON.parse(inProgress.stdout)).toMatchObject({
      status: "resolution-in-progress",
      conflicts: ["tests/add-on-start-up.test.ts"],
    });

    writeFileSync(conflictFile, setup.templateContent);
    const taken = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(taken.exitCode).toBe(0);
    expect(JSON.parse(taken.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    expect(
      gitOutput(
        setup.repo,
        "show",
        `${setup.branch}:tests/add-on-start-up.test.ts`,
      ),
    ).toBe(setup.templateContent);
  },
  processWatchdog(4),
);

test(
  "conflict-delete where owner deleted a template-changed file resolves by deleting the file",
  async () => {
    const setup = await makeOwnerDeletedConflictRepo();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(2);
    const worktree = (JSON.parse(first.stdout) as { worktree: string })
      .worktree;
    rmSync(join(worktree, "tests/add-on-start-up.test.ts"));
    const dropped = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(dropped.exitCode).toBe(0);
    expect(JSON.parse(dropped.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    const branchFiles = git(
      setup.repo,
      "ls-tree",
      "-r",
      "--name-only",
      setup.branch,
    ).split("\n");
    expect(branchFiles).not.toContain("tests/add-on-start-up.test.ts");
  },
  processWatchdog(4),
);

test(
  "conflict-delete resolved with git rm succeeds on rerun without failing to stage the deletion",
  async () => {
    const setup = await makeTemplateDeletedConflictRepo();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(2);
    const worktree = (JSON.parse(first.stdout) as { worktree: string })
      .worktree;
    git(
      worktree,
      "rm",
      "--force",
      "--quiet",
      "--",
      "tests/pointer-skills.test.ts",
    );

    const resolved = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(resolved.exitCode).toBe(0);
    expect(resolved.stderr).toBe("");
    expect(JSON.parse(resolved.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    const branchFiles = git(
      setup.repo,
      "ls-tree",
      "-r",
      "--name-only",
      setup.branch,
    ).split("\n");
    expect(branchFiles).not.toContain("tests/pointer-skills.test.ts");
  },
  processWatchdog(4),
);

test(
  "staging treats files named like git pathspecs such as :(glob)README* literally",
  async () => {
    const setup = await makeTemplateDeletedConflictRepo();
    const deletedMagic = ":(glob)README*";
    const addedMagic = ":(glob)package*";
    const originalReadme = readFileSync(join(setup.repo, "README.md"), "utf8");
    writeFileSync(join(setup.repo, deletedMagic), "owner literal file\n");
    git(setup.repo, "--literal-pathspecs", "add", "--", deletedMagic);
    git(setup.repo, "commit", "--quiet", "-m", "add pathspec-shaped file");

    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(2);
    const worktree = (JSON.parse(first.stdout) as { worktree: string })
      .worktree;
    writeFileSync(
      join(worktree, "tests/pointer-skills.test.ts"),
      setup.ownerContent,
    );
    rmSync(join(worktree, deletedMagic));
    writeFileSync(join(worktree, addedMagic), "added literal file\n");

    const applied = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(applied.exitCode).toBe(0);
    expect(applied.stderr).toBe("");
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
    });
    expect(gitOutput(setup.repo, "show", `${setup.branch}:README.md`)).toBe(
      originalReadme,
    );
    expect(
      gitResult(setup.repo, "cat-file", "-e", `${setup.branch}:${deletedMagic}`)
        .exitCode,
    ).not.toBe(0);
    expect(gitOutput(setup.repo, "show", `${setup.branch}:${addedMagic}`)).toBe(
      "added literal file\n",
    );
  },
  processWatchdog(4),
);

async function makeBinaryDeletedConflictRepo() {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateUpgradeChanges(templateClone);
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "binary-delete-app",
  );
  const ownerBytes = new Uint8Array(Buffer.from("owner\0binary\n"));
  writeFileSync(join(repo, "tests/pointer-skills.test.ts"), ownerBytes);
  git(repo, "add", "--", "tests/pointer-skills.test.ts");
  git(repo, "commit", "--quiet", "-m", "owner binary edit");
  return { templateClone, targetCommit, branch, repo, ownerBytes };
}

test(
  "delete-versus-change on a file containing a NUL byte keeps the owner's file as template-copy-changed without looping on conflicts",
  async () => {
    const setup = await makeBinaryDeletedConflictRepo();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "plan",
        "--repository",
        setup.repo,
        "--to",
        setup.targetCommit,
        "--json",
      ],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planPayload = JSON.parse(planJsonRun.stdout) as {
      status: string;
      conflicts: string[];
      rows: { path: string; outcome: string; reason?: string }[];
    };
    expect(planPayload.status).toBe("planned");
    expect(planPayload.conflicts).toEqual([]);
    const binaryRow = planPayload.rows.find(
      (row) => row.path === "tests/pointer-skills.test.ts",
    );
    expect(binaryRow?.outcome).toBe("template-copy-changed");
    expect(binaryRow?.reason).toContain("conflict markers");

    const planTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", setup.repo, "--to", setup.targetCommit],
      runtime,
    );
    expect(planTextRun.exitCode).toBe(0);
    expect(planTextRun.stdout).toContain(binaryRow?.reason ?? "missing");

    const applyArgs = applyNoCheckJsonArgs(setup.repo, setup.targetCommit);
    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(applyRun.exitCode).toBe(0);
    expect(JSON.parse(applyRun.stdout)).toMatchObject({
      status: "applied",
      branch: setup.branch,
      conflicts: [],
    });
    expect(
      readCommittedBytesAt(
        setup.repo,
        setup.branch,
        "tests/pointer-skills.test.ts",
        gitEnv,
      ),
    ).toEqual(setup.ownerBytes);

    const rerun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(rerun.exitCode).toBe(0);
    expect(JSON.parse(rerun.stdout)).toMatchObject({ status: "already-done" });
  },
  processWatchdog(4),
);

test("mergeTemplateUpgradeTrees reports delete-versus-change on NUL files in both directions as template-copy-changed with a reason", async () => {
  const oldDir = folder("nul-del-old-");
  const newDir = folder("nul-del-new-");
  const oursDir = folder("nul-del-ours-");
  const oursBytes = new Uint8Array([0x6f, 0x77, 0x6e, 0x00, 0x0a]);
  const newBytes = new Uint8Array([0x6e, 0x65, 0x77, 0x00, 0x0a]);
  write(oldDir, "deleted-in-new.bin", "base\n");
  writeFileSync(join(oursDir, "deleted-in-new.bin"), oursBytes);
  write(oldDir, "deleted-in-ours.bin", "base\n");
  writeFileSync(join(newDir, "deleted-in-ours.bin"), newBytes);

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toHaveLength(2);
  for (const row of rows) {
    expect(row.outcome).toBe("template-copy-changed");
    expect(isTemplateUpgradeConflict(row.outcome)).toBe(false);
    expect(row.reason).toContain("conflict markers");
  }
  expect(
    new Uint8Array(readFileSync(join(oursDir, "deleted-in-new.bin"))),
  ).toEqual(oursBytes);
  expect(existsSync(join(oursDir, "deleted-in-ours.bin"))).toBe(false);
});
