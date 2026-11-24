import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
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
  resolveRefIfPresent,
  writePlainFile,
} from "./template-upgrade-worktree.ts";

export const RECOVER_RECORD_FILE = "template-upgrade-recover.json";

const RECOVER_BRANCH_PREFIX = "template-upgrade/";
const RECOVER_PATCH_PREFIX = "template-upgrade-";
const RECOVER_PATCH_EXTENSION = ".patch";
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const POSITIVE_INDEX_PATTERN = /^[1-9]\d*$/;
const UTF8_DECODER = new TextDecoder("utf-8");
const UTF8_ENCODER = new TextEncoder();

function parsePositiveNumber(segment: string): number | undefined {
  if (!POSITIVE_INDEX_PATTERN.test(segment)) {
    return undefined;
  }
  const parsed = Number.parseInt(segment, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function formatRecoverTarget(
  worktreesRoot: string,
  target7: string,
  count: number,
): { readonly branch: string; readonly patchPath: string } {
  return {
    branch: `${RECOVER_BRANCH_PREFIX}${target7}-failed-${count}`,
    patchPath: join(
      worktreesRoot,
      `${RECOVER_PATCH_PREFIX}${target7}-failed-${count}${RECOVER_PATCH_EXTENSION}`,
    ),
  };
}

function parseRecoverBranchName(
  branch: string,
  target7: string,
): number | undefined {
  const prefix = `${RECOVER_BRANCH_PREFIX}${target7}-failed-`;
  if (!branch.startsWith(prefix)) {
    return undefined;
  }
  return parsePositiveNumber(branch.slice(prefix.length).split("/")[0] ?? "");
}

function parseRecoverPatchName(
  fileName: string,
  target7: string,
): number | undefined {
  const prefix = `${RECOVER_PATCH_PREFIX}${target7}-failed-`;
  if (
    !fileName.startsWith(prefix) ||
    !fileName.endsWith(RECOVER_PATCH_EXTENSION)
  ) {
    return undefined;
  }
  return parsePositiveNumber(
    fileName.slice(prefix.length, -RECOVER_PATCH_EXTENSION.length),
  );
}

function collectUsedBranchIndices(
  repository: string,
  target7: string,
  env: ProcessEnvMap,
  timeoutMilliseconds: number,
  used: Set<number>,
): void {
  const result = runGitCommand(
    repository,
    [
      "for-each-ref",
      "--format=%(refname:short)",
      `refs/heads/${RECOVER_BRANCH_PREFIX}${target7}-failed-*`,
    ],
    { env, timeoutMilliseconds },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = UTF8_DECODER.decode(result.stderr).trim();
    throw new CliError(
      "repository_git_unreadable",
      detail === ""
        ? `cannot list branches in ${repository}`
        : `cannot list branches in ${repository}: ${detail}`,
      `inspect git -C ${formatCommandPath(repository)} branch -a, then rerun`,
      1,
      false,
    );
  }
  for (const line of decodeUtf8Strict(
    result.stdout,
    "git for-each-ref output",
  ).split("\n")) {
    const parsed = parseRecoverBranchName(line.trim(), target7);
    if (parsed !== undefined) {
      used.add(parsed);
    }
  }
}

export async function findRecoverTarget(
  repository: string,
  worktreesRoot: string,
  target7: string,
  env: ProcessEnvMap,
  timeoutMilliseconds: number,
): Promise<{ readonly branch: string; readonly patchPath: string }> {
  const used = new Set<number>();
  collectUsedBranchIndices(repository, target7, env, timeoutMilliseconds, used);
  for (const name of await readdir(worktreesRoot)) {
    const parsed = parseRecoverPatchName(name, target7);
    if (parsed !== undefined) {
      used.add(parsed);
    }
  }
  const upperBound = used.size + 1;
  let count = 1;
  while (count <= upperBound && used.has(count)) {
    count += 1;
  }
  return formatRecoverTarget(worktreesRoot, target7, count);
}

const RECOVER_STEPS = ["commit", "patch", "unlock", "remove"] as const;
export type RecoverStep = (typeof RECOVER_STEPS)[number];

export interface RecoverRecord {
  readonly schemaVersion: 1;
  readonly targetCommit: string;
  readonly branch: string;
  readonly patchPath: string;
  readonly parentHead: string;
  readonly commitSha?: string;
  readonly step?: RecoverStep;
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
  readonly record: RecoverRecord;
  readonly worktreeLocked: boolean;
  readonly worktreeGitDir: string;
  readonly commonDir: string;
  readonly lockReason: string | undefined;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}

export interface VerifyRecoverRecordRequest {
  readonly repository: string;
  readonly worktreesRoot: string;
  readonly targetCommit: string;
  readonly target7: string;
  readonly head: string;
  readonly worktreeGitDir: string;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}

function ownField(record: object, key: string): unknown {
  return Object.hasOwn(record, key) ? Reflect.get(record, key) : undefined;
}

function parseRecoverStep(value: unknown): RecoverStep | undefined {
  return RECOVER_STEPS.find((step) => step === value);
}

function recoverStepRank(step: RecoverStep | undefined): number {
  return step === undefined ? 0 : RECOVER_STEPS.indexOf(step);
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

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value !== "";
}

function isFullCommit(value: unknown): value is string {
  return typeof value === "string" && FULL_COMMIT_PATTERN.test(value);
}

function parseJsonObject(rawText: string, recordPath: string): object {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    throw invalidRecordError(recordPath, "invalid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw invalidRecordError(recordPath, "expected JSON object");
  }
  return parsed;
}

function readOptionalRecoverStep(
  parsed: object,
  recordPath: string,
): RecoverStep | undefined {
  const stepRaw = ownField(parsed, "step");
  if (stepRaw === undefined) {
    return undefined;
  }
  const step = parseRecoverStep(stepRaw);
  if (step === undefined) {
    throw invalidRecordError(recordPath, "unexpected recovery record fields");
  }
  return step;
}

function readOptionalCommitSha(
  parsed: object,
  recordPath: string,
): string | undefined {
  const commitSha = ownField(parsed, "commitSha");
  if (commitSha === undefined) {
    return undefined;
  }
  if (!isFullCommit(commitSha)) {
    throw invalidRecordError(recordPath, "unexpected recovery record fields");
  }
  return commitSha;
}

function parseRecoverRecord(
  rawText: string,
  expectedTargetCommit: string,
  recordPath: string,
): RecoverRecord {
  const parsed = parseJsonObject(rawText, recordPath);
  const branch = ownField(parsed, "branch");
  const patchPath = ownField(parsed, "patchPath");
  const parentHead = ownField(parsed, "parentHead");
  const validRequired =
    ownField(parsed, "schemaVersion") === 1 &&
    ownField(parsed, "targetCommit") === expectedTargetCommit &&
    isNonEmptyString(branch) &&
    isNonEmptyString(patchPath) &&
    isFullCommit(parentHead);
  if (!validRequired) {
    throw invalidRecordError(recordPath, "unexpected recovery record fields");
  }
  const commitSha = readOptionalCommitSha(parsed, recordPath);
  const step = readOptionalRecoverStep(parsed, recordPath);
  return Object.freeze({
    schemaVersion: 1,
    targetCommit: expectedTargetCommit,
    branch,
    patchPath,
    parentHead,
    ...(commitSha !== undefined ? { commitSha } : {}),
    ...(step !== undefined ? { step } : {}),
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

export async function writeRecoverStep(
  recordPath: string,
  record: RecoverRecord,
  step: RecoverStep,
): Promise<RecoverRecord> {
  const targetStep =
    recoverStepRank(record.step) >= recoverStepRank(step)
      ? (record.step ?? step)
      : step;
  const updated: RecoverRecord = Object.freeze({ ...record, step: targetStep });
  if (record.step !== targetStep) {
    await writeRecoverRecord(recordPath, updated);
  }
  return updated;
}

export function readRecoverPatchBytes(
  repository: string,
  parentHead: string,
  commitSha: string,
  env: ProcessEnvMap,
  timeoutMilliseconds: number,
) {
  return runGitCommand(
    repository,
    [
      "diff",
      "--no-color",
      "--no-ext-diff",
      "--no-textconv",
      "--binary",
      parentHead,
      commitSha,
    ],
    { env, timeoutMilliseconds },
  );
}

function matchesRecoveryTargetPaths(
  branch: string,
  patchPath: string,
  worktreesRoot: string,
  target7: string,
): boolean {
  const branchPrefix = `${RECOVER_BRANCH_PREFIX}${target7}-failed-`;
  if (!branch.startsWith(branchPrefix)) {
    return false;
  }
  const suffix = branch.slice(branchPrefix.length);
  const count = parsePositiveNumber(suffix);
  if (count === undefined) {
    return false;
  }
  const expected = formatRecoverTarget(worktreesRoot, target7, count);
  if (basename(patchPath) !== basename(expected.patchPath)) {
    return false;
  }
  try {
    return realpathSync(dirname(patchPath)) === realpathSync(worktreesRoot);
  } catch {
    return false;
  }
}

async function matchesSavedPatch(
  options: VerifyRecoverRecordRequest,
  record: RecoverRecord & { readonly commitSha: string },
): Promise<boolean> {
  const patchStats = await lstatIfPresent(record.patchPath);
  if (
    patchStats === undefined ||
    patchStats.isSymbolicLink() ||
    !patchStats.isFile()
  ) {
    return false;
  }
  let existingBytes: Uint8Array;
  try {
    existingBytes = await readPlainFileBytes(record.patchPath);
  } catch {
    return false;
  }
  const diffRun = readRecoverPatchBytes(
    options.repository,
    record.parentHead,
    record.commitSha,
    options.env,
    options.timeoutMilliseconds,
  );
  return (
    !diffRun.timedOut &&
    diffRun.exitCode === 0 &&
    Buffer.compare(existingBytes, diffRun.stdout) === 0
  );
}

export async function verifyRecoverRecord(
  options: VerifyRecoverRecordRequest,
): Promise<RecoverRecord | undefined> {
  const statePath = join(options.worktreeGitDir, RECOVER_RECORD_FILE);
  let saved: RecoverRecord | undefined;
  try {
    saved = await readRecoverRecord(statePath, options.targetCommit);
  } catch {
    return undefined;
  }
  if (saved === undefined || saved.commitSha === undefined) {
    return undefined;
  }
  if (saved.step !== "unlock" && saved.step !== "remove") {
    return undefined;
  }
  if (options.head !== saved.commitSha) {
    return undefined;
  }
  if (
    !matchesRecoveryTargetPaths(
      saved.branch,
      saved.patchPath,
      options.worktreesRoot,
      options.target7,
    )
  ) {
    return undefined;
  }
  const { commitSha } = saved;
  if (
    resolveRefIfPresent(
      options.repository,
      `${commitSha}^{commit}`,
      options.env,
    ) !== commitSha ||
    resolveRefIfPresent(
      options.repository,
      `refs/heads/${saved.branch}`,
      options.env,
    ) !== commitSha
  ) {
    return undefined;
  }
  const patchOk = await matchesSavedPatch(options, { ...saved, commitSha });
  return patchOk ? saved : undefined;
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
    step: "remove",
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
