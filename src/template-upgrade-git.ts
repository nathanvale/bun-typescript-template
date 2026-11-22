import { realpathSync } from "node:fs";
import { lstat, mkdtemp, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { CliError } from "./cli-error.ts";

const GIT_LOCATION_VARIABLES: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

const DEFAULT_GIT_TIMEOUT_MS = 10_000;
const FULL_COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export const TEMPLATE_UPGRADE_FLOOR =
  "46e0f6659f879b45b68ef64d1d3a72f229b7b3bd";

export interface GitCommandResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly timedOut: boolean;
}

export interface GitRefusal {
  readonly code: string;
  readonly message: string;
  readonly repair: string;
  readonly exitCode?: number;
  readonly retrySafe?: boolean;
}

export function withoutGitLocation(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([name]) => !GIT_LOCATION_VARIABLES.includes(name),
    ),
  );
}

function isNodeModulesBinaryFolder(entry: string): boolean {
  return (
    basename(entry) === ".bin" && basename(dirname(entry)) === "node_modules"
  );
}

export function toolchainEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const entries = (env.PATH ?? "")
    .split(delimiter)
    .filter((entry) => !isNodeModulesBinaryFolder(entry));
  return {
    ...withoutGitLocation(env),
    PATH: entries.join(delimiter),
  };
}

export function decodeUtf8Strict(bytes: Uint8Array, label: string): string {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    throw new CliError(
      "invalid_utf8",
      `${label} is not valid UTF-8 text`,
      `fix or replace ${label} with valid UTF-8 text, then rerun`,
      1,
      false,
    );
  }
}

export function runGitCommand(
  cwd: string,
  args: readonly string[],
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMilliseconds?: number;
  } = {},
): GitCommandResult {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_GIT_TIMEOUT_MS;
  const child = Bun.spawnSync(["git", "-C", cwd, ...args], {
    env: withoutGitLocation(options.env ?? process.env),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMilliseconds,
    killSignal: "SIGKILL",
  });
  return {
    exitCode: child.exitCode,
    stdout: new Uint8Array(child.stdout),
    stderr: new Uint8Array(child.stderr),
    timedOut: child.exitedDueToTimeout === true,
  };
}

export function runGitText(
  cwd: string,
  args: readonly string[],
  refusal: GitRefusal,
  options: {
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly timeoutMilliseconds?: number;
  } = {},
): string {
  const timeoutMilliseconds =
    options.timeoutMilliseconds ?? DEFAULT_GIT_TIMEOUT_MS;
  const result = runGitCommand(cwd, args, options);
  if (result.timedOut) {
    throw new CliError(
      refusal.code,
      `git ${args.join(" ")} did not finish within ${timeoutMilliseconds} ms`,
      refusal.repair,
      refusal.exitCode ?? 1,
      refusal.retrySafe ?? false,
    );
  }
  if (result.exitCode !== 0) {
    const detail = new TextDecoder("utf-8").decode(result.stderr).trim();
    const message =
      detail === "" ? refusal.message : `${refusal.message}: ${detail}`;
    throw new CliError(
      refusal.code,
      message,
      refusal.repair,
      refusal.exitCode ?? 1,
      refusal.retrySafe ?? false,
    );
  }
  return decodeUtf8Strict(result.stdout, `git ${args[0] ?? ""} output`).trim();
}

export function resolveTemplateCommit(
  templateRoot: string,
  targetRef: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const commit = runGitText(
    templateRoot,
    ["rev-parse", "--verify", `${targetRef}^{commit}`],
    {
      code: "target_ref_invalid",
      message: `cannot resolve template target ref "${targetRef}"`,
      repair: `pass --to with a commit, branch, or tag that exists in ${templateRoot}`,
      exitCode: 2,
      retrySafe: true,
    },
    { env },
  );
  if (!FULL_COMMIT_PATTERN.test(commit)) {
    throw new CliError(
      "target_ref_invalid",
      `template target ref "${targetRef}" did not resolve to a full commit`,
      `pass --to with a valid commit in ${templateRoot}`,
      2,
      true,
    );
  }
  return commit;
}

function isMissingEntryError(error: unknown): boolean {
  if (!(error instanceof Error) || !Object.hasOwn(error, "code")) {
    return false;
  }
  const code: unknown = Reflect.get(error, "code");
  return code === "ENOENT" || code === "ENOTDIR";
}

export async function lstatIfPresent(
  targetPath: string,
): Promise<Awaited<ReturnType<typeof lstat>> | undefined> {
  try {
    return await lstat(targetPath);
  } catch (error) {
    if (isMissingEntryError(error)) {
      return undefined;
    }
    throw error;
  }
}

function notGitRepositoryError(repository: string): CliError {
  return new CliError(
    "not_git_repository",
    `${repository} is not a git repository`,
    "pass --repository pointing at an existing git repository checkout",
    2,
    true,
  );
}

function requireGitWorkTreeRoot(
  repository: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  let realRepository: string;
  try {
    realRepository = realpathSync(repository);
  } catch {
    throw notGitRepositoryError(repository);
  }
  const inside = runGitCommand(
    realRepository,
    ["rev-parse", "--is-inside-work-tree"],
    { env },
  );
  if (
    inside.timedOut ||
    inside.exitCode !== 0 ||
    new TextDecoder("utf-8").decode(inside.stdout).trim() !== "true"
  ) {
    throw notGitRepositoryError(repository);
  }
  const topLevel = runGitCommand(
    realRepository,
    ["rev-parse", "--show-toplevel"],
    { env },
  );
  if (topLevel.timedOut || topLevel.exitCode !== 0) {
    throw notGitRepositoryError(repository);
  }
  const topLevelPath = realpathSync(
    decodeUtf8Strict(topLevel.stdout, "git top-level path").trim(),
  );
  if (topLevelPath !== realRepository) {
    throw new CliError(
      "not_git_repository",
      `${repository} is inside a git repository at ${topLevelPath}, not the repository root`,
      `pass --repository ${topLevelPath}`,
      2,
      true,
    );
  }
  return realRepository;
}

export function verifyGitRepository(
  repository: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const realRepository = requireGitWorkTreeRoot(repository, env);
  return runGitText(
    realRepository,
    ["rev-parse", "--verify", "HEAD^{commit}"],
    {
      code: "repository_head_missing",
      message: `${repository} has no committed HEAD`,
      repair: "commit the initial repository state before running upgrade",
      exitCode: 2,
      retrySafe: true,
    },
    { env },
  );
}

export function readCommittedBytesAt(
  repository: string,
  revision: string,
  filePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Uint8Array | undefined {
  const objectSpec = `${revision}:${filePath}`;
  const listed = runGitCommand(repository, ["cat-file", "-e", objectSpec], {
    env,
  });
  if (listed.timedOut) {
    throw new CliError(
      "repository_git_unreadable",
      `git timed out while checking ${objectSpec} in ${repository}`,
      `check git status in ${repository}, then rerun`,
      1,
      false,
    );
  }
  if (listed.exitCode !== 0) {
    return undefined;
  }
  const shown = runGitCommand(repository, ["show", objectSpec], {
    env,
  });
  if (shown.timedOut || shown.exitCode !== 0) {
    throw new CliError(
      "repository_git_unreadable",
      `cannot read ${objectSpec} from ${repository}`,
      `verify git history in ${repository}, then rerun`,
      1,
      false,
    );
  }
  return shown.stdout;
}

export function readCommittedBytes(
  repository: string,
  filePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Uint8Array | undefined {
  return readCommittedBytesAt(repository, "HEAD", filePath, env);
}

export function gitCommitIdentityArgs(
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

function assertCommitAncestor(options: {
  readonly templateRoot: string;
  readonly ancestor: string;
  readonly descendant: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly timeoutMessage: string;
  readonly notAncestor: GitRefusal;
  readonly unreadablePrefix: string;
  readonly unreadableRepair: string;
}): void {
  const {
    templateRoot,
    ancestor,
    descendant,
    env,
    timeoutMessage,
    notAncestor,
    unreadablePrefix,
    unreadableRepair,
  } = options;
  const ancestry = runGitCommand(
    templateRoot,
    ["merge-base", "--is-ancestor", ancestor, descendant],
    { env },
  );
  if (ancestry.timedOut) {
    throw new CliError(
      "template_history_unreadable",
      timeoutMessage,
      "check the template checkout and rerun",
      1,
      false,
    );
  }
  if (ancestry.exitCode === 0) {
    return;
  }
  if (ancestry.exitCode === 1) {
    throw new CliError(
      notAncestor.code,
      notAncestor.message,
      notAncestor.repair,
      notAncestor.exitCode ?? 2,
      notAncestor.retrySafe ?? true,
    );
  }
  const detail = new TextDecoder("utf-8").decode(ancestry.stderr).trim();
  throw new CliError(
    "template_history_unreadable",
    `${unreadablePrefix}: ${detail}`,
    unreadableRepair,
    1,
    false,
  );
}

export function verifyTemplateAncestry(
  templateRoot: string,
  baseCommit: string,
  targetCommit: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  const baseType = runGitCommand(templateRoot, ["cat-file", "-t", baseCommit], {
    env,
  });
  if (
    baseType.timedOut ||
    baseType.exitCode !== 0 ||
    new TextDecoder("utf-8").decode(baseType.stdout).trim() !== "commit"
  ) {
    throw new CliError(
      "base_commit_missing",
      `base commit ${baseCommit} is not in this template checkout's history`,
      "fetch the full template history with git fetch --unshallow or run upgrade from a template clone that contains the base commit",
      1,
      true,
    );
  }
  const floorShort = TEMPLATE_UPGRADE_FLOOR.slice(0, 7);
  assertCommitAncestor({
    templateRoot,
    ancestor: TEMPLATE_UPGRADE_FLOOR,
    descendant: baseCommit,
    env,
    timeoutMessage: `git timed out checking template upgrade floor ${floorShort} against ${baseCommit}`,
    notAncestor: {
      code: "base_commit_unsupported",
      message: `base commit ${baseCommit.slice(0, 7)} is older than the oldest supported template upgrade base ${floorShort}; older template commits required --profile in bootstrap`,
      repair:
        "regenerate the repository from a newer template commit, or carry changes by hand",
      exitCode: 2,
      retrySafe: true,
    },
    unreadablePrefix: `cannot verify template upgrade floor ${floorShort} against ${baseCommit}`,
    unreadableRepair:
      "fetch complete history in the template checkout with git fetch --unshallow, then rerun",
  });
  assertCommitAncestor({
    templateRoot,
    ancestor: baseCommit,
    descendant: targetCommit,
    env,
    timeoutMessage: `git timed out checking ancestry from ${baseCommit} to ${targetCommit}`,
    notAncestor: {
      code: "target_not_descendant",
      message: `target commit ${targetCommit} is not a descendant of base commit ${baseCommit}; downgrades and divergent targets are refused`,
      repair: `choose a --to commit that descends from ${baseCommit.slice(0, 7)}`,
      exitCode: 2,
      retrySafe: true,
    },
    unreadablePrefix: `cannot verify ancestry from ${baseCommit} to ${targetCommit}`,
    unreadableRepair:
      "fetch complete history in the template checkout, then rerun",
  });
}

export function gitMergeFile(
  oursPath: string,
  basePath: string,
  nextPath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): "clean" | "conflict" {
  const child = Bun.spawnSync(
    [
      "git",
      "merge-file",
      "-L",
      "ours",
      "-L",
      "old",
      "-L",
      "new",
      "--",
      oursPath,
      basePath,
      nextPath,
    ],
    {
      env: withoutGitLocation(env),
      stdout: "pipe",
      stderr: "pipe",
      timeout: DEFAULT_GIT_TIMEOUT_MS,
      killSignal: "SIGKILL",
    },
  );
  if (child.exitedDueToTimeout) {
    throw new CliError(
      "merge_file_failed",
      `git merge-file timed out on ${oursPath}`,
      "rerun the command and inspect the file if it persists",
      1,
      false,
    );
  }
  if (child.exitCode === 0) {
    return "clean";
  }
  if (child.exitCode > 0 && child.exitCode <= 127) {
    return "conflict";
  }
  const detail = new TextDecoder("utf-8").decode(child.stderr).trim();
  throw new CliError(
    "merge_file_failed",
    `git merge-file failed on ${oursPath}: ${detail}`,
    "verify git is available and the files are readable, then rerun",
    1,
    false,
  );
}

async function prepareDiffSide(
  candidatePath: string,
  fallbackFile: string,
): Promise<{ readonly path: string; readonly present: boolean }> {
  const stats = await lstatIfPresent(candidatePath);
  if (stats === undefined) {
    await writeFile(fallbackFile, "");
    return { path: fallbackFile, present: false };
  }
  if (stats.isSymbolicLink()) {
    await writeFile(
      fallbackFile,
      `symlink -> ${await readlink(candidatePath)}\n`,
    );
    return { path: fallbackFile, present: true };
  }
  return { path: candidatePath, present: true };
}

function normalizeNoIndexDiff(
  rawDiff: string,
  relativePath: string,
  oldPresent: boolean,
  newPresent: boolean,
): string {
  const oldHeader = oldPresent ? `old/${relativePath}` : "absent";
  const newHeader = newPresent ? `new/${relativePath}` : "absent";
  return rawDiff
    .split("\n")
    .map((line) => {
      if (line.startsWith("diff --git ")) {
        return `diff --git old/${relativePath} new/${relativePath}`;
      }
      if (line.startsWith("--- ")) {
        return `--- ${oldHeader}`;
      }
      if (line.startsWith("+++ ")) {
        return `+++ ${newHeader}`;
      }
      if (line.startsWith("Binary files ")) {
        return `Binary files ${oldHeader} and ${newHeader} differ`;
      }
      return line;
    })
    .join("\n")
    .trimEnd();
}

export async function gitDiffFiles(options: {
  readonly oldPath: string;
  readonly newPath: string;
  readonly relativePath: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): Promise<string> {
  const { oldPath, newPath, relativePath, env = process.env } = options;
  const scratch = await mkdtemp(join(tmpdir(), "template-upgrade-diff-"));
  try {
    const [left, right] = await Promise.all([
      prepareDiffSide(oldPath, join(scratch, "old")),
      prepareDiffSide(newPath, join(scratch, "new")),
    ]);
    const child = Bun.spawnSync(
      ["git", "diff", "--no-index", "--no-color", "--", left.path, right.path],
      {
        env: withoutGitLocation(env),
        stdout: "pipe",
        stderr: "pipe",
        timeout: DEFAULT_GIT_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    if (child.exitedDueToTimeout) {
      throw new CliError(
        "diff_files_failed",
        `git diff timed out on ${relativePath}`,
        "rerun the command and inspect the file if it persists",
        1,
        false,
      );
    }
    if (child.exitCode !== 0 && child.exitCode !== 1) {
      const detail = new TextDecoder("utf-8").decode(child.stderr).trim();
      throw new CliError(
        "diff_files_failed",
        `git diff failed on ${relativePath}: ${detail}`,
        "verify git is available and the regenerated copies are readable, then rerun",
        1,
        false,
      );
    }
    const raw = new TextDecoder("utf-8").decode(child.stdout);
    return normalizeNoIndexDiff(raw, relativePath, left.present, right.present);
  } finally {
    await rm(scratch, { force: true, recursive: true });
  }
}

export async function removeWorktreeIfPresent(
  repository: string,
  worktreePath: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<void> {
  runGitCommand(
    repository,
    ["worktree", "remove", "--force", "--force", worktreePath],
    { env, timeoutMilliseconds: 30_000 },
  );
  await rm(worktreePath, { force: true, recursive: true });
  runGitCommand(repository, ["worktree", "prune"], { env });
}
