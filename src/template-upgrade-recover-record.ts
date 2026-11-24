import { realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  decodeUtf8Strict,
  formatCommandPath,
  formatTemplateUpgradeCommand,
  lstatIfPresent,
  type ProcessEnvMap,
  runGitCommand,
} from "./template-upgrade-git.ts";
import {
  findGitWorktreeRecord,
  type GitWorktreeRecord,
  isTemplateUpgradeLockedWorktree,
} from "./template-upgrade-worktree-lock.ts";
import {
  assertNotSymlinkPath,
  readPlainFileBytes,
  readWorktreeOwnHead,
  writePlainFile,
} from "./template-upgrade-worktree.ts";

export const RECOVER_RECORD_FILE = "template-upgrade-recover.json";

const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const UTF8_ENCODER = new TextEncoder();

export interface RecoverRecord {
  readonly schemaVersion: 1;
  readonly targetCommit: string;
  readonly branch: string;
  readonly patchPath: string;
  readonly parentHead: string;
  readonly commitSha?: string;
  readonly removalAttempted?: boolean;
}

export interface CommittedRecoverRecord {
  readonly branch: string;
  readonly patchPath: string;
  readonly parentHead: string;
  readonly commitSha: string;
}

export interface RecoverRemoveRequest {
  readonly repository: string;
  readonly targetWorktree: string;
  readonly targetCommit: string;
  readonly target7: string;
  readonly committed: CommittedRecoverRecord;
  readonly worktreeGitDir: string;
  readonly commonDir: string;
  readonly lockReason: string | undefined;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}

function ownField(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? Reflect.get(record, key) : undefined;
}

function invalidRecordError(recordPath: string, reason: string): CliError {
  return new CliError(
    "worktree_commit_failed",
    `unreadable recovery record ${recordPath}: ${reason}`,
    `inspect or remove ${formatCommandPath(recordPath)}, then rerun`,
    1,
    false,
  );
}

function parseRecoverRecord(
  rawText: string,
  expectedTargetCommit: string,
  recordPath: string,
): RecoverRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw invalidRecordError(recordPath, "invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidRecordError(recordPath, "expected JSON object");
  }
  const version = ownField(parsed, "schemaVersion");
  const targetCommit = ownField(parsed, "targetCommit");
  const branch = ownField(parsed, "branch");
  const patchPath = ownField(parsed, "patchPath");
  const parentHead = ownField(parsed, "parentHead");
  const commitSha = ownField(parsed, "commitSha");
  const removalAttempted = ownField(parsed, "removalAttempted");
  const validRequired =
    version === 1 &&
    targetCommit === expectedTargetCommit &&
    typeof branch === "string" &&
    branch !== "" &&
    typeof patchPath === "string" &&
    patchPath !== "" &&
    typeof parentHead === "string" &&
    FULL_COMMIT_PATTERN.test(parentHead);
  const validOptional =
    (commitSha === undefined ||
      (typeof commitSha === "string" && FULL_COMMIT_PATTERN.test(commitSha))) &&
    (removalAttempted === undefined || typeof removalAttempted === "boolean");
  if (!validRequired || !validOptional) {
    throw invalidRecordError(recordPath, "unexpected recovery record fields");
  }
  return Object.freeze({
    schemaVersion: 1,
    targetCommit,
    branch,
    patchPath,
    parentHead,
    ...(typeof commitSha === "string" ? { commitSha } : {}),
    ...(typeof removalAttempted === "boolean" ? { removalAttempted } : {}),
  });
}

export async function readRecoverRecord(
  recordPath: string,
  expectedTargetCommit: string,
): Promise<RecoverRecord | undefined> {
  const stats = await lstatIfPresent(recordPath);
  if (stats === undefined) {
    return undefined;
  }
  if (stats.isSymbolicLink()) {
    await assertNotSymlinkPath(recordPath, recordPath);
  }
  if (!stats.isFile()) {
    throw invalidRecordError(recordPath, "entry is not a regular file");
  }
  const bytes = await readPlainFileBytes(recordPath);
  return parseRecoverRecord(
    decodeUtf8Strict(bytes, recordPath),
    expectedTargetCommit,
    recordPath,
  );
}

export async function writeRecoverRecord(
  recordPath: string,
  record: RecoverRecord,
): Promise<void> {
  await writePlainFile(
    recordPath,
    UTF8_ENCODER.encode(`${JSON.stringify(record)}\n`),
  );
}

export function restorePartialRemovePaths(
  targetWorktree: string,
  env: ProcessEnvMap,
  timeoutMilliseconds: number,
): void {
  const status = runGitCommand(
    targetWorktree,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { env, timeoutMilliseconds },
  );
  if (status.timedOut || status.exitCode !== 0) {
    return;
  }
  const tokens = decodeUtf8Strict(status.stdout, "git status output").split(
    "\0",
  );
  const deletedTracked: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token.length < 4) {
      continue;
    }
    if (token[0] === "R" || token[0] === "C") {
      index += 1;
    } else if (token.slice(0, 2) === " D") {
      deletedTracked.push(token.slice(3));
    }
  }
  if (deletedTracked.length > 0) {
    runGitCommand(
      targetWorktree,
      ["--literal-pathspecs", "checkout", "--", ...deletedTracked],
      { env, timeoutMilliseconds },
    );
  }
}

async function restoreWorktreeRegistration(
  options: RecoverRemoveRequest,
): Promise<boolean> {
  const {
    repository,
    targetWorktree,
    targetCommit,
    committed,
    worktreeGitDir,
    commonDir,
    env,
    timeoutMilliseconds,
  } = options;
  const beforeRecord = findGitWorktreeRecord(repository, targetWorktree, env);
  const needsRestore =
    beforeRecord === undefined ||
    (await lstatIfPresent(join(targetWorktree, ".git"))) === undefined ||
    (await lstatIfPresent(worktreeGitDir)) === undefined;
  if (needsRestore) {
    await writePlainFile(
      join(targetWorktree, ".git"),
      UTF8_ENCODER.encode(`gitdir: ${worktreeGitDir}\n`),
    );
    await mkdir(worktreeGitDir, { recursive: true });
    await writePlainFile(
      join(worktreeGitDir, "gitdir"),
      UTF8_ENCODER.encode(`${join(realpathSync(targetWorktree), ".git")}\n`),
    );
    await writePlainFile(
      join(worktreeGitDir, "HEAD"),
      UTF8_ENCODER.encode(`${committed.commitSha}\n`),
    );
    await writePlainFile(
      join(worktreeGitDir, "commondir"),
      UTF8_ENCODER.encode(`${relative(worktreeGitDir, commonDir)}\n`),
    );
    runGitCommand(targetWorktree, ["read-tree", "HEAD"], {
      env,
      timeoutMilliseconds,
    });
  }
  await writeRecoverRecord(join(worktreeGitDir, RECOVER_RECORD_FILE), {
    schemaVersion: 1,
    targetCommit,
    branch: committed.branch,
    patchPath: committed.patchPath,
    parentHead: committed.parentHead,
    commitSha: committed.commitSha,
    removalAttempted: true,
  });
  return needsRestore;
}

async function attemptWorktreeRestore(
  options: RecoverRemoveRequest,
): Promise<boolean> {
  const { repository, targetWorktree, lockReason, env, timeoutMilliseconds } =
    options;
  const dirStats = await lstatIfPresent(targetWorktree);
  if (!dirStats?.isDirectory()) {
    return false;
  }
  let reregistered: boolean;
  try {
    reregistered = await restoreWorktreeRegistration(options);
  } catch {
    return false;
  }
  const current = findGitWorktreeRecord(repository, targetWorktree, env);
  if (lockReason !== undefined && current !== undefined && !current.locked) {
    runGitCommand(
      repository,
      ["worktree", "lock", "--reason", lockReason, targetWorktree],
      { env, timeoutMilliseconds },
    );
  }
  return reregistered;
}

function formatRemainingWorktreeReport(options: {
  readonly repository: string;
  readonly targetWorktree: string;
  readonly target7: string;
  readonly hasDir: boolean;
  readonly hasGitLink: boolean;
  readonly record: GitWorktreeRecord | undefined;
}): { readonly statusSummary: string; readonly repair: string } {
  const { repository, targetWorktree, target7, hasDir, hasGitLink, record } =
    options;
  const regState =
    record === undefined
      ? "absent"
      : record.locked
        ? "present (locked)"
        : "present (unlocked)";
  const remaining = `directory ${hasDir ? "present" : "absent"}, .git link ${hasGitLink ? "present" : "absent"}, worktree registration ${regState}`;
  const applyCmd = formatTemplateUpgradeCommand("apply", repository, target7);
  return {
    statusSummary: `worktree could not be restored for retry (${remaining})`,
    repair: `inspect ${formatCommandPath(targetWorktree)} and git -C ${formatCommandPath(repository)} worktree list, fix permissions if needed, and clear any leftover entry before running ${applyCmd}`,
  };
}

export async function reportFailedRemoveResult(
  options: RecoverRemoveRequest,
): Promise<{ readonly statusSummary: string; readonly repair: string }> {
  const { repository, targetWorktree, target7, env } = options;
  const reregistered = await attemptWorktreeRestore(options);
  const finalDir = await lstatIfPresent(targetWorktree);
  const finalGitLink = await lstatIfPresent(join(targetWorktree, ".git"));
  const finalRecord = findGitWorktreeRecord(repository, targetWorktree, env);
  const finalHead = finalDir?.isDirectory()
    ? await readWorktreeOwnHead(targetWorktree, env)
    : undefined;
  const recoverable =
    finalDir?.isDirectory() === true &&
    finalRecord !== undefined &&
    isTemplateUpgradeLockedWorktree(finalRecord) &&
    finalHead !== undefined;
  if (recoverable) {
    const recoverCmd = formatTemplateUpgradeCommand(
      "recover",
      repository,
      target7,
    );
    return {
      statusSummary: reregistered
        ? "worktree re-registered and re-locked"
        : "worktree re-locked",
      repair: `inspect git -C ${formatCommandPath(targetWorktree)} status and git -C ${formatCommandPath(repository)} worktree list, then rerun ${recoverCmd}`,
    };
  }
  return formatRemainingWorktreeReport({
    repository,
    targetWorktree,
    target7,
    hasDir: finalDir !== undefined,
    hasGitLink: finalGitLink !== undefined,
    record: finalRecord,
  });
}
