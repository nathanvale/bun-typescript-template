import { dirname, join } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  formatCommandPath,
  formatTemplateUpgradeCommand,
  lstatIfPresent,
  type ProcessEnvMap,
  resolveTemplateCommit,
  runGitCommand,
  runGitText,
  verifyGitRepository,
} from "./template-upgrade-git.ts";
import {
  type CommittedRecoverRecord,
  findRecoverTarget,
  RECOVER_RECORD_FILE,
  type RecoverRecord,
  type RecoverRemoveRequest,
  readRecoverPatchBytes,
  readRecoverRecord,
  reportFailedRemoveResult,
  restorePartialRemovePaths,
  verifyRecoverRecord,
  writeRecoverRecord,
  writeRecoverStep,
} from "./template-upgrade-recover-record.ts";
import {
  createTemplateUpgradeRecoverResult,
  type TemplateUpgradeRecoverResult,
} from "./template-upgrade-report.ts";
import {
  assertWorktreePathAvailableForTemplateUpgrade,
  findGitWorktreeRecord,
  type GitWorktreeRecord,
  isRepositoryWorktree,
  templateUpgradeLockReason,
} from "./template-upgrade-worktree-lock.ts";
import {
  assertNotSymlinkPath,
  readGitOutput,
  readPlainFileBytes,
  readWorktreeOwnHead,
  resolveRefIfPresent,
  stageAndCommitWorktree,
  templateUpgradeWorktreePaths,
  verifyWorktreeRemoveTree,
  writePlainFile,
} from "./template-upgrade-worktree.ts";

const WORKTREE_TIMEOUT_MS = 30_000;
const UTF8_DECODER = new TextDecoder("utf-8");

export interface TemplateUpgradeRecoverRequest {
  readonly templateRoot: string;
  readonly repository: string;
  readonly targetRef: string;
  readonly env?: ProcessEnvMap;
  readonly timeoutMilliseconds?: number;
}

interface OwnedWorktreeState {
  readonly record: GitWorktreeRecord;
  readonly head: string;
  readonly worktreeGitDir: string;
  readonly commonDir: string;
  readonly savedRecord: RecoverRecord | undefined;
}

interface RecoverTargetContext {
  readonly repository: string;
  readonly worktreesRoot: string;
  readonly targetWorktree: string;
  readonly targetCommit: string;
  readonly target7: string;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}

async function tryReadWorktreeGitMeta(
  repository: string,
  targetWorktree: string,
  isDirectory: boolean,
  env: ProcessEnvMap,
): Promise<
  | {
      readonly head: string;
      readonly worktreeGitDir: string;
      readonly commonDir: string;
    }
  | undefined
> {
  const head = isDirectory
    ? await readWorktreeOwnHead(targetWorktree, env)
    : undefined;
  const worktreeGitDir =
    head === undefined
      ? undefined
      : readGitOutput(
          targetWorktree,
          ["rev-parse", "--path-format=absolute", "--git-dir"],
          env,
        );
  const commonDir =
    head === undefined
      ? undefined
      : readGitOutput(
          targetWorktree,
          ["rev-parse", "--path-format=absolute", "--git-common-dir"],
          env,
        );
  if (
    head === undefined ||
    worktreeGitDir === undefined ||
    commonDir === undefined ||
    !isRepositoryWorktree(repository, targetWorktree, env)
  ) {
    return undefined;
  }
  return { head, worktreeGitDir, commonDir };
}

async function readWorktreeGitMeta(
  repository: string,
  targetWorktree: string,
  isDirectory: boolean,
  env: ProcessEnvMap,
): Promise<{
  readonly head: string;
  readonly worktreeGitDir: string;
  readonly commonDir: string;
}> {
  const meta = await tryReadWorktreeGitMeta(
    repository,
    targetWorktree,
    isDirectory,
    env,
  );
  if (meta === undefined) {
    throw new CliError(
      "worktree_not_owned",
      `refused to touch ${targetWorktree}: path is not a readable git worktree of ${repository}`,
      `inspect git -C ${formatCommandPath(repository)} worktree list and move or remove ${formatCommandPath(targetWorktree)} after saving any work, then rerun`,
      4,
      false,
    );
  }
  return meta;
}

async function readUnlockedRecoverWorktree(
  context: RecoverTargetContext,
  record: GitWorktreeRecord,
): Promise<OwnedWorktreeState | undefined> {
  if (record.branch !== undefined) {
    return undefined;
  }
  const meta = await tryReadWorktreeGitMeta(
    context.repository,
    context.targetWorktree,
    true,
    context.env,
  );
  if (meta === undefined) {
    return undefined;
  }
  const savedRecord = await verifyRecoverRecord({
    ...context,
    head: meta.head,
    worktreeGitDir: meta.worktreeGitDir,
  });
  return savedRecord === undefined
    ? undefined
    : { record, ...meta, savedRecord };
}

async function requireOwnedWorktree(
  context: RecoverTargetContext,
): Promise<OwnedWorktreeState> {
  const { repository, targetWorktree, targetCommit, target7, env } = context;
  const stats = await lstatIfPresent(targetWorktree);
  const existing = findGitWorktreeRecord(repository, targetWorktree, env);
  if (existing !== undefined && !existing.locked && stats?.isDirectory()) {
    const unlocked = await readUnlockedRecoverWorktree(context, existing);
    if (unlocked !== undefined) {
      return unlocked;
    }
  }
  const record = await assertWorktreePathAvailableForTemplateUpgrade(
    repository,
    targetWorktree,
    env,
  );
  if (record === undefined) {
    throw new CliError(
      "worktree_missing",
      `no failed upgrade worktree found at ${targetWorktree}`,
      `inspect git -C ${formatCommandPath(repository)} worktree list, or run ${formatTemplateUpgradeCommand("apply", repository, target7)}`,
      4,
      true,
    );
  }
  if (stats === undefined) {
    throw new CliError(
      "worktree_missing",
      `no failed upgrade worktree directory found at ${targetWorktree}`,
      `inspect git -C ${formatCommandPath(repository)} worktree list, then rerun`,
      4,
      true,
    );
  }
  const meta = await readWorktreeGitMeta(
    repository,
    targetWorktree,
    stats.isDirectory(),
    env,
  );
  const savedRecord = await readRecoverRecord(
    join(meta.worktreeGitDir, RECOVER_RECORD_FILE),
    targetCommit,
  );
  return { record, ...meta, savedRecord };
}

function ensureRecoveryBranch(options: {
  readonly repository: string;
  readonly branch: string;
  readonly commitSha: string;
  readonly recoverCmd: string;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}): void {
  const {
    repository,
    branch,
    commitSha,
    recoverCmd,
    env,
    timeoutMilliseconds,
  } = options;
  const branchTip = resolveRefIfPresent(
    repository,
    `refs/heads/${branch}`,
    env,
  );
  if (branchTip === undefined) {
    runGitText(
      repository,
      ["branch", branch, commitSha],
      {
        code: "branch_create_failed",
        message: `cannot create recovery branch ${branch} at ${commitSha.slice(0, 7)}`,
        repair: `inspect git -C ${formatCommandPath(repository)} branch -a, then rerun ${recoverCmd}`,
        exitCode: 1,
        retrySafe: false,
      },
      { env, timeoutMilliseconds },
    );
    return;
  }
  if (branchTip !== commitSha) {
    throw new CliError(
      "branch_create_failed",
      `recovery branch ${branch} already points to ${branchTip.slice(0, 7)}, not ${commitSha.slice(0, 7)}`,
      `inspect git -C ${formatCommandPath(repository)} branch -a, then rerun`,
      1,
      false,
    );
  }
}

async function resolveOrCommitRecovery(options: {
  readonly repository: string;
  readonly targetWorktree: string;
  readonly target7: string;
  readonly record: GitWorktreeRecord;
  readonly parentHead: string;
  readonly statePath: string;
  readonly state: RecoverRecord;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}): Promise<string> {
  const {
    repository,
    targetWorktree,
    target7,
    record,
    parentHead,
    statePath,
    state,
    env,
    timeoutMilliseconds,
  } = options;
  if (
    state.commitSha !== undefined &&
    resolveRefIfPresent(repository, `${state.commitSha}^{commit}`, env) ===
      state.commitSha
  ) {
    return state.commitSha;
  }
  if (
    parentHead !== state.parentHead &&
    resolveRefIfPresent(targetWorktree, `${parentHead}^`, env) ===
      state.parentHead
  ) {
    await writeRecoverRecord(statePath, { ...state, commitSha: parentHead });
    return parentHead;
  }
  if (record.branch !== undefined) {
    runGitText(
      targetWorktree,
      ["checkout", "--quiet", "--detach", "HEAD"],
      {
        code: "worktree_commit_failed",
        message: `cannot detach worktree HEAD in ${targetWorktree}`,
        repair: `inspect git -C ${formatCommandPath(targetWorktree)} status, then rerun`,
        exitCode: 1,
        retrySafe: false,
      },
      { env, timeoutMilliseconds },
    );
  }
  const commitSha = await stageAndCommitWorktree({
    worktree: targetWorktree,
    message: `Recover failed template upgrade worktree for ${target7}`,
    env,
    noVerify: true,
  });
  await writeRecoverRecord(statePath, { ...state, commitSha });
  return commitSha;
}

async function ensureRecoveryCommit(options: {
  readonly repository: string;
  readonly worktreesRoot: string;
  readonly targetWorktree: string;
  readonly targetCommit: string;
  readonly target7: string;
  readonly record: GitWorktreeRecord;
  readonly existing: RecoverRecord | undefined;
  readonly parentHead: string;
  readonly statePath: string;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}): Promise<{
  readonly committed: CommittedRecoverRecord;
  readonly state: RecoverRecord;
}> {
  const {
    repository,
    worktreesRoot,
    targetWorktree,
    targetCommit,
    target7,
    record,
    existing,
    parentHead,
    statePath,
    env,
    timeoutMilliseconds,
  } = options;
  const recoverCmd = formatTemplateUpgradeCommand(
    "recover",
    repository,
    target7,
  );
  const state: RecoverRecord =
    existing ??
    ({
      schemaVersion: 1,
      targetCommit,
      ...(await findRecoverTarget(
        repository,
        worktreesRoot,
        target7,
        env,
        timeoutMilliseconds,
      )),
      parentHead,
      step: "commit",
    } satisfies RecoverRecord);
  if (existing === undefined) {
    await writeRecoverRecord(statePath, state);
  }
  const commitSha = await resolveOrCommitRecovery({
    repository,
    targetWorktree,
    target7,
    record,
    parentHead,
    statePath,
    state,
    env,
    timeoutMilliseconds,
  });
  ensureRecoveryBranch({
    repository,
    branch: state.branch,
    commitSha,
    recoverCmd,
    env,
    timeoutMilliseconds,
  });
  const committedState: RecoverRecord = Object.freeze({
    ...state,
    commitSha,
    step: state.step ?? "commit",
  });
  if (committedState.step === "remove") {
    restorePartialRemovePaths(targetWorktree, env, timeoutMilliseconds);
  }
  const patchedState = await writeRecoverStep(
    statePath,
    committedState,
    "patch",
  );
  return {
    committed: {
      branch: state.branch,
      patchPath: state.patchPath,
      parentHead: state.parentHead,
      commitSha,
    },
    state: patchedState,
  };
}

function buildRecoveryPatchBytes(
  repository: string,
  committed: CommittedRecoverRecord,
  worktreesRoot: string,
  env: ProcessEnvMap,
  timeoutMilliseconds: number,
): Uint8Array {
  const diffRun = readRecoverPatchBytes(
    repository,
    committed.parentHead,
    committed.commitSha,
    env,
    timeoutMilliseconds,
  );
  if (diffRun.timedOut || diffRun.exitCode !== 0) {
    const detail = diffRun.timedOut
      ? `git diff did not finish within ${timeoutMilliseconds} ms`
      : UTF8_DECODER.decode(diffRun.stderr).trim();
    const saved = `saved edits on branch ${committed.branch} at ${committed.commitSha.slice(0, 7)}`;
    throw new CliError(
      "worktree_patch_failed",
      detail === ""
        ? `cannot build recovery patch ${committed.patchPath} (${saved})`
        : `cannot build recovery patch ${committed.patchPath} (${saved}): ${detail}`,
      `inspect branch ${committed.branch} in ${formatCommandPath(repository)} and verify ${formatCommandPath(worktreesRoot)} is writable, then rerun`,
      1,
      false,
    );
  }
  return diffRun.stdout;
}

async function ensureRecoveryPatchFile(options: {
  readonly repository: string;
  readonly target7: string;
  readonly worktreesRoot: string;
  readonly committed: CommittedRecoverRecord;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}): Promise<void> {
  const {
    repository,
    target7,
    worktreesRoot,
    committed,
    env,
    timeoutMilliseconds,
  } = options;
  const expectedBytes = buildRecoveryPatchBytes(
    repository,
    committed,
    worktreesRoot,
    env,
    timeoutMilliseconds,
  );
  const recoverCmd = formatTemplateUpgradeCommand(
    "recover",
    repository,
    target7,
  );
  const saved = `saved edits on branch ${committed.branch} at ${committed.commitSha.slice(0, 7)}`;
  const quotedPatch = formatCommandPath(committed.patchPath);
  const quotedRepo = formatCommandPath(repository);
  const patchStats = await lstatIfPresent(committed.patchPath);
  if (patchStats?.isSymbolicLink()) {
    await assertNotSymlinkPath(committed.patchPath, committed.patchPath);
  }
  if (patchStats === undefined) {
    try {
      await writePlainFile(committed.patchPath, expectedBytes);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new CliError(
        "worktree_patch_failed",
        `cannot write recovery patch ${committed.patchPath} (${saved}): ${detail}`,
        `check permissions on ${formatCommandPath(dirname(committed.patchPath))} in ${quotedRepo}, then rerun ${recoverCmd}`,
        1,
        false,
      );
    }
    return;
  }
  if (!patchStats.isFile()) {
    throw new CliError(
      "worktree_patch_failed",
      `cannot write recovery patch ${committed.patchPath} (${saved}): existing entry is not a regular file`,
      `move or remove ${quotedPatch} in ${quotedRepo}, then rerun ${recoverCmd}`,
      1,
      false,
    );
  }
  let existingBytes: Uint8Array;
  try {
    existingBytes = await readPlainFileBytes(committed.patchPath);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "worktree_patch_failed",
      `cannot read existing recovery patch ${committed.patchPath} (${saved}): ${detail}`,
      `inspect or move ${quotedPatch} in ${quotedRepo}, then rerun ${recoverCmd}`,
      1,
      false,
    );
  }
  if (Buffer.compare(existingBytes, expectedBytes) !== 0) {
    throw new CliError(
      "worktree_patch_failed",
      `existing recovery patch ${committed.patchPath} does not match expected diff (${existingBytes.length} bytes found, ${expectedBytes.length} expected; ${saved})`,
      `inspect or move ${quotedPatch} in ${quotedRepo}, then rerun ${recoverCmd}`,
      1,
      false,
    );
  }
}

async function unlockAndRemoveWorktree(
  options: RecoverRemoveRequest,
): Promise<void> {
  const {
    repository,
    targetWorktree,
    target7,
    committed,
    record,
    worktreeLocked,
    worktreeGitDir,
    env,
    timeoutMilliseconds,
  } = options;
  const recoverCmd = formatTemplateUpgradeCommand(
    "recover",
    repository,
    target7,
  );
  const savedEffects = `saved edits on branch ${committed.branch} at ${committed.commitSha.slice(0, 7)} and patch ${committed.patchPath}`;
  try {
    await verifyWorktreeRemoveTree(targetWorktree);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    const untouched = worktreeLocked
      ? "worktree left locked and untouched"
      : "worktree left untouched";
    throw new CliError(
      "worktree_remove_failed",
      `cannot remove worktree at ${targetWorktree} (${savedEffects}; ${untouched}): ${detail}`,
      `fix permissions on ${formatCommandPath(targetWorktree)} and ${formatCommandPath(dirname(targetWorktree))}, then rerun ${recoverCmd}`,
      1,
      false,
    );
  }
  const statePath = join(worktreeGitDir, RECOVER_RECORD_FILE);
  const unlockState = await writeRecoverStep(statePath, record, "unlock");
  if (worktreeLocked) {
    runGitText(
      repository,
      ["worktree", "unlock", targetWorktree],
      {
        code: "worktree_unlock_failed",
        message: `cannot unlock worktree at ${targetWorktree} (${savedEffects})`,
        repair: `inspect git -C ${formatCommandPath(repository)} worktree list, then rerun ${recoverCmd}`,
        exitCode: 1,
        retrySafe: false,
      },
      { env, timeoutMilliseconds },
    );
  }
  await writeRecoverStep(statePath, unlockState, "remove");
  const removed = runGitCommand(
    repository,
    ["worktree", "remove", targetWorktree],
    { env, timeoutMilliseconds },
  );
  if (!removed.timedOut && removed.exitCode === 0) {
    return;
  }
  const detail = removed.timedOut
    ? `git worktree remove did not finish within ${timeoutMilliseconds} ms`
    : UTF8_DECODER.decode(removed.stderr).trim();
  const { statusSummary, repair } = await reportFailedRemoveResult(options);
  throw new CliError(
    "worktree_remove_failed",
    detail === ""
      ? `cannot remove worktree at ${targetWorktree} (${savedEffects}; ${statusSummary})`
      : `cannot remove worktree at ${targetWorktree} (${savedEffects}; ${statusSummary}): ${detail}`,
    repair,
    1,
    false,
  );
}

export async function templateUpgradeRecover(
  request: TemplateUpgradeRecoverRequest,
): Promise<TemplateUpgradeRecoverResult> {
  const { templateRoot, repository, targetRef } = request;
  const env = request.env ?? process.env;
  const timeoutMilliseconds =
    request.timeoutMilliseconds ?? WORKTREE_TIMEOUT_MS;
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
  const { record, head, worktreeGitDir, commonDir, savedRecord } =
    await requireOwnedWorktree({
      repository,
      worktreesRoot,
      targetWorktree,
      targetCommit,
      target7,
      env,
      timeoutMilliseconds,
    });
  const { committed, state } = await ensureRecoveryCommit({
    repository,
    worktreesRoot,
    targetWorktree,
    targetCommit,
    target7,
    record,
    existing: savedRecord,
    parentHead: head,
    statePath: join(worktreeGitDir, RECOVER_RECORD_FILE),
    env,
    timeoutMilliseconds,
  });
  await ensureRecoveryPatchFile({
    repository,
    target7,
    worktreesRoot,
    committed,
    env,
    timeoutMilliseconds,
  });
  await unlockAndRemoveWorktree({
    repository,
    targetWorktree,
    targetCommit,
    target7,
    committed,
    record: state,
    worktreeLocked: record.locked,
    worktreeGitDir,
    commonDir,
    lockReason: record.lockReason ?? templateUpgradeLockReason(targetCommit),
    env,
    timeoutMilliseconds,
  });
  return createTemplateUpgradeRecoverResult({
    targetCommit,
    worktree: targetWorktree,
    branch: committed.branch,
    commit: committed.commitSha,
    patchPath: committed.patchPath,
    rerunCommand: formatTemplateUpgradeCommand("apply", repository, target7),
  });
}
