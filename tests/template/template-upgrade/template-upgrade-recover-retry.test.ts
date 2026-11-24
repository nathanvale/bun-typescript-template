import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitOutput } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  createFailedApplyWorktree,
  parseRecover,
  parseRefusal,
  recoverDiff,
  writeCustomGit,
  writeScriptedGit,
} from "../../support/template-upgrade-recover-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

test(
  "reuses the existing recovery commit and original parent after a failed branch creation",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-branch-fail-app",
    );
    writeFileSync(
      join(setup.targetWorktree, "branch-retry-note.txt"),
      "must stay in patch\n",
    );
    const parentHead = git(setup.targetWorktree, "rev-parse", "HEAD");
    const failingBranchGit = writeScriptedGit(
      folder,
      "git-branch-fail-",
      `printf "%s" "$*" | grep -q " branch ${setup.branch1}"`,
      "simulated branch create failure",
    );
    const failRun = await setup.runRecover(failingBranchGit.env);
    expect(failRun.exitCode).toBe(1);
    expect(parseRefusal(failRun.stderr).error.code).toBe(
      "branch_create_failed",
    );
    const savedCommit = git(setup.targetWorktree, "rev-parse", "HEAD");
    expect(savedCommit).not.toBe(parentHead);
    expect(git(setup.repo, "branch", "--list", setup.branch1)).toBe("");

    const retryRun = await setup.runRecover();
    expect(retryRun.exitCode).toBe(0);
    const retryPayload = parseRecover(retryRun.stdout);
    expect(retryPayload.branch).toBe(setup.branch1);
    expect(retryPayload.commit).toBe(savedCommit);
    expect(retryPayload.patchPath).toBe(setup.patch1);
    expect(git(setup.repo, "rev-parse", setup.branch1)).toBe(savedCommit);
    expect(git(setup.repo, "rev-parse", `${savedCommit}^`)).toBe(parentHead);
    const patchText = readFileSync(setup.patch1, "utf8");
    expect(patchText).toContain("must stay in patch");
    expect(patchText).toBe(recoverDiff(setup.repo, parentHead, savedCommit));
    expect(existsSync(setup.targetWorktree)).toBe(false);
    expect(
      git(
        setup.repo,
        "branch",
        "--list",
        `template-upgrade/${setup.target7}-failed-2`,
      ),
    ).toBe("");
  },
  processWatchdog(6),
);

test(
  "refuses a mismatched or partial existing recovery patch file on retry and keeps the worktree",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-patch-mismatch-app",
    );
    const failUnlockGit = writeScriptedGit(
      folder,
      "git-unlock-mismatch-",
      'printf "%s" "$*" | grep -q "worktree unlock"',
      "simulated unlock refusal",
    );
    expect((await setup.runRecover(failUnlockGit.env)).exitCode).toBe(1);
    const savedCommit = git(setup.repo, "rev-parse", setup.branch1);
    const fullPatch = readFileSync(setup.patch1);
    expect(fullPatch.length).toBeGreaterThan(20);

    writeFileSync(setup.patch1, fullPatch.subarray(0, 10));
    const mismatchRun = await setup.runRecover();
    expect(mismatchRun.exitCode).toBe(1);
    const mismatchErr = parseRefusal(mismatchRun.stderr).error;
    expect(mismatchErr.code).toBe("worktree_patch_failed");
    expect(mismatchErr.message).toContain("does not match");
    expect(mismatchErr.message).toContain(setup.branch1);
    expect(mismatchErr.message).toContain(savedCommit.slice(0, 7));
    expect(existsSync(setup.targetWorktree)).toBe(true);
    expect(gitOutput(setup.repo, "worktree", "list", "--porcelain")).toContain(
      `locked template-upgrade ${setup.targetCommit}`,
    );

    rmSync(setup.patch1);
    const cleanRetry = await setup.runRecover();
    expect(cleanRetry.exitCode).toBe(0);
    const retryPayload = parseRecover(cleanRetry.stdout);
    expect(retryPayload.branch).toBe(setup.branch1);
    expect(retryPayload.commit).toBe(savedCommit);
    expect(readFileSync(setup.patch1)).toEqual(fullPatch);
    expect(existsSync(setup.targetWorktree)).toBe(false);
  },
  processWatchdog(6),
);

test(
  "checks worktree removability before deletion and leaves a real partial removal recoverable or reports remaining state",
  async () => {
    const preflight = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-preflight-perm-app",
    );
    const lockedSubdir = join(preflight.targetWorktree, "locked-sub");
    mkdirSync(lockedSubdir, { recursive: true });
    const nestedFile = join(lockedSubdir, "keep.txt");
    writeFileSync(nestedFile, "nested file\n");
    chmodSync(lockedSubdir, 0o555);
    try {
      const blocked = await preflight.runRecover();
      expect(blocked.exitCode).toBe(1);
      const blockedErr = parseRefusal(blocked.stderr).error;
      expect(blockedErr.code).toBe("worktree_remove_failed");
      expect(blockedErr.message).toContain(
        "worktree left locked and untouched",
      );
      expect(existsSync(nestedFile)).toBe(true);
      expect(existsSync(join(preflight.targetWorktree, "package.json"))).toBe(
        true,
      );
      expect(
        gitOutput(preflight.repo, "worktree", "list", "--porcelain"),
      ).toContain(`locked template-upgrade ${preflight.targetCommit}`);

      chmodSync(lockedSubdir, 0o755);
      expect((await preflight.runRecover()).exitCode).toBe(0);
      expect(existsSync(preflight.targetWorktree)).toBe(false);
    } finally {
      if (existsSync(lockedSubdir)) {
        chmodSync(lockedSubdir, 0o755);
      }
    }

    const partial = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-real-partial-app",
    );
    const partialSub = join(partial.targetWorktree, "m-locked");
    mkdirSync(partialSub, { recursive: true });
    writeFileSync(join(partialSub, "blocked.txt"), "blocked\n");
    writeFileSync(join(partial.targetWorktree, "000-early.txt"), "early\n");
    writeFileSync(join(partial.targetWorktree, "zzz-late.txt"), "late\n");
    const realPartialGit = writeCustomGit(
      folder,
      "git-real-partial-",
      (realGit, ledger) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(ledger)}
if printf "%s" "$*" | grep -q "worktree remove"; then
  chmod 555 ${JSON.stringify(partialSub)}
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    try {
      const partialFail = await partial.runRecover(realPartialGit.env);
      expect(partialFail.exitCode).toBe(1);
      const savedCommit = git(partial.repo, "rev-parse", partial.branch1);
      const failErr = parseRefusal(partialFail.stderr).error;
      expect(failErr.code).toBe("worktree_remove_failed");
      expect(failErr.message).toContain(partial.branch1);
      expect(failErr.message).toContain(savedCommit.slice(0, 7));
      expect(failErr.message).toContain("re-registered and re-locked");
      expect(
        gitOutput(partial.targetWorktree, "status", "--porcelain=v1"),
      ).toContain(" D ");
      expect(
        gitOutput(partial.repo, "worktree", "list", "--porcelain"),
      ).toContain(`locked template-upgrade ${partial.targetCommit}`);

      chmodSync(partialSub, 0o755);
      const recovered = await partial.runRecover();
      expect(recovered.exitCode).toBe(0);
      const recoveredPayload = parseRecover(recovered.stdout);
      expect(recoveredPayload.branch).toBe(partial.branch1);
      expect(recoveredPayload.commit).toBe(savedCommit);
      expect(existsSync(partial.targetWorktree)).toBe(false);
    } finally {
      if (existsSync(partialSub)) {
        chmodSync(partialSub, 0o755);
      }
    }

    const unrestorable = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-unrestorable-app",
    );
    const gitDir = git(
      unrestorable.targetWorktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-dir",
    );
    const wipeAndLockGit = writeCustomGit(
      folder,
      "git-wipe-lock-",
      (realGit, ledger) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(ledger)}
if printf "%s" "$*" | grep -q "worktree remove"; then
  rm -rf ${JSON.stringify(gitDir)} ${JSON.stringify(join(unrestorable.targetWorktree, ".git"))}
  chmod 555 ${JSON.stringify(unrestorable.targetWorktree)}
  echo "simulated unrecoverable partial removal" >&2
  exit 1
fi
exec ${JSON.stringify(realGit)} "$@"
`,
    );
    try {
      const failRun = await unrestorable.runRecover(wipeAndLockGit.env);
      expect(failRun.exitCode).toBe(1);
      const failErr = parseRefusal(failRun.stderr).error;
      expect(failErr.code).toBe("worktree_remove_failed");
      expect(failErr.message).toContain("directory present");
      expect(failErr.message).toContain(".git link absent");
      expect(failErr.message).toContain("worktree registration absent");
    } finally {
      if (existsSync(unrestorable.targetWorktree)) {
        chmodSync(unrestorable.targetWorktree, 0o755);
      }
    }
  },
  processWatchdog(6),
);

test(
  "prevents prepare-commit-msg hooks during recovery commit and recognizes prior recovery commits without relying on subject",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-hook-app",
    );
    const hooksDir = folder("recover-prepare-hook-");
    const markerFile = join(hooksDir, "hook-ran.marker");
    writeFileSync(
      join(hooksDir, "prepare-commit-msg"),
      `#!/bin/sh
echo ran > ${JSON.stringify(markerFile)}
echo "mutated by prepare-commit-msg" > "$1"
`,
      { mode: 0o755 },
    );
    git(setup.repo, "config", "core.hooksPath", hooksDir);

    const failUnlockGit = writeScriptedGit(
      folder,
      "git-unlock-hook-",
      'printf "%s" "$*" | grep -q "worktree unlock"',
      "simulated unlock refusal",
    );
    expect((await setup.runRecover(failUnlockGit.env)).exitCode).toBe(1);
    expect(existsSync(markerFile)).toBe(false);
    const firstCommit = git(setup.repo, "rev-parse", setup.branch1);
    expect(git(setup.repo, "log", "-1", "--format=%s", firstCommit)).not.toBe(
      "mutated by prepare-commit-msg",
    );

    git(
      setup.targetWorktree,
      "-c",
      "core.hooksPath=/dev/null",
      "commit",
      "--amend",
      "--no-verify",
      "--quiet",
      "-m",
      "rewritten recovery subject",
    );
    const rewrittenCommit = git(setup.targetWorktree, "rev-parse", "HEAD");
    git(setup.repo, "branch", "-f", setup.branch1, rewrittenCommit);
    const statePath = git(
      setup.targetWorktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "template-upgrade-recover.json",
    );
    const state = JSON.parse(readFileSync(statePath, "utf8")) as {
      commitSha: string;
    };
    state.commitSha = rewrittenCommit;
    writeFileSync(statePath, `${JSON.stringify(state)}\n`);

    const retryRun = await setup.runRecover();
    expect(retryRun.exitCode).toBe(0);
    const retryPayload = parseRecover(retryRun.stdout);
    expect(retryPayload.branch).toBe(setup.branch1);
    expect(retryPayload.commit).toBe(rewrittenCommit);
    expect(git(setup.repo, "rev-parse", setup.branch1)).toBe(rewrittenCommit);
    expect(
      git(
        setup.repo,
        "branch",
        "--list",
        `template-upgrade/${setup.target7}-failed-2`,
      ),
    ).toBe("");
  },
  processWatchdog(6),
);

async function assertRetryMatchesSaved(
  setup: Awaited<ReturnType<typeof createFailedApplyWorktree>>,
  savedCommit: string,
  savedPatch: Uint8Array,
): Promise<void> {
  const retryRun = await setup.runRecover();
  expect(retryRun.exitCode).toBe(0);
  const payload = parseRecover(retryRun.stdout);
  expect(payload.branch).toBe(setup.branch1);
  expect(payload.commit).toBe(savedCommit);
  expect(payload.patchPath).toBe(setup.patch1);
  expect(git(setup.repo, "rev-parse", setup.branch1)).toBe(savedCommit);
  expect(Buffer.compare(readFileSync(setup.patch1), savedPatch)).toBe(0);
  expect(existsSync(setup.targetWorktree)).toBe(false);
  expect(
    git(
      setup.repo,
      "branch",
      "--list",
      `template-upgrade/${setup.target7}-failed-2`,
    ),
  ).toBe("");
}

function readRecoverRecordPath(targetWorktree: string): string {
  return git(
    targetWorktree,
    "rev-parse",
    "--path-format=absolute",
    "--git-path",
    "template-upgrade-recover.json",
  );
}

function writeStopAfterUnlockGit(prefix: string) {
  return writeCustomGit(
    folder,
    prefix,
    (realGit, ledger) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(ledger)}
if printf "%s" "$*" | grep -q "worktree unlock"; then
  ${JSON.stringify(realGit)} "$@"
  echo "interrupted after unlock" >&2
  exit 1
fi
exec ${JSON.stringify(realGit)} "$@"
`,
  );
}

test(
  "resumes recover after patch, after unlock, and after failed removal while pinning branch, commit, and patch",
  async () => {
    const afterPatch = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-after-patch-app",
    );
    const failBeforeUnlock = writeScriptedGit(
      folder,
      "git-stop-after-patch-",
      'printf "%s" "$*" | grep -q "worktree unlock"',
      "interrupted after patch",
    );
    expect((await afterPatch.runRecover(failBeforeUnlock.env)).exitCode).toBe(
      1,
    );
    const patchCommit = git(afterPatch.repo, "rev-parse", afterPatch.branch1);
    const patchBytes = readFileSync(afterPatch.patch1);
    expect(existsSync(afterPatch.targetWorktree)).toBe(true);
    await assertRetryMatchesSaved(afterPatch, patchCommit, patchBytes);

    const afterUnlock = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-after-unlock-app",
    );
    const stopAfterUnlock = writeStopAfterUnlockGit("git-stop-after-unlock-");
    expect((await afterUnlock.runRecover(stopAfterUnlock.env)).exitCode).toBe(
      1,
    );
    const unlockCommit = git(
      afterUnlock.repo,
      "rev-parse",
      afterUnlock.branch1,
    );
    const unlockPatch = readFileSync(afterUnlock.patch1);
    const unlockRecord = JSON.parse(
      readFileSync(readRecoverRecordPath(afterUnlock.targetWorktree), "utf8"),
    ) as { readonly step?: string };
    expect(unlockRecord.step).toBe("unlock");
    expect(
      gitOutput(afterUnlock.repo, "worktree", "list", "--porcelain"),
    ).not.toContain("locked");
    await assertRetryMatchesSaved(afterUnlock, unlockCommit, unlockPatch);

    const afterRemove = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-after-remove-app",
    );
    const failRemove = writeScriptedGit(
      folder,
      "git-fail-remove-",
      'printf "%s" "$*" | grep -q "worktree remove"',
      "interrupted during removal",
    );
    expect((await afterRemove.runRecover(failRemove.env)).exitCode).toBe(1);
    const removeCommit = git(
      afterRemove.repo,
      "rev-parse",
      afterRemove.branch1,
    );
    const removePatch = readFileSync(afterRemove.patch1);
    git(afterRemove.repo, "worktree", "unlock", afterRemove.targetWorktree);
    rmSync(join(afterRemove.targetWorktree, "package.json"));
    const removeRecord = JSON.parse(
      readFileSync(readRecoverRecordPath(afterRemove.targetWorktree), "utf8"),
    ) as { readonly step?: string };
    expect(removeRecord.step).toBe("remove");
    await assertRetryMatchesSaved(afterRemove, removeCommit, removePatch);
  },
  processWatchdog(6),
);

test(
  "refuses an unlocked worktree with worktree_not_owned when its recovery record is pre-unlock or mismatched",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-unlocked-invalid-app",
    );
    const stopAfterUnlock = writeStopAfterUnlockGit(
      "git-stop-unlocked-invalid-",
    );
    expect((await setup.runRecover(stopAfterUnlock.env)).exitCode).toBe(1);
    const recordPath = readRecoverRecordPath(setup.targetWorktree);
    const validRaw = readFileSync(recordPath, "utf8");
    const validRecord = JSON.parse(validRaw) as Record<string, unknown>;
    const validPatch = readFileSync(setup.patch1);
    const savedCommit = git(setup.targetWorktree, "rev-parse", "HEAD");

    const expectNotOwned = async () => {
      const run = await setup.runRecover();
      expect(run.exitCode).toBe(4);
      expect(parseRefusal(run.stderr).error.code).toBe("worktree_not_owned");
      expect(existsSync(setup.targetWorktree)).toBe(true);
    };

    writeFileSync(
      recordPath,
      `${JSON.stringify({ ...validRecord, step: "patch" })}\n`,
    );
    await expectNotOwned();

    writeFileSync(
      recordPath,
      `${JSON.stringify({ ...validRecord, targetCommit: "0".repeat(40) })}\n`,
    );
    await expectNotOwned();

    writeFileSync(recordPath, validRaw);
    writeFileSync(setup.patch1, "tampered patch\n");
    await expectNotOwned();

    writeFileSync(setup.patch1, validPatch);
    git(setup.repo, "branch", "-f", setup.branch1, `${setup.branch1}^`);
    await expectNotOwned();

    git(setup.repo, "branch", "-f", setup.branch1, savedCommit);
    git(setup.targetWorktree, "checkout", "--quiet", "--detach", "HEAD^");
    await expectNotOwned();

    git(setup.targetWorktree, "checkout", "--quiet", "--detach", savedCommit);
    const recovered = await setup.runRecover();
    expect(recovered.exitCode).toBe(0);
    expect(existsSync(setup.targetWorktree)).toBe(false);
  },
  processWatchdog(6),
);
