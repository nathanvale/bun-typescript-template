import type { Dirent } from "node:fs";
import { constants, realpathSync } from "node:fs";
import { open, readdir, readFile, readlink, rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  gitCommitIdentityArgs,
  lstatIfPresent,
  runGitCommand,
  runGitText,
  toolchainEnvironment,
  type ProcessEnvMap,
} from "./template-upgrade-git.ts";

const WORKTREE_TIMEOUT_MS = 30_000;
const IGNORED_TREE_ENTRIES = new Set([".git", "node_modules", ".worktrees"]);
const CONFLICT_MARKER_PATTERN = /^(?:<<<<<<< ours|>>>>>>> new)(?: .*)?\r?$/m;
const UTF8 = new TextDecoder("utf-8");

export function readGitOutput(
  cwd: string,
  args: readonly string[],
  env: ProcessEnvMap,
): string | undefined {
  const result = runGitCommand(cwd, args, { env });
  return result.timedOut || result.exitCode !== 0
    ? undefined
    : UTF8.decode(result.stdout).trim();
}

export async function assertNotSymlinkPath(
  fullPath: string,
  displayPath: string,
): Promise<void> {
  const stats = await lstatIfPresent(fullPath);
  if (stats !== undefined && stats.isSymbolicLink()) {
    throw new CliError(
      "symlink_ancestor",
      `refused to follow symbolic link at ${displayPath}`,
      `replace or remove symbolic link ${displayPath}, commit the change if tracked, then rerun`,
      2,
      true,
    );
  }
}

export async function assertNoSymlinkAncestors(
  root: string,
  relativePath: string,
): Promise<void> {
  const segments = relativePath.split("/");
  for (let index = 0; index < segments.length - 1; index += 1) {
    const ancestor = segments.slice(0, index + 1).join("/");
    const stats = await lstatIfPresent(join(root, ancestor));
    if (stats === undefined) {
      return;
    }
    if (stats.isSymbolicLink()) {
      throw new CliError(
        "symlink_ancestor",
        `symbolic link ancestor "${ancestor}" blocks path "${relativePath}"`,
        `replace symbolic link "${ancestor}" with a regular folder (or remove it), commit the change if tracked, then rerun`,
        2,
        true,
      );
    }
    if (!stats.isDirectory()) {
      return;
    }
  }
}

export async function readPlainFileBytes(
  fullPath: string,
): Promise<Uint8Array> {
  const flags =
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  const handle = await open(fullPath, flags);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new CliError(
        "unreadable_file",
        `expected a regular file at ${fullPath}`,
        `replace ${fullPath} with a regular file, then rerun`,
        1,
        false,
      );
    }
    return new Uint8Array(await handle.readFile());
  } finally {
    await handle.close();
  }
}

export function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function templateUpgradeBranchName(
  baseCommit: string,
  targetCommit: string,
): string {
  return `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
}

export function templateUpgradeCommitMessage(
  baseCommit: string,
  targetCommit: string,
): string {
  return `Upgrade template ${baseCommit.slice(0, 7)} to ${targetCommit.slice(0, 7)}`;
}

export function templateUpgradeWorktreePaths(
  repository: string,
  targetCommit: string,
) {
  const worktreesRoot = join(repository, ".worktrees");
  return {
    worktreesRoot,
    temporaryWorktree: join(worktreesRoot, "template-upgrade-tmp"),
    targetWorktree: join(
      worktreesRoot,
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    ),
  };
}

export async function readTextIfFile(
  filePath: string,
): Promise<string | undefined> {
  const stats = await lstatIfPresent(filePath);
  if (stats === undefined || !stats.isFile()) {
    return undefined;
  }
  return UTF8.decode(await readPlainFileBytes(filePath));
}

async function walkTreeEntries(
  root: string,
  onEntry: (
    entry: Dirent,
    relativePath: string,
    fullPath: string,
  ) => Promise<void>,
  prefix = "",
): Promise<void> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  for (const entry of entries) {
    if (prefix === "" && IGNORED_TREE_ENTRIES.has(entry.name)) {
      continue;
    }
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    const fullPath = join(root, relativePath);
    await onEntry(entry, relativePath, fullPath);
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await walkTreeEntries(root, onEntry, relativePath);
    }
  }
}

async function collectComparisonEntries(
  root: string,
): Promise<Map<string, string | Uint8Array>> {
  const result = new Map<string, string | Uint8Array>();
  await walkTreeEntries(root, async (entry, relativePath, fullPath) => {
    if (entry.isSymbolicLink()) {
      result.set(relativePath, `link:${await readlink(fullPath)}`);
    } else if (entry.isDirectory()) {
      result.set(relativePath, "dir");
    } else if (entry.isFile()) {
      result.set(relativePath, await readPlainFileBytes(fullPath));
    }
  });
  return result;
}

export async function treesEqual(
  leftRoot: string,
  rightRoot: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    collectComparisonEntries(leftRoot),
    collectComparisonEntries(rightRoot),
  ]);
  if (left.size !== right.size) {
    return false;
  }
  for (const [path, leftValue] of left) {
    const rightValue = right.get(path);
    if (rightValue === undefined) {
      return false;
    }
    if (typeof leftValue === "string" || typeof rightValue === "string") {
      if (leftValue !== rightValue) {
        return false;
      }
    } else if (Buffer.compare(leftValue, rightValue) !== 0) {
      return false;
    }
  }
  return true;
}

async function fileHasConflictMarker(fullPath: string): Promise<boolean> {
  const bytes = await readPlainFileBytes(fullPath);
  if (bytes.includes(0)) {
    return false;
  }
  return CONFLICT_MARKER_PATTERN.test(UTF8.decode(bytes));
}

export async function findConflictMarkerFiles(
  root: string,
): Promise<readonly string[]> {
  const found: string[] = [];
  await walkTreeEntries(root, async (entry, relativePath, fullPath) => {
    if (
      entry.isFile() &&
      !entry.isSymbolicLink() &&
      (await fileHasConflictMarker(fullPath))
    ) {
      found.push(relativePath);
    }
  });
  return Object.freeze(found.sort(compareCodeUnits));
}

export function resolveRefIfPresent(
  repository: string,
  ref: string,
  env: ProcessEnvMap,
): string | undefined {
  return readGitOutput(
    repository,
    ["rev-parse", "--quiet", "--verify", ref],
    env,
  );
}

export async function readWorktreeOwnHead(
  worktree: string,
  env: ProcessEnvMap,
): Promise<string | undefined> {
  const gitMarker = await lstatIfPresent(join(worktree, ".git"));
  if (gitMarker === undefined || gitMarker.isSymbolicLink()) {
    return undefined;
  }
  const topLevelText = readGitOutput(
    worktree,
    ["rev-parse", "--show-toplevel"],
    env,
  );
  if (topLevelText === undefined || topLevelText === "") {
    return undefined;
  }
  try {
    if (realpathSync(topLevelText) !== realpathSync(worktree)) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return resolveRefIfPresent(worktree, "HEAD", env);
}

function parseStatusPaths(stdout: Uint8Array): string[] {
  const tokens = new TextDecoder("utf-8", {
    fatal: true,
    ignoreBOM: true,
  })
    .decode(stdout)
    .split("\0");
  const paths: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === undefined || token === "") {
      continue;
    }
    const status = token.slice(0, 2);
    const path = token.slice(3);
    if (path !== "") {
      paths.push(path);
    }
    if (status[0] === "R" || status[0] === "C") {
      const previousPath = tokens[index + 1];
      if (previousPath !== undefined && previousPath !== "") {
        paths.push(previousPath);
      }
      index += 1;
    }
  }
  return [...new Set(paths)].sort(compareCodeUnits);
}

async function partitionChangedPaths(
  worktree: string,
  changedPaths: readonly string[],
): Promise<{
  readonly presentPaths: readonly string[];
  readonly deletedPaths: readonly string[];
}> {
  const presentPaths: string[] = [];
  const deletedPaths: string[] = [];
  for (const relativePath of changedPaths) {
    await assertNoSymlinkAncestors(worktree, relativePath);
    const entry = await lstatIfPresent(join(worktree, relativePath));
    if (entry === undefined) {
      deletedPaths.push(relativePath);
    } else {
      presentPaths.push(relativePath);
    }
  }
  return { presentPaths, deletedPaths };
}

function stageWorktreePaths(
  worktree: string,
  presentPaths: readonly string[],
  deletedPaths: readonly string[],
  env: ProcessEnvMap,
): void {
  if (presentPaths.length > 0) {
    runGitText(
      worktree,
      ["--literal-pathspecs", "add", "--", ...presentPaths],
      {
        code: "worktree_stage_failed",
        message: `cannot stage upgraded files in ${worktree}`,
        repair: `inspect ${worktree} with git status, then rerun`,
      },
      { env },
    );
  }
  if (deletedPaths.length > 0) {
    runGitText(
      worktree,
      [
        "--literal-pathspecs",
        "rm",
        "--cached",
        "--force",
        "--ignore-unmatch",
        "--quiet",
        "--",
        ...deletedPaths,
      ],
      {
        code: "worktree_stage_failed",
        message: `cannot stage deleted files in ${worktree}`,
        repair: `inspect ${worktree} with git status, then rerun`,
      },
      { env },
    );
  }
}

export async function stageAndCommitWorktree(options: {
  readonly worktree: string;
  readonly message: string;
  readonly env: ProcessEnvMap;
}): Promise<string> {
  const { worktree, message, env } = options;
  const status = runGitCommand(
    worktree,
    ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
    { env },
  );
  if (status.timedOut || status.exitCode !== 0) {
    throw new CliError(
      "worktree_status_failed",
      `cannot read git status in ${worktree}`,
      `inspect ${worktree} with git status, then rerun`,
      1,
      false,
    );
  }
  const changedPaths = parseStatusPaths(status.stdout);
  const { presentPaths, deletedPaths } = await partitionChangedPaths(
    worktree,
    changedPaths,
  );
  stageWorktreePaths(worktree, presentPaths, deletedPaths, env);
  const commitArgs = [
    ...gitCommitIdentityArgs(worktree, env),
    "commit",
    "--quiet",
    ...(changedPaths.length === 0 ? ["--allow-empty"] : []),
    "-m",
    message,
  ];
  runGitText(
    worktree,
    commitArgs,
    {
      code: "worktree_commit_failed",
      message: `cannot commit upgraded tree in ${worktree}`,
      repair: `inspect ${worktree} with git status, then rerun`,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  return runGitText(
    worktree,
    ["rev-parse", "HEAD"],
    {
      code: "worktree_commit_failed",
      message: `cannot read committed HEAD in ${worktree}`,
      repair: `inspect ${worktree} with git rev-parse HEAD`,
    },
    { env },
  );
}

export function runBunStep(options: {
  readonly worktree: string;
  readonly args: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly env: ProcessEnvMap;
}): { readonly ok: boolean; readonly output: string } {
  const { worktree, args, timeoutMilliseconds, env } = options;
  const toolEnv = toolchainEnvironment(env);
  const bunExecutable =
    Bun.which("bun", { PATH: toolEnv.PATH ?? "" }) ?? process.execPath;
  const child = Bun.spawnSync([bunExecutable, ...args], {
    cwd: worktree,
    env: toolEnv,
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMilliseconds,
    killSignal: "SIGKILL",
  });
  const combined =
    `${UTF8.decode(child.stdout)}${UTF8.decode(child.stderr)}`.trim();
  if (child.exitedDueToTimeout) {
    return {
      ok: false,
      output: `bun ${args.join(" ")} did not finish within ${timeoutMilliseconds} ms${combined === "" ? "" : `\n${combined}`}`,
    };
  }
  return { ok: child.exitCode === 0, output: combined };
}

function normalizeWorktreeTarget(targetPath: string): string {
  try {
    return realpathSync(targetPath);
  } catch {
    try {
      return join(realpathSync(dirname(targetPath)), basename(targetPath));
    } catch {
      return resolve(targetPath);
    }
  }
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

export async function removeWorktreeIfPresent(
  repository: string,
  worktreePath: string,
  env: ProcessEnvMap = process.env,
): Promise<void> {
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

export async function assertWorktreePathsNotSymlinks(options: {
  readonly worktreesRoot: string;
  readonly temporaryWorktree: string;
  readonly targetWorktree: string;
  readonly targetCommit: string;
}): Promise<void> {
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

export async function assertTargetWorktreeMatchesHead(options: {
  readonly repository: string;
  readonly repositoryHead: string;
  readonly targetCommit: string;
  readonly targetWorktree: string;
  readonly env: ProcessEnvMap;
}): Promise<void> {
  const { repository, repositoryHead, targetCommit, targetWorktree, env } =
    options;
  const stats = await lstatIfPresent(targetWorktree);
  if (stats === undefined) {
    return;
  }
  if (stats.isSymbolicLink()) {
    await assertNotSymlinkPath(
      targetWorktree,
      `.worktrees/template-upgrade-${targetCommit.slice(0, 7)}`,
    );
  }
  const worktreeHead = stats.isDirectory()
    ? await readWorktreeOwnHead(targetWorktree, env)
    : undefined;
  if (worktreeHead === repositoryHead) {
    return;
  }
  const headDetail =
    worktreeHead === undefined
      ? "is not a git worktree at the current HEAD"
      : `is at commit ${worktreeHead.slice(0, 7)}, not current HEAD ${repositoryHead.slice(0, 7)}`;
  throw new CliError(
    "worktree_exists_other_head",
    `leftover worktree ${targetWorktree} ${headDetail}`,
    `copy what you need out of ${targetWorktree}, then run git worktree remove --force ${targetWorktree} in ${repository}, then rerun`,
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

export interface LeftoverWorktreeRequest {
  readonly repository: string;
  readonly worktreePath: string;
  readonly expectedHead: string;
  readonly env: ProcessEnvMap;
}

async function describeLeftoverWorktreeBlock(
  options: LeftoverWorktreeRequest,
): Promise<string | undefined> {
  const { repository, worktreePath, expectedHead, env } = options;
  const stats = await lstatIfPresent(worktreePath);
  if (stats === undefined) {
    return undefined;
  }
  const gitMarker = stats.isDirectory()
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

export async function removeTemplateUpgradeLeftoverWorktree(
  options: LeftoverWorktreeRequest,
): Promise<string | undefined> {
  const reason = await describeLeftoverWorktreeBlock(options);
  if (reason !== undefined) {
    return `Leftover worktree ${options.worktreePath} was left untouched because ${reason}.`;
  }
  await removeWorktreeIfPresent(
    options.repository,
    options.worktreePath,
    options.env,
  );
  return undefined;
}
