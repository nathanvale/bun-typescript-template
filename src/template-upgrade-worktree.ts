import type { Dirent } from "node:fs";
import { readdir, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./cli-error.ts";
import {
  lstatIfPresent,
  runGitCommand,
  runGitText,
  toolchainEnvironment,
} from "./template-upgrade-git.ts";

const WORKTREE_TIMEOUT_MS = 30_000;
const IGNORED_TREE_ENTRIES = new Set([".git", "node_modules", ".worktrees"]);
const CONFLICT_MARKER_PATTERN = /^<<<<<<< ours\r?$/m;

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
  return await readFile(filePath, "utf8");
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
      result.set(relativePath, new Uint8Array(await readFile(fullPath)));
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
  const bytes = new Uint8Array(await readFile(fullPath));
  if (bytes.includes(0)) {
    return false;
  }
  return CONFLICT_MARKER_PATTERN.test(new TextDecoder("utf-8").decode(bytes));
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
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const result = runGitCommand(
    repository,
    ["rev-parse", "--quiet", "--verify", ref],
    { env },
  );
  if (result.timedOut || result.exitCode !== 0) {
    return undefined;
  }
  return new TextDecoder("utf-8").decode(result.stdout).trim();
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

function commitIdentityArgs(
  worktree: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const hasName =
    (env.GIT_AUTHOR_NAME !== undefined && env.GIT_AUTHOR_NAME !== "") ||
    runGitCommand(worktree, ["config", "--get", "user.name"], { env })
      .exitCode === 0;
  const hasEmail =
    (env.GIT_AUTHOR_EMAIL !== undefined && env.GIT_AUTHOR_EMAIL !== "") ||
    runGitCommand(worktree, ["config", "--get", "user.email"], { env })
      .exitCode === 0;
  const args: string[] = [];
  if (!hasName) {
    args.push("-c", "user.name=template-upgrade");
  }
  if (!hasEmail) {
    args.push("-c", "user.email=template-upgrade@local");
  }
  return args;
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
  env: Readonly<Record<string, string | undefined>>,
): void {
  if (presentPaths.length > 0) {
    runGitText(
      worktree,
      ["add", "--", ...presentPaths],
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
      ["rm", "--quiet", "--", ...deletedPaths],
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
  readonly env: Readonly<Record<string, string | undefined>>;
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
    ...commitIdentityArgs(worktree, env),
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
  readonly env: Readonly<Record<string, string | undefined>>;
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
  const stdout = new TextDecoder("utf-8").decode(child.stdout);
  const stderr = new TextDecoder("utf-8").decode(child.stderr);
  const combined = `${stdout}${stderr}`.trim();
  if (child.exitedDueToTimeout) {
    return {
      ok: false,
      output: `bun ${args.join(" ")} did not finish within ${timeoutMilliseconds} ms${combined === "" ? "" : `\n${combined}`}`,
    };
  }
  return { ok: child.exitCode === 0, output: combined };
}
