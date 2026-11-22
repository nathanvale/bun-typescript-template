import { realpathSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  decodeUtf8Strict,
  lstatIfPresent,
  type ProcessEnvMap,
  runGitCommand,
  runGitText,
} from "./template-upgrade-git.ts";
import {
  assertNotSymlinkPath,
  readGitOutput,
  readWorktreeOwnHead,
} from "./template-upgrade-worktree.ts";

const WORKTREE_TIMEOUT_MS = 30_000;
const UTF8 = new TextDecoder("utf-8");

export const TEMPLATE_UPGRADE_LOCK_PREFIX = "template-upgrade ";

export function templateUpgradeLockReason(targetCommit: string): string {
  return `${TEMPLATE_UPGRADE_LOCK_PREFIX}${targetCommit}`;
}

export interface GitWorktreeRecord {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
  readonly detached: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly lockReason?: string;
  readonly prunable: boolean;
}

export interface WorktreePathsRequest {
  readonly worktreesRoot: string;
  readonly temporaryWorktree: string;
  readonly targetWorktree: string;
  readonly targetCommit: string;
}

export interface LockedWorktreeCreateRequest {
  readonly repository: string;
  readonly worktreePath: string;
  readonly commit: string;
  readonly targetCommit: string;
  readonly env: ProcessEnvMap;
}

export interface LockedWorktreeMoveRequest {
  readonly repository: string;
  readonly sourceWorktree: string;
  readonly targetWorktree: string;
  readonly env: ProcessEnvMap;
}

export interface TargetWorktreeHeadRequest {
  readonly repository: string;
  readonly repositoryHead: string;
  readonly targetCommit: string;
  readonly targetWorktree: string;
  readonly env: ProcessEnvMap;
}

export interface LeftoverWorktreeRequest {
  readonly repository: string;
  readonly worktreePath: string;
  readonly expectedHead: string;
  readonly env: ProcessEnvMap;
}

interface MutableWorktreeRecord {
  path: string;
  head?: string;
  branch?: string;
  detached: boolean;
  bare: boolean;
  locked: boolean;
  lockReason?: string;
  prunable: boolean;
}

function applyPorcelainAttribute(
  record: MutableWorktreeRecord,
  line: string,
): void {
  if (line.startsWith("HEAD ")) {
    record.head = line.slice("HEAD ".length);
    return;
  }
  if (line.startsWith("branch ")) {
    record.branch = line.slice("branch ".length);
    return;
  }
  if (line === "detached") {
    record.detached = true;
    return;
  }
  if (line === "bare") {
    record.bare = true;
    return;
  }
  if (line === "locked") {
    record.locked = true;
    return;
  }
  if (line.startsWith("locked ")) {
    record.locked = true;
    record.lockReason = line.slice("locked ".length);
    return;
  }
  if (line === "prunable" || line.startsWith("prunable ")) {
    record.prunable = true;
  }
}

function parsePorcelainBlock(
  lines: readonly string[],
): GitWorktreeRecord | undefined {
  const first = lines[0];
  if (first === undefined || !first.startsWith("worktree ")) {
    return undefined;
  }
  const record: MutableWorktreeRecord = {
    path: first.slice("worktree ".length),
    detached: false,
    bare: false,
    locked: false,
    prunable: false,
  };
  for (const line of lines.slice(1)) {
    applyPorcelainAttribute(record, line);
  }
  return Object.freeze(record);
}

export function listGitWorktrees(
  repository: string,
  env: ProcessEnvMap = process.env,
): readonly GitWorktreeRecord[] {
  const result = runGitCommand(
    repository,
    ["worktree", "list", "--porcelain", "-z"],
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = UTF8.decode(result.stderr).trim();
    throw new CliError(
      "worktree_list_failed",
      detail === ""
        ? `cannot list git worktrees in ${repository}`
        : `cannot list git worktrees in ${repository}: ${detail}`,
      `inspect git -C ${repository} worktree list, then rerun`,
      1,
      false,
    );
  }
  const text = decodeUtf8Strict(result.stdout, "git worktree list output");
  const records = text
    .split("\0\0")
    .map((block) => parsePorcelainBlock(block.split("\0").filter(Boolean)))
    .filter((entry): entry is GitWorktreeRecord => entry !== undefined);
  return Object.freeze(records);
}

export function isTemplateUpgradeLockedWorktree(
  record: GitWorktreeRecord,
): boolean {
  return (
    record.locked &&
    record.lockReason !== undefined &&
    record.lockReason.startsWith(TEMPLATE_UPGRADE_LOCK_PREFIX)
  );
}

function normalizeWorktreeTarget(targetPath: string): string {
  const absolute = resolve(targetPath);
  const trailing: string[] = [];
  let current = absolute;
  while (true) {
    try {
      return trailing.length === 0
        ? realpathSync(current)
        : join(realpathSync(current), ...trailing.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) {
        return absolute;
      }
      trailing.push(basename(current));
      current = parent;
    }
  }
}

export function findGitWorktreeRecord(
  repository: string,
  worktreePath: string,
  env: ProcessEnvMap = process.env,
): GitWorktreeRecord | undefined {
  const normalizedTarget = normalizeWorktreeTarget(worktreePath);
  const resolvedTarget = resolve(worktreePath);
  return listGitWorktrees(repository, env).find((record) => {
    const normalizedRecord = normalizeWorktreeTarget(record.path);
    return (
      normalizedRecord === normalizedTarget ||
      resolve(record.path) === resolvedTarget
    );
  });
}

function readGitCommonDir(
  folderPath: string,
  env: ProcessEnvMap,
): string | undefined {
  const commonDirRaw = readGitOutput(
    folderPath,
    ["rev-parse", "--git-common-dir"],
    env,
  );
  if (commonDirRaw === undefined || commonDirRaw === "") {
    return undefined;
  }
  return normalizeWorktreeTarget(resolve(folderPath, commonDirRaw));
}

async function worktreesMetadataFolder(
  repository: string,
  env: ProcessEnvMap,
): Promise<string | undefined> {
  const commonDir = readGitCommonDir(repository, env);
  if (commonDir === undefined) {
    return undefined;
  }
  const folderPath = join(commonDir, "worktrees");
  const stats = await lstatIfPresent(folderPath);
  return stats !== undefined && stats.isDirectory() ? folderPath : undefined;
}

async function registrationMatchesWorktree(
  entryDir: string,
  expectedGitDir: string,
  rawExpectedGitDir: string,
): Promise<boolean> {
  const gitdirFile = join(entryDir, "gitdir");
  const gitdirStats = await lstatIfPresent(gitdirFile);
  if (gitdirStats === undefined || !gitdirStats.isFile()) {
    return false;
  }
  const recorded = (await readFile(gitdirFile, "utf8")).trim();
  const normalizedRecorded = join(
    normalizeWorktreeTarget(dirname(recorded)),
    basename(recorded),
  );
  return (
    recorded === expectedGitDir ||
    recorded === rawExpectedGitDir ||
    normalizedRecorded === expectedGitDir
  );
}

async function removeWorktreeRegistrationByPath(
  repository: string,
  worktreePath: string,
  env: ProcessEnvMap,
): Promise<void> {
  const worktreesMetaDir = await worktreesMetadataFolder(repository, env);
  if (worktreesMetaDir === undefined) {
    return;
  }
  const expectedGitDir = join(normalizeWorktreeTarget(worktreePath), ".git");
  const rawExpectedGitDir = join(resolve(worktreePath), ".git");
  const entries = await readdir(worktreesMetaDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    const entryDir = join(worktreesMetaDir, entry.name);
    if (
      await registrationMatchesWorktree(
        entryDir,
        expectedGitDir,
        rawExpectedGitDir,
      )
    ) {
      await rm(entryDir, { force: true, recursive: true });
    }
  }
}

function unownedWorktreePathError(
  repository: string,
  worktreePath: string,
  record: GitWorktreeRecord | undefined,
  stats: Awaited<ReturnType<typeof lstatIfPresent>>,
): CliError {
  if (record !== undefined) {
    if (record.locked) {
      const reasonLabel =
        record.lockReason === undefined || record.lockReason === ""
          ? "no lock reason"
          : `lock reason "${record.lockReason}"`;
      return new CliError(
        "worktree_not_owned",
        `refused to touch ${worktreePath}: worktree is locked with ${reasonLabel}, not "${TEMPLATE_UPGRADE_LOCK_PREFIX.trim()}"`,
        `save any work in ${worktreePath}, then run git worktree unlock ${worktreePath} and git worktree remove ${worktreePath} in ${repository} (or move it), then rerun`,
        4,
        false,
      );
    }
    if (stats === undefined) {
      return new CliError(
        "worktree_not_owned",
        `refused to touch ${worktreePath}: git has an unlocked worktree registration at that path`,
        `inspect git -C ${repository} worktree list and move or clear ${worktreePath} before rerunning`,
        4,
        false,
      );
    }
    return new CliError(
      "worktree_not_owned",
      `refused to touch ${worktreePath}: worktree is not locked by template-upgrade`,
      `move or remove ${worktreePath} once you no longer need it (for example git worktree move or git worktree remove ${worktreePath} in ${repository}), then rerun`,
      4,
      false,
    );
  }
  const entryKind = stats?.isDirectory()
    ? "folder"
    : stats?.isFile()
      ? "file"
      : "entry";
  return new CliError(
    "worktree_not_owned",
    `refused to touch ${worktreePath}: existing plain ${entryKind} is not a worktree locked by template-upgrade`,
    `move or remove ${worktreePath} after saving anything you need from it, then rerun`,
    4,
    false,
  );
}

export async function assertWorktreePathAvailableForTemplateUpgrade(
  repository: string,
  worktreePath: string,
  env: ProcessEnvMap = process.env,
): Promise<GitWorktreeRecord | undefined> {
  const stats = await lstatIfPresent(worktreePath);
  if (stats?.isSymbolicLink()) {
    await assertNotSymlinkPath(worktreePath, worktreePath);
  }
  const record = findGitWorktreeRecord(repository, worktreePath, env);
  if (stats === undefined && record === undefined) {
    return undefined;
  }
  if (record !== undefined && isTemplateUpgradeLockedWorktree(record)) {
    return record;
  }
  throw unownedWorktreePathError(repository, worktreePath, record, stats);
}

export async function removeTemplateUpgradeWorktree(
  repository: string,
  worktreePath: string,
  env: ProcessEnvMap = process.env,
): Promise<void> {
  const record = await assertWorktreePathAvailableForTemplateUpgrade(
    repository,
    worktreePath,
    env,
  );
  if (record === undefined) {
    return;
  }
  const removed = runGitCommand(
    repository,
    ["worktree", "remove", "--force", "--force", worktreePath],
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  await rm(worktreePath, { force: true, recursive: true });
  if (removed.timedOut || removed.exitCode !== 0) {
    await removeWorktreeRegistrationByPath(repository, worktreePath, env);
  }
}

export async function createLockedTemplateUpgradeWorktree(
  options: LockedWorktreeCreateRequest,
): Promise<void> {
  const { repository, worktreePath, commit, targetCommit, env } = options;
  await removeTemplateUpgradeWorktree(repository, worktreePath, env);
  await mkdir(dirname(worktreePath), { recursive: true });
  runGitText(
    repository,
    ["worktree", "add", "--quiet", "--detach", worktreePath, commit],
    {
      code: "worktree_create_failed",
      message: `cannot create worktree at ${worktreePath}`,
      repair: `inspect git -C ${repository} worktree list, then rerun`,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  runGitText(
    repository,
    [
      "worktree",
      "lock",
      "--reason",
      templateUpgradeLockReason(targetCommit),
      worktreePath,
    ],
    {
      code: "worktree_lock_failed",
      message: `cannot lock worktree at ${worktreePath}`,
      repair: `inspect git -C ${repository} worktree list and remove ${worktreePath} if unused, then rerun`,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
}

export async function moveLockedTemplateUpgradeWorktree(
  options: LockedWorktreeMoveRequest,
): Promise<void> {
  const { repository, sourceWorktree, targetWorktree, env } = options;
  await removeTemplateUpgradeWorktree(repository, targetWorktree, env);
  runGitText(
    repository,
    ["worktree", "move", "--force", "--force", sourceWorktree, targetWorktree],
    {
      code: "worktree_move_failed",
      message: `cannot move merge worktree into ${targetWorktree}`,
      repair: `inspect git -C ${repository} worktree list, then rerun`,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
}

export async function assertWorktreePathsNotSymlinks(
  options: WorktreePathsRequest,
): Promise<void> {
  await assertNotSymlinkPath(options.worktreesRoot, ".worktrees");
  await assertNotSymlinkPath(
    options.temporaryWorktree,
    ".worktrees/template-upgrade-tmp",
  );
  await assertNotSymlinkPath(
    options.targetWorktree,
    `.worktrees/template-upgrade-${options.targetCommit.slice(0, 7)}`,
  );
}

export async function assertTargetWorktreeMatchesHead(
  options: TargetWorktreeHeadRequest,
): Promise<void> {
  const { repository, repositoryHead, targetWorktree, env } = options;
  const record = await assertWorktreePathAvailableForTemplateUpgrade(
    repository,
    targetWorktree,
    env,
  );
  if (record === undefined) {
    return;
  }
  const stats = await lstatIfPresent(targetWorktree);
  if (stats === undefined) {
    return;
  }
  const worktreeHead = stats.isDirectory()
    ? await readWorktreeOwnHead(targetWorktree, env)
    : undefined;
  if (worktreeHead === repositoryHead) {
    return;
  }
  const headDetail =
    worktreeHead === undefined
      ? "is not a readable git worktree at the current HEAD"
      : `is at commit ${worktreeHead.slice(0, 7)}, not current HEAD ${repositoryHead.slice(0, 7)}`;
  throw new CliError(
    "worktree_exists_other_head",
    `leftover worktree ${targetWorktree} ${headDetail}`,
    `copy what you need out of ${targetWorktree}, then run git worktree unlock ${targetWorktree} and git worktree remove --force ${targetWorktree} in ${repository}, then rerun`,
    4,
    false,
  );
}

function describeWorktreeStateBlock(
  worktreePath: string,
  worktreeHead: string,
  expectedHead: string,
  env: ProcessEnvMap,
): string | undefined {
  const branchRef = runGitCommand(
    worktreePath,
    ["symbolic-ref", "--quiet", "--short", "HEAD"],
    { env },
  );
  if (branchRef.timedOut) {
    return "its branch state could not be verified";
  }
  if (branchRef.exitCode === 0) {
    return `it is checked out on branch ${UTF8.decode(branchRef.stdout).trim()}`;
  }
  const statusText = readGitOutput(
    worktreePath,
    ["status", "--porcelain=v1", "--untracked-files=all"],
    env,
  );
  if (statusText === undefined) {
    return "its working tree status could not be verified";
  }
  const hasChanges = statusText !== "";
  if (worktreeHead !== expectedHead) {
    const headShort = worktreeHead.slice(0, 7);
    const expectedShort = expectedHead.slice(0, 7);
    return hasChanges
      ? `it is at commit ${headShort} (not ${expectedShort}) and has uncommitted changes`
      : `it is at commit ${headShort}, not ${expectedShort}`;
  }
  return hasChanges ? "it has uncommitted changes" : undefined;
}

function describeLeftoverLockBlock(
  record: GitWorktreeRecord | undefined,
): string | undefined {
  if (record === undefined) {
    return "it is not a git worktree locked by template-upgrade";
  }
  if (isTemplateUpgradeLockedWorktree(record)) {
    return undefined;
  }
  return record.locked
    ? "it is locked for another reason, not template-upgrade"
    : "it is not locked by template-upgrade";
}

async function describeOwnedCheckoutBlock(
  options: LeftoverWorktreeRequest,
  isDirectory: boolean,
): Promise<string | undefined> {
  const { repository, worktreePath, expectedHead, env } = options;
  const gitMarker = isDirectory
    ? await lstatIfPresent(join(worktreePath, ".git"))
    : undefined;
  const repoCommonDir = readGitCommonDir(repository, env);
  const worktreeHead = gitMarker?.isFile()
    ? await readWorktreeOwnHead(worktreePath, env)
    : undefined;
  if (
    repoCommonDir === undefined ||
    worktreeHead === undefined ||
    readGitCommonDir(worktreePath, env) !== repoCommonDir
  ) {
    return "it is not a git worktree of this repository";
  }
  return describeWorktreeStateBlock(
    worktreePath,
    worktreeHead,
    expectedHead,
    env,
  );
}

async function describeLeftoverWorktreeBlock(
  options: LeftoverWorktreeRequest,
): Promise<{ readonly present: boolean; readonly reason?: string }> {
  const { repository, worktreePath, env } = options;
  const stats = await lstatIfPresent(worktreePath);
  if (stats?.isSymbolicLink()) {
    return { present: true, reason: "it is a symbolic link" };
  }
  const record = findGitWorktreeRecord(repository, worktreePath, env);
  if (stats === undefined && record === undefined) {
    return { present: false };
  }
  const lockBlock = describeLeftoverLockBlock(record);
  if (lockBlock !== undefined) {
    return { present: true, reason: lockBlock };
  }
  if (stats === undefined) {
    return { present: true };
  }
  const checkoutBlock = await describeOwnedCheckoutBlock(
    options,
    stats.isDirectory(),
  );
  return checkoutBlock === undefined
    ? { present: true }
    : { present: true, reason: checkoutBlock };
}

export async function removeTemplateUpgradeLeftoverWorktree(
  options: LeftoverWorktreeRequest,
): Promise<string | undefined> {
  const inspection = await describeLeftoverWorktreeBlock(options);
  if (!inspection.present) {
    return undefined;
  }
  if (inspection.reason !== undefined) {
    return `Leftover worktree ${options.worktreePath} was left untouched because ${inspection.reason}.`;
  }
  await removeTemplateUpgradeWorktree(
    options.repository,
    options.worktreePath,
    options.env,
  );
  return undefined;
}
