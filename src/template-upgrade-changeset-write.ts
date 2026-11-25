import { readdir, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { CliError } from "./cli-error.ts";
import { parseGitTreeEntries } from "./git-identities.ts";
import { CHANGESET_FOLDER } from "./recipe.ts";
import { readRepositoryChangesets } from "./template-upgrade-changesets.ts";
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

export interface TemplateUpgradeChangesetPlan {
  readonly path: string;
  readonly packageName: string;
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

interface ChangesetConfig {
  readonly baseBranch: string;
  readonly changedFilePatterns: readonly string[];
}

function isCandidateChangesetName(name: string): boolean {
  return name.endsWith(".md") && !name.includes("/") && name !== "README.md";
}

function parseChangesetConfig(text: string): ChangesetConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { baseBranch: DEFAULT_BASE_BRANCH, changedFilePatterns: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { baseBranch: DEFAULT_BASE_BRANCH, changedFilePatterns: [] };
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

function isCoveredChangesetPath(
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
    return new Set<string>();
  }
  return new Set(parseGitTreeEntries(Buffer.from(result.stdout)).keys());
}

async function hasAddedWorktreeChangeset(
  worktree: string,
  env: ProcessEnvMap,
): Promise<boolean> {
  const headPaths = listHeadChangesetPaths(worktree, env);
  const currentFiles = await listWorktreeChangesetFiles(worktree);
  return currentFiles.some(
    (file) => !headPaths.has(`${CHANGESET_PREFIX}${file}`),
  );
}

function hasCommittedChangesetSinceBase(
  repository: string,
  baseBranch: string,
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
  const added = readRepositoryChangesets(repository, mergeBase, head, env);
  return added !== undefined && added.length > 0;
}

async function readWorktreePackageName(worktree: string): Promise<string> {
  const packageText = await readTextIfFile(join(worktree, PACKAGE_FILE));
  if (packageText === undefined) {
    throw new CliError(
      "changeset_package_missing",
      `cannot read ${PACKAGE_FILE} in ${worktree} to write an upgrade changeset`,
      `restore ${PACKAGE_FILE} with a non-empty "name", then rerun`,
      1,
      false,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    throw new CliError(
      "changeset_package_missing",
      `${PACKAGE_FILE} in ${worktree} is not valid JSON`,
      `fix ${PACKAGE_FILE} so it is a valid JSON object with a non-empty "name", then rerun`,
      1,
      false,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CliError(
      "changeset_package_missing",
      `${PACKAGE_FILE} in ${worktree} must be a JSON object`,
      `fix ${PACKAGE_FILE} so it is a valid JSON object with a non-empty "name", then rerun`,
      1,
      false,
    );
  }
  const name = new Map<string, unknown>(Object.entries(parsed)).get("name");
  if (typeof name !== "string" || name.trim() === "") {
    throw new CliError(
      "changeset_package_missing",
      `${PACKAGE_FILE} in ${worktree} does not have a non-empty string "name"`,
      `set a non-empty "name" in ${PACKAGE_FILE}, then rerun`,
      1,
      false,
    );
  }
  return name;
}

export async function planTemplateUpgradeChangeset(
  options: TemplateUpgradeChangesetOptions,
): Promise<TemplateUpgradeChangesetPlan | undefined> {
  const { repository, worktree, baseCommit, targetCommit, env } = options;
  const configText = await readTextIfFile(
    join(worktree, CHANGESET_FOLDER, CHANGESET_CONFIG_FILE),
  );
  if (configText === undefined) {
    return undefined;
  }
  const config = parseChangesetConfig(configText);
  const changedPaths = readWorktreePaths(worktree, env);
  if (
    !changedPaths.some((path) =>
      isCoveredChangesetPath(path, config.changedFilePatterns),
    )
  ) {
    return undefined;
  }
  if (await hasAddedWorktreeChangeset(worktree, env)) {
    return undefined;
  }
  if (hasCommittedChangesetSinceBase(repository, config.baseBranch, env)) {
    return undefined;
  }
  const packageName = await readWorktreePackageName(worktree);
  const base7 = baseCommit.slice(0, 7);
  const target7 = targetCommit.slice(0, 7);
  return Object.freeze({
    path: `${CHANGESET_PREFIX}template-upgrade-${target7}.md`,
    packageName,
    level: "patch" as const,
    summary: `Upgraded template ${base7} to ${target7}`,
  });
}

export async function writeTemplateUpgradeChangeset(
  options: TemplateUpgradeChangesetOptions,
): Promise<TemplateUpgradeChangesetPlan | undefined> {
  const plan = await planTemplateUpgradeChangeset(options);
  if (plan === undefined) {
    return undefined;
  }
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
      plan.packageName,
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
      `cannot write upgrade changeset ${plan.path} with changeset add${detail}`,
      `ensure dependencies are installed in ${formatCommandPath(worktree)} or add ${plan.path} with bun run --bun changeset add --patch ${plan.packageName} -m ${JSON.stringify(plan.summary)}, then rerun`,
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
  if (createdFile !== undefined && createdFile !== targetFile) {
    const sourcePath = join(worktree, CHANGESET_FOLDER, createdFile);
    const targetPath = join(worktree, CHANGESET_FOLDER, targetFile);
    await assertNotSymlinkPath(sourcePath, `${CHANGESET_PREFIX}${createdFile}`);
    await assertNotSymlinkPath(targetPath, plan.path);
    await rename(sourcePath, targetPath);
  }
  return plan;
}
