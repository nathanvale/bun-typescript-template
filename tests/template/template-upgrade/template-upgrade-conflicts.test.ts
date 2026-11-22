import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
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
