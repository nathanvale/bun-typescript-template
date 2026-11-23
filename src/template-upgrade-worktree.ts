import type { Dirent } from "node:fs";
import { constants, realpathSync } from "node:fs";
import { open, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";
import { type ChangeNoteEntry, formatChangeNoteLines } from "./change-notes.ts";
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
  changeNotes: readonly ChangeNoteEntry[] = [],
): string {
  const subject = `Upgrade template ${baseCommit.slice(0, 7)} to ${targetCommit.slice(0, 7)}`;
  if (changeNotes.length === 0) {
    return subject;
  }
  const lines = formatChangeNoteLines(changeNotes);
  return `${subject}\n\nChange notes (${changeNotes.length}):\n${lines.join("\n")}`;
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

export interface TemplateUpgradeBunResult {
  readonly ok: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signalCode: string | null;
  readonly output: string;
}

export function runWorktreeStep(options: {
  readonly worktree: string;
  readonly command: readonly [string, ...string[]];
  readonly label: string;
  readonly timeoutMilliseconds: number;
  readonly env: ProcessEnvMap;
}): TemplateUpgradeBunResult {
  const { worktree, command, label, timeoutMilliseconds, env } = options;
  const child = Bun.spawnSync([...command], {
    cwd: worktree,
    env: toolchainEnvironment(env),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMilliseconds,
    killSignal: "SIGKILL",
  });
  const combined =
    `${UTF8.decode(child.stdout)}${UTF8.decode(child.stderr)}`.trim();
  const signalCode =
    typeof child.signalCode === "string" ? child.signalCode : null;
  if (child.exitedDueToTimeout) {
    return {
      ok: false,
      exitCode: null,
      timedOut: true,
      signalCode: signalCode ?? "SIGKILL",
      output: `${label} did not finish within ${timeoutMilliseconds} ms${combined === "" ? "" : `\n${combined}`}`,
    };
  }
  const exitCode = typeof child.exitCode === "number" ? child.exitCode : null;
  return {
    ok: exitCode === 0 && signalCode === null,
    exitCode,
    timedOut: false,
    signalCode,
    output: combined,
  };
}

export function runBunStep(options: {
  readonly worktree: string;
  readonly args: readonly string[];
  readonly timeoutMilliseconds: number;
  readonly env: ProcessEnvMap;
}): TemplateUpgradeBunResult {
  const { worktree, args, timeoutMilliseconds, env } = options;
  const toolEnv = toolchainEnvironment(env);
  const bunExecutable =
    Bun.which("bun", { PATH: toolEnv.PATH ?? "" }) ?? process.execPath;
  return runWorktreeStep({
    worktree,
    command: [bunExecutable, ...args],
    label: `bun ${args.join(" ")}`,
    timeoutMilliseconds,
    env,
  });
}
