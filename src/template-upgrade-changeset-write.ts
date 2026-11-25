import { readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { CliError } from "./cli-error.ts";
import { parseGitTreeEntries } from "./git-identities.ts";
import { CHANGESET_FOLDER } from "./recipe.ts";
import {
  changesetPackageLevel,
  repositoryPackageChangeset,
} from "./template-upgrade-changesets.ts";
import {
  formatCommandPath,
  lstatIfPresent,
  type ProcessEnvMap,
  runGitCommand,
} from "./template-upgrade-git.ts";
import {
  assertNotSymlinkPath,
  compareCodeUnits,
  readGitOutput,
  readTextIfFile,
  readWorktreePaths,
  resolveRefIfPresent,
  runBunStep,
} from "./template-upgrade-worktree.ts";

const CHANGESET_PREFIX = `${CHANGESET_FOLDER}/`;
const CHANGESET_CONFIG_FILE = "config.json";
const PACKAGE_FILE = "package.json";
const DEFAULT_BASE_BRANCH = "main";
const CHANGESET_TIMEOUT_MS = 30_000;
const CONFLICT_MARKER = /^<<<<<<< ours\b/m;

export interface TemplateUpgradeChangesetPlan {
  readonly path: string;
  readonly level: "patch";
  readonly summary: string;
}

export interface TemplateUpgradeChangesetOptions {
  readonly repository: string;
  readonly worktree: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly env: ProcessEnvMap;
}

export interface RepositoryChangesetOptions {
  readonly repository: string;
  readonly worktree: string;
  readonly fileName: string;
  readonly summary: string;
  readonly env: ProcessEnvMap;
  readonly changedPaths?: readonly string[];
}

interface ChangesetConfig {
  readonly baseBranch: string;
  readonly changedFilePatterns: readonly string[];
}

function isCandidateChangesetName(name: string): boolean {
  return name.endsWith(".md") && !name.includes("/") && name !== "README.md";
}

function parseChangesetConfig(
  text: string,
  worktree: string,
  allowConflictFallback: boolean,
): ChangesetConfig {
  const configPath = `${CHANGESET_PREFIX}${CHANGESET_CONFIG_FILE}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    if (allowConflictFallback && CONFLICT_MARKER.test(text)) {
      return { baseBranch: DEFAULT_BASE_BRANCH, changedFilePatterns: [] };
    }
    throw new CliError(
      "changeset_config_invalid",
      `${configPath} in ${worktree} is not valid JSON`,
      `fix ${configPath} so it is a valid JSON object, then rerun`,
      1,
      false,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "changeset_config_invalid",
      `${configPath} in ${worktree} must be a JSON object`,
      `fix ${configPath} so it is a valid JSON object, then rerun`,
      1,
      false,
    );
  }
  const fields = new Map<string, unknown>(Object.entries(parsed));
  const rawBase = fields.get("baseBranch");
  const baseBranch =
    typeof rawBase === "string" && rawBase.trim() !== ""
      ? rawBase.trim()
      : DEFAULT_BASE_BRANCH;
  const rawPatterns = fields.get("changedFilePatterns");
  const changedFilePatterns = Array.isArray(rawPatterns)
    ? rawPatterns.filter(
        (entry): entry is string =>
          typeof entry === "string" && entry.trim() !== "",
      )
    : [];
  return { baseBranch, changedFilePatterns };
}

function matchesChangedFilePatterns(
  path: string,
  patterns: readonly string[],
): boolean {
  if (patterns.length === 0) {
    return false;
  }
  const positive: string[] = [];
  const negative: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith("!")) {
      const stripped = pattern.slice(1);
      if (stripped !== "") {
        negative.push(stripped);
      }
    } else {
      positive.push(pattern);
    }
  }
  if (!positive.some((pattern) => new Bun.Glob(pattern).match(path))) {
    return false;
  }
  return !negative.some((pattern) => new Bun.Glob(pattern).match(path));
}

function isGatedChangesetPath(
  path: string,
  patterns: readonly string[],
): boolean {
  return (
    path === PACKAGE_FILE ||
    path.startsWith("src/") ||
    matchesChangedFilePatterns(path, patterns)
  );
}

async function listWorktreeChangesetFiles(
  worktree: string,
): Promise<readonly string[]> {
  const folderPath = join(worktree, CHANGESET_FOLDER);
  await assertNotSymlinkPath(folderPath, CHANGESET_FOLDER);
  const stats = await lstatIfPresent(folderPath);
  if (stats === undefined || !stats.isDirectory()) {
    return [];
  }
  const entries = await readdir(folderPath, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    if (
      !entry.isSymbolicLink() &&
      entry.isFile() &&
      isCandidateChangesetName(entry.name)
    ) {
      files.push(entry.name);
    }
  }
  return files.sort(compareCodeUnits);
}

function listHeadChangesetPaths(
  worktree: string,
  env: ProcessEnvMap,
): ReadonlySet<string> {
  const result = runGitCommand(
    worktree,
    ["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--", CHANGESET_FOLDER],
    { env },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = new TextDecoder("utf-8").decode(result.stderr).trim();
    throw new CliError(
      "changesets_unreadable",
      `cannot list ${CHANGESET_PREFIX} at HEAD in ${worktree}${detail === "" ? "" : `: ${detail}`}`,
      `inspect ${formatCommandPath(worktree)} with git ls-tree HEAD -- ${CHANGESET_FOLDER}, then rerun`,
      1,
      false,
    );
  }
  return new Set(parseGitTreeEntries(Buffer.from(result.stdout)).keys());
}

async function hasAddedWorktreeChangeset(
  worktree: string,
  packageName: string,
  env: ProcessEnvMap,
): Promise<boolean> {
  const headPaths = listHeadChangesetPaths(worktree, env);
  const currentFiles = await listWorktreeChangesetFiles(worktree);
  for (const file of currentFiles) {
    const relativePath = `${CHANGESET_PREFIX}${file}`;
    if (headPaths.has(relativePath)) {
      continue;
    }
    const text = await readTextIfFile(join(worktree, CHANGESET_FOLDER, file));
    if (
      text !== undefined &&
      changesetPackageLevel(text, relativePath, packageName)
    ) {
      return true;
    }
  }
  return false;
}

function hasCommittedChangesetSinceBase(
  repository: string,
  baseBranch: string,
  packageName: string,
  env: ProcessEnvMap,
): boolean {
  const baseRef =
    resolveRefIfPresent(repository, `origin/${baseBranch}`, env) ??
    resolveRefIfPresent(repository, baseBranch, env);
  if (baseRef === undefined) {
    return false;
  }
  const head = resolveRefIfPresent(repository, "HEAD", env);
  if (head === undefined) {
    return false;
  }
  const mergeBase = readGitOutput(
    repository,
    ["merge-base", baseRef, head],
    env,
  );
  if (mergeBase === undefined || mergeBase === head) {
    return false;
  }
  return repositoryPackageChangeset(
    repository,
    mergeBase,
    head,
    packageName,
    env,
  );
}

function packageMissingError(message: string, repair: string): CliError {
  return new CliError("changeset_package_missing", message, repair, 1, false);
}

function parsePackageJsonFields(
  packageText: string,
  root: string,
  allowConflictFallback: boolean,
): Map<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    if (allowConflictFallback && CONFLICT_MARKER.test(packageText)) {
      return undefined;
    }
    throw packageMissingError(
      `${PACKAGE_FILE} in ${root} is not valid JSON`,
      `fix ${PACKAGE_FILE} so it is a valid JSON object with a non-empty "name", then rerun`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw packageMissingError(
      `${PACKAGE_FILE} in ${root} must be a JSON object`,
      `fix ${PACKAGE_FILE} so it is a valid JSON object with a non-empty "name", then rerun`,
    );
  }
  return new Map<string, unknown>(Object.entries(parsed));
}

async function readPackageNameFromRoot(
  root: string,
  allowConflictFallback: boolean,
): Promise<string | undefined> {
  const packageText = await readTextIfFile(join(root, PACKAGE_FILE));
  if (packageText === undefined) {
    throw packageMissingError(
      `cannot read ${PACKAGE_FILE} in ${root} to write a changeset`,
      `restore ${PACKAGE_FILE} with a non-empty "name", then rerun`,
    );
  }
  const fields = parsePackageJsonFields(
    packageText,
    root,
    allowConflictFallback,
  );
  if (fields === undefined) {
    return undefined;
  }
  const name = fields.get("name");
  if (typeof name !== "string" || name.trim() === "") {
    throw packageMissingError(
      `${PACKAGE_FILE} in ${root} does not have a non-empty string "name"`,
      `set a non-empty "name" in ${PACKAGE_FILE}, then rerun`,
    );
  }
  return name;
}

async function readWorktreePackageName(
  worktree: string,
  repository: string,
  allowConflictFallback: boolean,
): Promise<string> {
  const fromWorktree = await readPackageNameFromRoot(
    worktree,
    allowConflictFallback,
  );
  if (fromWorktree !== undefined) {
    return fromWorktree;
  }
  const fromRepository = await readPackageNameFromRoot(repository, false);
  if (fromRepository === undefined) {
    throw packageMissingError(
      `cannot read ${PACKAGE_FILE} in ${repository} to write a changeset`,
      `restore ${PACKAGE_FILE} with a non-empty "name", then rerun`,
    );
  }
  return fromRepository;
}

async function readRepositoryChangesetConfig(
  worktree: string,
  allowConflictFallback: boolean,
): Promise<ChangesetConfig | undefined> {
  await assertNotSymlinkPath(
    join(worktree, CHANGESET_FOLDER),
    CHANGESET_FOLDER,
  );
  const configText = await readTextIfFile(
    join(worktree, CHANGESET_FOLDER, CHANGESET_CONFIG_FILE),
  );
  return configText === undefined
    ? undefined
    : parseChangesetConfig(configText, worktree, allowConflictFallback);
}

async function resolveRepositoryChangesetPlan(
  options: RepositoryChangesetOptions,
  allowConflictFallback: boolean,
): Promise<
  | {
      readonly plan: TemplateUpgradeChangesetPlan;
      readonly packageName: string;
    }
  | undefined
> {
  const { repository, worktree, fileName, summary, env } = options;
  const config = await readRepositoryChangesetConfig(
    worktree,
    allowConflictFallback,
  );
  if (config === undefined) {
    return undefined;
  }
  const changedPaths = options.changedPaths ?? readWorktreePaths(worktree, env);
  if (
    !changedPaths.some((path) =>
      isGatedChangesetPath(path, config.changedFilePatterns),
    )
  ) {
    return undefined;
  }
  const packageName = await readWorktreePackageName(
    worktree,
    repository,
    allowConflictFallback,
  );
  const covered =
    (await hasAddedWorktreeChangeset(worktree, packageName, env)) ||
    hasCommittedChangesetSinceBase(
      repository,
      config.baseBranch,
      packageName,
      env,
    );
  if (covered) {
    return undefined;
  }
  return {
    plan: Object.freeze({
      path: `${CHANGESET_PREFIX}${fileName}`,
      level: "patch" as const,
      summary,
    }),
    packageName,
  };
}

export async function planRepositoryChangeset(
  options: RepositoryChangesetOptions,
): Promise<TemplateUpgradeChangesetPlan | undefined> {
  const resolved = await resolveRepositoryChangesetPlan(options, true);
  return resolved?.plan;
}

export async function writeRepositoryChangeset(
  options: RepositoryChangesetOptions,
): Promise<
  (TemplateUpgradeChangesetPlan & { readonly createdPath?: string }) | undefined
> {
  const resolved = await resolveRepositoryChangesetPlan(options, false);
  if (resolved === undefined) {
    return undefined;
  }
  const { plan, packageName } = resolved;
  const { worktree, env } = options;
  const beforeFiles = new Set(await listWorktreeChangesetFiles(worktree));
  const run = runBunStep({
    worktree,
    args: [
      "run",
      "--bun",
      "changeset",
      "add",
      "--patch",
      packageName,
      "-m",
      plan.summary,
    ],
    timeoutMilliseconds: CHANGESET_TIMEOUT_MS,
    env,
  });
  if (!run.ok) {
    const detail = run.output === "" ? "" : `: ${run.output}`;
    throw new CliError(
      "changeset_add_failed",
      `cannot write changeset ${plan.path} with changeset add${detail}`,
      `ensure dependencies are installed in ${formatCommandPath(worktree)} or add ${plan.path} with bun run --bun changeset add --patch ${packageName} -m ${JSON.stringify(plan.summary)}, then rerun`,
      1,
      false,
    );
  }
  const afterFiles = await listWorktreeChangesetFiles(worktree);
  const addedFiles = afterFiles.filter((file) => !beforeFiles.has(file));
  if (addedFiles.length !== 1) {
    const listed = addedFiles.length === 0 ? "" : ` (${addedFiles.join(", ")})`;
    throw new CliError(
      "changeset_add_unexpected_files",
      `expected changeset add to create 1 file under ${CHANGESET_PREFIX}, found ${addedFiles.length}${listed}`,
      `inspect ${formatCommandPath(join(worktree, CHANGESET_FOLDER))}, remove unexpected changeset files or add ${plan.path}, then rerun`,
      1,
      false,
    );
  }
  const [createdFile] = addedFiles;
  const targetFile = basename(plan.path);
  let createdPath: string | undefined;
  if (createdFile !== undefined && createdFile !== targetFile) {
    createdPath = `${CHANGESET_PREFIX}${createdFile}`;
    const sourcePath = join(worktree, CHANGESET_FOLDER, createdFile);
    const targetPath = join(worktree, CHANGESET_FOLDER, targetFile);
    await assertNotSymlinkPath(sourcePath, createdPath);
    await assertNotSymlinkPath(targetPath, plan.path);
    await rename(sourcePath, targetPath);
  }
  return createdPath === undefined
    ? plan
    : Object.freeze({ ...plan, createdPath });
}

function upgradeChangesetOptions(
  options: TemplateUpgradeChangesetOptions,
): RepositoryChangesetOptions {
  const base7 = options.baseCommit.slice(0, 7);
  const target7 = options.targetCommit.slice(0, 7);
  return {
    repository: options.repository,
    worktree: options.worktree,
    fileName: `template-upgrade-${target7}.md`,
    summary: `Upgraded template ${base7} to ${target7}`,
    env: options.env,
  };
}

export async function planTemplateUpgradeChangeset(
  options: TemplateUpgradeChangesetOptions,
): Promise<TemplateUpgradeChangesetPlan | undefined> {
  return await planRepositoryChangeset(upgradeChangesetOptions(options));
}

export async function writeTemplateUpgradeChangeset(
  options: TemplateUpgradeChangesetOptions,
): Promise<TemplateUpgradeChangesetPlan | undefined> {
  return await writeRepositoryChangeset(upgradeChangesetOptions(options));
}
