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
