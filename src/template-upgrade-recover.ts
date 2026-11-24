import { constants } from "node:fs";
import { open, readdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  decodeUtf8Strict,
  lstatIfPresent,
  type ProcessEnvMap,
  resolveTemplateCommit,
  runGitCommand,
  runGitText,
  verifyGitRepository,
} from "./template-upgrade-git.ts";
import {
  createTemplateUpgradeRecoverResult,
  type TemplateUpgradeRecoverResult,
} from "./template-upgrade-report.ts";
import {
  assertWorktreePathAvailableForTemplateUpgrade,
  type GitWorktreeRecord,
  isRepositoryWorktree,
} from "./template-upgrade-worktree-lock.ts";
import {
  assertNotSymlinkPath,
  readGitOutput,
  readWorktreeOwnHead,
  resolveRefIfPresent,
  stageAndCommitWorktree,
  templateUpgradeWorktreePaths,
} from "./template-upgrade-worktree.ts";

const WORKTREE_TIMEOUT_MS = 30_000;
const POSITIVE_INDEX_PATTERN = /^[1-9]\d*$/;
const RECOVER_BRANCH_PREFIX = "template-upgrade/";
const RECOVER_PATCH_PREFIX = "template-upgrade-";
const RECOVER_PATCH_SUFFIX = ".patch";
const UTF8 = new TextDecoder("utf-8");

export interface TemplateUpgradeRecoverRequest {
  readonly templateRoot: string;
  readonly repository: string;
  readonly targetRef: string;
  readonly env?: ProcessEnvMap;
}

interface RecoveryTarget {
  readonly branch: string;
  readonly patchPath: string;
}

interface OwnedWorktreeState {
  readonly record: GitWorktreeRecord;
  readonly head: string;
}

function parsePositiveIndex(segment: string): number | undefined {
  if (!POSITIVE_INDEX_PATTERN.test(segment)) {
    return undefined;
  }
  const parsed = Number.parseInt(segment, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function collectUsedBranchIndices(
  repository: string,
  target7: string,
  env: ProcessEnvMap,
  used: Set<number>,
): void {
  const prefix = `${RECOVER_BRANCH_PREFIX}${target7}-failed-`;
  const result = runGitCommand(
    repository,
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${prefix}*`],
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = UTF8.decode(result.stderr).trim();
    throw new CliError(
      "repository_git_unreadable",
      detail === ""
        ? `cannot list branches in ${repository}`
        : `cannot list branches in ${repository}: ${detail}`,
      `inspect git -C ${repository} branch -a, then rerun`,
      1,
      false,
    );
  }
  const text = decodeUtf8Strict(result.stdout, "git for-each-ref output");
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(prefix)) {
      continue;
    }
    const firstSegment = trimmed.slice(prefix.length).split("/")[0] ?? "";
    const parsed = parsePositiveIndex(firstSegment);
    if (parsed !== undefined) {
      used.add(parsed);
    }
  }
}

async function collectUsedPatchIndices(
  worktreesRoot: string,
  target7: string,
  used: Set<number>,
): Promise<void> {
  const prefix = `${RECOVER_PATCH_PREFIX}${target7}-failed-`;
  const entries = await readdir(worktreesRoot);
  for (const name of entries) {
    if (!name.startsWith(prefix) || !name.endsWith(RECOVER_PATCH_SUFFIX)) {
      continue;
    }
    const middle = name.slice(prefix.length, -RECOVER_PATCH_SUFFIX.length);
    const parsed = parsePositiveIndex(middle);
    if (parsed !== undefined) {
      used.add(parsed);
    }
  }
}

async function allocateRecoveryTarget(
  repository: string,
  worktreesRoot: string,
  target7: string,
  env: ProcessEnvMap,
): Promise<RecoveryTarget> {
  const used = new Set<number>();
  collectUsedBranchIndices(repository, target7, env, used);
  await collectUsedPatchIndices(worktreesRoot, target7, used);
  const upperBound = used.size + 1;
  let index = 1;
  while (index <= upperBound && used.has(index)) {
    index += 1;
  }
  return {
    branch: `${RECOVER_BRANCH_PREFIX}${target7}-failed-${index}`,
    patchPath: join(
      worktreesRoot,
      `${RECOVER_PATCH_PREFIX}${target7}-failed-${index}${RECOVER_PATCH_SUFFIX}`,
    ),
  };
}

function unreadableWorktreeError(
  repository: string,
  targetWorktree: string,
): CliError {
  return new CliError(
    "worktree_not_owned",
    `refused to touch ${targetWorktree}: path is not a readable git worktree of ${repository}`,
    `inspect git -C ${repository} worktree list and move or remove ${targetWorktree} after saving any work, then rerun`,
    4,
    false,
  );
}

async function readOwnedWorktreeState(
  repository: string,
  targetWorktree: string,
  record: GitWorktreeRecord,
  isDirectory: boolean,
  env: ProcessEnvMap,
): Promise<OwnedWorktreeState> {
  if (!isDirectory) {
    throw unreadableWorktreeError(repository, targetWorktree);
  }
  const worktreeHead = await readWorktreeOwnHead(targetWorktree, env);
  if (
    worktreeHead === undefined ||
    !isRepositoryWorktree(repository, targetWorktree, env)
  ) {
    throw unreadableWorktreeError(repository, targetWorktree);
  }
  return { record, head: worktreeHead };
}

async function requireOwnedWorktree(
  repository: string,
  targetWorktree: string,
  target7: string,
  env: ProcessEnvMap,
): Promise<OwnedWorktreeState> {
  const record = await assertWorktreePathAvailableForTemplateUpgrade(
    repository,
    targetWorktree,
    env,
  );
  if (record === undefined) {
    throw new CliError(
      "worktree_missing",
      `no failed upgrade worktree found at ${targetWorktree}`,
      `inspect git -C ${repository} worktree list, or run bun run upgrade apply --repository ${repository} --to ${target7}`,
      4,
      true,
    );
  }
  const stats = await lstatIfPresent(targetWorktree);
  if (stats === undefined) {
    throw new CliError(
      "worktree_missing",
      `no failed upgrade worktree directory found at ${targetWorktree}`,
      `inspect git -C ${repository} worktree list, then rerun`,
      4,
      true,
    );
  }
  return await readOwnedWorktreeState(
    repository,
    targetWorktree,
    record,
    stats.isDirectory(),
    env,
  );
}

function buildRecoveryPatchBytes(
  repository: string,
  parentHead: string,
  commitSha: string,
  branch: string,
  patchPath: string,
  worktreesRoot: string,
  env: ProcessEnvMap,
): Uint8Array {
  const diffRun = runGitCommand(
    repository,
    ["diff", "--no-color", "--no-ext-diff", "--binary", parentHead, commitSha],
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  if (diffRun.timedOut || diffRun.exitCode !== 0) {
    const detail = diffRun.timedOut
      ? `git diff did not finish within ${WORKTREE_TIMEOUT_MS} ms`
      : UTF8.decode(diffRun.stderr).trim();
    const saved = `saved edits on branch ${branch} at ${commitSha.slice(0, 7)}`;
    throw new CliError(
      "worktree_patch_failed",
      detail === ""
        ? `cannot build recovery patch ${patchPath} (${saved})`
        : `cannot build recovery patch ${patchPath} (${saved}): ${detail}`,
      `inspect branch ${branch} in ${repository} and verify ${worktreesRoot} is writable, then rerun`,
      1,
      false,
    );
  }
  return diffRun.stdout;
}

async function writeRecoveryPatchFile(
  patchPath: string,
  bytes: Uint8Array,
  branch: string,
  commitSha: string,
  repository: string,
): Promise<void> {
  await assertNotSymlinkPath(patchPath, patchPath);
  const flags =
    constants.O_CREAT |
    constants.O_EXCL |
    constants.O_WRONLY |
    constants.O_NOFOLLOW;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let created = false;
  try {
    handle = await open(patchPath, flags, 0o644);
    created = true;
    await handle.writeFile(bytes);
  } catch (error) {
    if (created) {
      await handle?.close().catch(() => {});
      handle = undefined;
      await rm(patchPath, { force: true }).catch(() => {});
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "worktree_patch_failed",
      `cannot write recovery patch ${patchPath} (saved edits on branch ${branch} at ${commitSha.slice(0, 7)}): ${detail}`,
      `check permissions on ${dirname(patchPath)} in ${repository}, then rerun`,
      1,
      false,
    );
  } finally {
    await handle?.close();
  }
}

interface UnlockAndRemoveRequest {
  readonly repository: string;
  readonly targetWorktree: string;
  readonly target7: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly patchPath: string;
  readonly lockReason: string | undefined;
  readonly env: ProcessEnvMap;
}

function tryRelockWorktree(
  repository: string,
  targetWorktree: string,
  lockReason: string | undefined,
  env: ProcessEnvMap,
): boolean {
  if (lockReason === undefined) {
    return false;
  }
  const relock = runGitCommand(
    repository,
    ["worktree", "lock", "--reason", lockReason, targetWorktree],
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  return !relock.timedOut && relock.exitCode === 0;
}

function unlockAndRemoveWorktree(options: UnlockAndRemoveRequest): void {
  const {
    repository,
    targetWorktree,
    target7,
    branch,
    commitSha,
    patchPath,
    lockReason,
    env,
  } = options;
  const recoverCommand = `bun run upgrade recover --repository ${repository} --to ${target7}`;
  const savedEffects = `saved edits on branch ${branch} at ${commitSha.slice(0, 7)} and patch ${patchPath}`;
  runGitText(
    repository,
    ["worktree", "unlock", targetWorktree],
    {
      code: "worktree_unlock_failed",
      message: `cannot unlock worktree at ${targetWorktree} (${savedEffects})`,
      repair: `inspect git -C ${repository} worktree list, then rerun ${recoverCommand}`,
      exitCode: 1,
      retrySafe: false,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  const removed = runGitCommand(
    repository,
    ["worktree", "remove", targetWorktree],
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  if (!removed.timedOut && removed.exitCode === 0) {
    return;
  }
  const detail = removed.timedOut
    ? `git worktree remove did not finish within ${WORKTREE_TIMEOUT_MS} ms`
    : UTF8.decode(removed.stderr).trim();
  const relocked = tryRelockWorktree(
    repository,
    targetWorktree,
    lockReason,
    env,
  );
  const lockStatus = relocked
    ? "worktree re-locked"
    : "worktree could not be re-locked";
  const repair = relocked
    ? `inspect git -C ${targetWorktree} status and git -C ${repository} worktree list, then rerun ${recoverCommand}`
    : `inspect git -C ${targetWorktree} status and git -C ${repository} worktree list, then run git -C ${repository} worktree remove ${targetWorktree}`;
  throw new CliError(
    "worktree_remove_failed",
    detail === ""
      ? `cannot remove worktree at ${targetWorktree} (${savedEffects}; ${lockStatus})`
      : `cannot remove worktree at ${targetWorktree} (${savedEffects}; ${lockStatus}): ${detail}`,
    repair,
    1,
    false,
  );
}

interface CommittedRecoveryState {
  readonly branch: string;
  readonly patchPath: string;
  readonly parentHead: string;
  readonly commitSha: string;
}

function recoveryCommitSubject(target7: string): string {
  return `Recover failed template upgrade worktree for ${target7}`;
}

function parseMatchingRecoveryBranch(
  line: string,
  prefix: string,
  expectedCommit: string,
): number | undefined {
  const separator = line.indexOf(" ");
  if (separator <= 0) {
    return undefined;
  }
  const branchName = line.slice(0, separator);
  const tip = line.slice(separator + 1);
  if (tip !== expectedCommit || !branchName.startsWith(prefix)) {
    return undefined;
  }
  return parsePositiveIndex(branchName.slice(prefix.length));
}

function findExistingRecoveryState(
  repository: string,
  worktreesRoot: string,
  targetWorktree: string,
  target7: string,
  worktreeHead: string,
  env: ProcessEnvMap,
): CommittedRecoveryState | undefined {
  const status = readGitOutput(
    targetWorktree,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    env,
  );
  if (status !== "") {
    return undefined;
  }
  const subject = readGitOutput(
    targetWorktree,
    ["log", "-1", "--format=%s", worktreeHead],
    env,
  );
  if (subject !== recoveryCommitSubject(target7)) {
    return undefined;
  }
  const parentHead = resolveRefIfPresent(
    targetWorktree,
    `${worktreeHead}^`,
    env,
  );
  if (parentHead === undefined) {
    return undefined;
  }
  const prefix = `${RECOVER_BRANCH_PREFIX}${target7}-failed-`;
  const refs = readGitOutput(
    repository,
    [
      "for-each-ref",
      "--format=%(refname:short) %(objectname)",
      `refs/heads/${prefix}*`,
    ],
    env,
  );
  if (refs === undefined) {
    return undefined;
  }
  for (const line of refs.split("\n")) {
    const index = parseMatchingRecoveryBranch(
      line.trim(),
      prefix,
      worktreeHead,
    );
    if (index !== undefined) {
      return {
        branch: `${prefix}${index}`,
        patchPath: join(
          worktreesRoot,
          `${RECOVER_PATCH_PREFIX}${target7}-failed-${index}${RECOVER_PATCH_SUFFIX}`,
        ),
        parentHead,
        commitSha: worktreeHead,
      };
    }
  }
  return undefined;
}

async function ensureRecoveryCommit(options: {
  readonly repository: string;
  readonly worktreesRoot: string;
  readonly targetWorktree: string;
  readonly target7: string;
  readonly record: GitWorktreeRecord;
  readonly parentHead: string;
  readonly env: ProcessEnvMap;
}): Promise<CommittedRecoveryState> {
  const {
    repository,
    worktreesRoot,
    targetWorktree,
    target7,
    record,
    parentHead,
    env,
  } = options;
  const existing = findExistingRecoveryState(
    repository,
    worktreesRoot,
    targetWorktree,
    target7,
    parentHead,
    env,
  );
  if (existing !== undefined) {
    return existing;
  }
  const { branch, patchPath } = await allocateRecoveryTarget(
    repository,
    worktreesRoot,
    target7,
    env,
  );
  if (record.branch !== undefined) {
    runGitText(
      targetWorktree,
      ["checkout", "--quiet", "--detach", "HEAD"],
      {
        code: "worktree_commit_failed",
        message: `cannot detach worktree HEAD in ${targetWorktree}`,
        repair: `inspect git -C ${targetWorktree} status, then rerun`,
        exitCode: 1,
        retrySafe: false,
      },
      { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
    );
  }
  const commitSha = await stageAndCommitWorktree({
    worktree: targetWorktree,
    message: recoveryCommitSubject(target7),
    env,
    noVerify: true,
  });
  runGitText(
    repository,
    ["branch", branch, commitSha],
    {
      code: "branch_create_failed",
      message: `cannot create recovery branch ${branch} at ${commitSha.slice(0, 7)}`,
      repair: `inspect git -C ${repository} branch -a, then rerun`,
      exitCode: 1,
      retrySafe: false,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  return { branch, patchPath, parentHead, commitSha };
}

export async function templateUpgradeRecover(
  request: TemplateUpgradeRecoverRequest,
): Promise<TemplateUpgradeRecoverResult> {
  const { templateRoot, repository, targetRef } = request;
  const env = request.env ?? process.env;
  verifyGitRepository(repository, env);
  const targetCommit = resolveTemplateCommit(templateRoot, targetRef, env);
  const target7 = targetCommit.slice(0, 7);
  const { worktreesRoot, targetWorktree } = templateUpgradeWorktreePaths(
    repository,
    targetCommit,
  );
  await assertNotSymlinkPath(worktreesRoot, ".worktrees");
  await assertNotSymlinkPath(
    targetWorktree,
    `.worktrees/template-upgrade-${target7}`,
  );
  const { record, head } = await requireOwnedWorktree(
    repository,
    targetWorktree,
    target7,
    env,
  );
  const committed = await ensureRecoveryCommit({
    repository,
    worktreesRoot,
    targetWorktree,
    target7,
    record,
    parentHead: head,
    env,
  });
  const patchStats = await lstatIfPresent(committed.patchPath);
  if (patchStats?.isSymbolicLink()) {
    await assertNotSymlinkPath(committed.patchPath, committed.patchPath);
  }
  if (patchStats === undefined) {
    const patchBytes = buildRecoveryPatchBytes(
      repository,
      committed.parentHead,
      committed.commitSha,
      committed.branch,
      committed.patchPath,
      worktreesRoot,
      env,
    );
    await writeRecoveryPatchFile(
      committed.patchPath,
      patchBytes,
      committed.branch,
      committed.commitSha,
      repository,
    );
  } else if (!patchStats.isFile()) {
    throw new CliError(
      "worktree_patch_failed",
      `cannot write recovery patch ${committed.patchPath} (saved edits on branch ${committed.branch} at ${committed.commitSha.slice(0, 7)}): existing entry is not a regular file`,
      `move or remove ${committed.patchPath} in ${repository}, then rerun`,
      1,
      false,
    );
  }
  unlockAndRemoveWorktree({
    repository,
    targetWorktree,
    target7,
    branch: committed.branch,
    commitSha: committed.commitSha,
    patchPath: committed.patchPath,
    lockReason: record.lockReason,
    env,
  });
  return createTemplateUpgradeRecoverResult({
    targetCommit,
    worktree: targetWorktree,
    branch: committed.branch,
    commit: committed.commitSha,
    patchPath: committed.patchPath,
    rerunCommand: `bun run upgrade apply --repository ${repository} --to ${target7}`,
  });
}
