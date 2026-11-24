import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import { templateUpgradeRecover } from "../../../src/template-upgrade-recover.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitOutput } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";
import {
  createFailedApplyWorktree,
  parseRecover,
  parseRefusal,
  recoverDiff,
  recoverJsonArgs,
  writeCustomGit,
  writeScriptedGit,
} from "../../support/template-upgrade-recover-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

async function assertRecoverStepFailure(options: {
  readonly appName: string;
  readonly gitPrefix: string;
  readonly failCondition: string;
  readonly errorMessage: string;
  readonly expectedCode: string;
  readonly expectPatchBeforeRetry: boolean;
}): Promise<void> {
  const setup = await createFailedApplyWorktree(
    folder,
    captureStream,
    options.appName,
  );
  const failingGit = writeScriptedGit(
    folder,
    options.gitPrefix,
    options.failCondition,
    options.errorMessage,
  );
  const failRun = await setup.runRecover(failingGit.env);
  expect(failRun.exitCode).toBe(1);
  const savedCommit = git(setup.repo, "rev-parse", setup.branch1);
  const failErr = parseRefusal(failRun.stderr).error;
  expect(failErr.code).toBe(options.expectedCode);
  expect(failErr.message).toContain(setup.branch1);
  expect(failErr.message).toContain(savedCommit.slice(0, 7));
  if (options.expectPatchBeforeRetry) {
    expect(failErr.message).toContain(setup.patch1);
  }
  expect(failErr.repair).not.toBe("");
  expect(existsSync(setup.targetWorktree)).toBe(true);
  expect(existsSync(setup.patch1)).toBe(options.expectPatchBeforeRetry);
  expect(gitOutput(setup.repo, "worktree", "list", "--porcelain")).toContain(
    `locked template-upgrade ${setup.targetCommit}`,
  );

  const retryRun = await setup.runRecover();
  expect(retryRun.exitCode).toBe(0);
  const retryPayload = parseRecover(retryRun.stdout);
  expect(retryPayload.branch).toBe(setup.branch1);
  expect(retryPayload.patchPath).toBe(setup.patch1);
  expect(retryPayload.commit).toBe(savedCommit);
  expect(git(setup.repo, "rev-parse", setup.branch1)).toBe(savedCommit);
  expect(existsSync(setup.targetWorktree)).toBe(false);
  expect(readFileSync(setup.patch1, "utf8")).toBe(
    recoverDiff(setup.repo, `${setup.branch1}^`, setup.branch1),
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
      code: string,
      message: string,
      exitCode = 4,
      retrySafe?: boolean,
    ) => {
      const run = await invokeTemplateUpgradeMain(
        stdout,
        stderr,
        recoverArgs,
        runtime,
      );
      expect(run.exitCode).toBe(exitCode);
      const payload = parseRefusal(run.stderr);
      expect(payload.status).toBe("refused");
      expect(payload.error.code).toBe(code);
      if (retrySafe !== undefined) {
        expect(payload.error.retrySafe).toBe(retrySafe);
      }
      expect(payload.error.message).toContain(message);
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

    symlinkSync(folder("recover-symlink-target-"), targetWorktree);
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

test(
  "keeps saved branch, commit, and patch in worktree_unlock_failed on unlock timeout",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-unlock-timeout-app",
    );
    const hangingUnlockGit = writeCustomGit(
      folder,
      "git-unlock-hang-",
      (realGit, ledger) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(ledger)}
if printf "%s" "$*" | grep -q "worktree unlock"; then
  exec sleep 15
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    let caught: CliError | undefined;
    try {
      await templateUpgradeRecover({
        templateRoot: setup.templateClone,
        repository: setup.repo,
        targetRef: setup.targetCommit,
        env: hangingUnlockGit.env,
        timeoutMilliseconds: 250,
      });
    } catch (error) {
      if (error instanceof CliError) {
        caught = error;
      } else {
        throw error;
      }
    }
    const savedCommit = git(setup.repo, "rev-parse", setup.branch1);
    expect(caught?.code).toBe("worktree_unlock_failed");
    expect(caught?.message).toContain(setup.branch1);
    expect(caught?.message).toContain(savedCommit.slice(0, 7));
    expect(caught?.message).toContain(setup.patch1);
    expect(caught?.message).toContain("did not finish within 250 ms");
  },
  processWatchdog(6),
);
