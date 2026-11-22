import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readlink,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { REPOSITORY_RECIPE_COPIES } from "./recipe.ts";
import {
  gitDiffFiles,
  gitMergeFile,
  lstatIfPresent,
} from "./template-upgrade-git.ts";
import { tryMergeJsonText } from "./template-upgrade-json-merge.ts";
import {
  assertNoSymlinkAncestors,
  readPlainFileBytes,
} from "./template-upgrade-worktree.ts";

const STAMP_FILE = ".cli-design-template.json";
const LOCK_FILE = "bun.lock";
const PACKAGE_FILE = "package.json";
const REPOSITORY_COPIES = new Set(REPOSITORY_RECIPE_COPIES);
const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export type TemplateUpgradeFileOwner =
  | "generated"
  | "shared"
  | "repository"
  | "template";

export type TemplateUpgradeOutcome =
  | "untouched"
  | "already"
  | "take"
  | "delete"
  | "regenerate"
  | "merge"
  | "conflict"
  | "conflict-add"
  | "conflict-delete"
  | "conflict-link"
  | "template-copy-changed";

export interface TemplateUpgradeRow {
  readonly path: string;
  readonly ownerLabel: TemplateUpgradeFileOwner;
  readonly outcome: TemplateUpgradeOutcome;
  readonly reason?: string;
}

interface PathMergeResult {
  readonly outcome: TemplateUpgradeOutcome;
  readonly reason?: string;
}

const UNMARKABLE_TEMPLATE_DELETE_REASON =
  "template deleted a file that cannot hold conflict markers; kept the repository's file";
const UNMARKABLE_OWNER_DELETE_REASON =
  "template changed a deleted file that cannot hold conflict markers; kept the repository's deletion";

export interface TemplateUpgradeCopyChange {
  readonly path: string;
  readonly diff: string;
}

type TreeEntry =
  | { readonly kind: "absent" }
  | { readonly kind: "symlink"; readonly target: string }
  | { readonly kind: "file"; readonly bytes: Uint8Array; readonly mode: number }
  | { readonly kind: "other" };

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function classifyTemplateUpgradeFileOwner(
  relativePath: string,
): TemplateUpgradeFileOwner {
  if (
    relativePath === STAMP_FILE ||
    relativePath === LOCK_FILE ||
    relativePath.startsWith(".claude/skills/")
  ) {
    return "generated";
  }
  if (REPOSITORY_COPIES.has(relativePath)) {
    return "repository";
  }
  if (
    (!relativePath.includes("/") &&
      (relativePath.endsWith(".json") || relativePath.endsWith(".toml"))) ||
    relativePath === ".gitignore" ||
    relativePath.startsWith(".github/") ||
    relativePath === "AGENTS.md"
  ) {
    return "shared";
  }
  return "template";
}

export function isTemplateUpgradeConflict(
  outcome: TemplateUpgradeOutcome,
): boolean {
  return (
    outcome === "conflict" ||
    outcome === "conflict-add" ||
    outcome === "conflict-delete" ||
    outcome === "conflict-link"
  );
}

async function collectTreePaths(root: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const paths: string[] = [];
  for (const entry of entries) {
    if (entry.name === ".git") {
      continue;
    }
    const relativePath = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      paths.push(...(await collectTreePaths(root, relativePath)));
    } else if (entry.isFile() || entry.isSymbolicLink()) {
      paths.push(relativePath);
    }
  }
  return paths;
}

async function inspectTreeEntry(
  root: string,
  relativePath: string,
): Promise<TreeEntry> {
  await assertNoSymlinkAncestors(root, relativePath);
  const fullPath = join(root, relativePath);
  const stats = await lstatIfPresent(fullPath);
  if (stats === undefined) {
    return { kind: "absent" };
  }
  if (stats.isSymbolicLink()) {
    return { kind: "symlink", target: await readlink(fullPath) };
  }
  if (stats.isFile()) {
    return {
      kind: "file",
      bytes: await readPlainFileBytes(fullPath),
      mode: Number(stats.mode) & 0o777,
    };
  }
  return { kind: "other" };
}

function entriesEqual(left: TreeEntry, right: TreeEntry): boolean {
  if (left.kind !== right.kind) {
    return false;
  }
  if (left.kind === "absent") {
    return true;
  }
  if (left.kind === "symlink" && right.kind === "symlink") {
    return left.target === right.target;
  }
  if (left.kind === "file" && right.kind === "file") {
    return Buffer.compare(left.bytes, right.bytes) === 0;
  }
  return false;
}

async function removeEntryIfPresent(fullPath: string): Promise<void> {
  const stats = await lstatIfPresent(fullPath);
  if (stats === undefined) {
    return;
  }
  if (stats.isDirectory()) {
    await rm(fullPath, { force: true, recursive: true });
    return;
  }
  await unlink(fullPath);
}

async function writeTreeEntry(
  targetFolder: string,
  relativePath: string,
  entry: Extract<TreeEntry, { readonly kind: "file" | "symlink" }>,
): Promise<void> {
  await assertNoSymlinkAncestors(targetFolder, relativePath);
  const destinationPath = join(targetFolder, relativePath);
  await mkdir(dirname(destinationPath), { recursive: true });
  await removeEntryIfPresent(destinationPath);
  if (entry.kind === "symlink") {
    await symlink(entry.target, destinationPath);
    return;
  }
  await writeFile(destinationPath, entry.bytes);
  if ((entry.mode & 0o111) !== 0) {
    await chmod(destinationPath, entry.mode);
  }
}

async function deleteTreeEntry(
  targetFolder: string,
  relativePath: string,
): Promise<void> {
  await assertNoSymlinkAncestors(targetFolder, relativePath);
  await removeEntryIfPresent(join(targetFolder, relativePath));
}

function decodeTextIfUtf8(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

function decodeUtf8TextWithoutNul(bytes: Uint8Array): string | undefined {
  if (bytes.includes(0)) {
    return undefined;
  }
  return decodeTextIfUtf8(bytes);
}

function ensureTrailingNewline(content: string): string {
  if (content === "" || content.endsWith("\n")) {
    return content;
  }
  return `${content}\n`;
}

async function writeDeleteConflictEntry(options: {
  readonly targetFolder: string;
  readonly relativePath: string;
  readonly oursEntry: TreeEntry;
  readonly newEntry: TreeEntry;
}): Promise<PathMergeResult> {
  const { targetFolder, relativePath, oursEntry, newEntry } = options;
  if (newEntry.kind === "absent" && oursEntry.kind === "file") {
    const oursText = decodeUtf8TextWithoutNul(oursEntry.bytes);
    if (oursText === undefined) {
      return {
        outcome: "template-copy-changed",
        reason: UNMARKABLE_TEMPLATE_DELETE_REASON,
      };
    }
    const marked =
      `<<<<<<< ours\n` +
      `${ensureTrailingNewline(oursText)}` +
      `=======\n` +
      `>>>>>>> new (deleted by template)\n`;
    await writeTreeEntry(targetFolder, relativePath, {
      kind: "file",
      bytes: new TextEncoder().encode(marked),
      mode: oursEntry.mode,
    });
    return { outcome: "conflict-delete" };
  }
  if (oursEntry.kind === "absent" && newEntry.kind === "file") {
    const newText = decodeUtf8TextWithoutNul(newEntry.bytes);
    if (newText === undefined) {
      return {
        outcome: "template-copy-changed",
        reason: UNMARKABLE_OWNER_DELETE_REASON,
      };
    }
    const marked =
      `<<<<<<< ours (deleted by owner)\n` +
      `=======\n` +
      `${ensureTrailingNewline(newText)}` +
      `>>>>>>> new\n`;
    await writeTreeEntry(targetFolder, relativePath, {
      kind: "file",
      bytes: new TextEncoder().encode(marked),
      mode: newEntry.mode,
    });
    return { outcome: "conflict-delete" };
  }
  return { outcome: "conflict-delete" };
}

async function mergeAddedConflictFile(
  targetFolder: string,
  newFolder: string,
  relativePath: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  await assertNoSymlinkAncestors(targetFolder, relativePath);
  await assertNoSymlinkAncestors(newFolder, relativePath);
  const oursPath = join(targetFolder, relativePath);
  const newPath = join(newFolder, relativePath);
  const emptyFolder = await mkdtemp(join(tmpdir(), "template-upgrade-base-"));
  try {
    const emptyBase = join(emptyFolder, "empty");
    await writeFile(emptyBase, "");
    gitMergeFile(oursPath, emptyBase, newPath, env);
  } finally {
    await rm(emptyFolder, { force: true, recursive: true });
  }
}

async function mergeJsonFile(options: {
  readonly targetFolder: string;
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly relativePath: string;
  readonly oursBytes: Uint8Array;
  readonly oldBytes: Uint8Array;
  readonly newBytes: Uint8Array;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<"merge" | "conflict"> {
  const {
    targetFolder,
    oldFolder,
    newFolder,
    relativePath,
    oursBytes,
    oldBytes,
    newBytes,
    env,
  } = options;
  await assertNoSymlinkAncestors(targetFolder, relativePath);
  await assertNoSymlinkAncestors(oldFolder, relativePath);
  await assertNoSymlinkAncestors(newFolder, relativePath);
  const oursPath = join(targetFolder, relativePath);
  const oldPath = join(oldFolder, relativePath);
  const newPath = join(newFolder, relativePath);
  const oursText = decodeTextIfUtf8(oursBytes);
  const oldText = decodeTextIfUtf8(oldBytes);
  const newText = decodeTextIfUtf8(newBytes);
  const jsonResult =
    oursText !== undefined && oldText !== undefined && newText !== undefined
      ? tryMergeJsonText(oursText, oldText, newText)
      : undefined;
  if (jsonResult !== undefined && jsonResult.conflictPaths.length === 0) {
    await writeFile(oursPath, jsonResult.mergedText);
    return "merge";
  }
  const fileResult = gitMergeFile(oursPath, oldPath, newPath, env);
  if (jsonResult !== undefined && jsonResult.conflictPaths.length > 0) {
    return "conflict";
  }
  return fileResult === "clean" ? "merge" : "conflict";
}

async function applyUnchangedPathUpdate(
  targetFolder: string,
  relativePath: string,
  newEntry: TreeEntry,
): Promise<TemplateUpgradeOutcome> {
  if (newEntry.kind === "absent") {
    await deleteTreeEntry(targetFolder, relativePath);
    return "delete";
  }
  if (newEntry.kind === "file" || newEntry.kind === "symlink") {
    await writeTreeEntry(targetFolder, relativePath, newEntry);
    return "take";
  }
  return "conflict";
}

function hasSymlinkEntry(
  oursEntry: TreeEntry,
  oldEntry: TreeEntry,
  newEntry: TreeEntry,
): boolean {
  return (
    oursEntry.kind === "symlink" ||
    oldEntry.kind === "symlink" ||
    newEntry.kind === "symlink"
  );
}

function detectNonFileConflict(
  oursEntry: TreeEntry,
  oldEntry: TreeEntry,
  newEntry: TreeEntry,
): TemplateUpgradeOutcome | undefined {
  if (oursEntry.kind === "absent" || newEntry.kind === "absent") {
    return "conflict-delete";
  }
  if (hasSymlinkEntry(oursEntry, oldEntry, newEntry)) {
    return "conflict-link";
  }
  if (
    oursEntry.kind !== "file" ||
    oldEntry.kind !== "file" ||
    newEntry.kind !== "file"
  ) {
    return "conflict";
  }
  return undefined;
}

async function mergeRegularFiles(options: {
  readonly relativePath: string;
  readonly targetFolder: string;
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly oursBytes: Uint8Array;
  readonly oldBytes: Uint8Array;
  readonly newBytes: Uint8Array;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<"merge" | "conflict"> {
  if (options.relativePath.endsWith(".json")) {
    return await mergeJsonFile(options);
  }
  await assertNoSymlinkAncestors(options.targetFolder, options.relativePath);
  await assertNoSymlinkAncestors(options.oldFolder, options.relativePath);
  await assertNoSymlinkAncestors(options.newFolder, options.relativePath);
  const fileResult = gitMergeFile(
    join(options.targetFolder, options.relativePath),
    join(options.oldFolder, options.relativePath),
    join(options.newFolder, options.relativePath),
    options.env,
  );
  return fileResult === "clean" ? "merge" : "conflict";
}

async function mergeDivergentPath(options: {
  readonly relativePath: string;
  readonly targetFolder: string;
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly oursEntry: TreeEntry;
  readonly oldEntry: TreeEntry;
  readonly newEntry: TreeEntry;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<PathMergeResult> {
  const { relativePath, targetFolder, oldFolder, newFolder, env } = options;
  const { oursEntry, oldEntry, newEntry } = options;
  if (oldEntry.kind === "absent") {
    if (oursEntry.kind === "file" && newEntry.kind === "file") {
      await mergeAddedConflictFile(targetFolder, newFolder, relativePath, env);
    }
    return { outcome: "conflict-add" };
  }
  const nonFileConflict = detectNonFileConflict(oursEntry, oldEntry, newEntry);
  if (nonFileConflict === "conflict-delete") {
    return await writeDeleteConflictEntry({
      targetFolder,
      relativePath,
      oursEntry,
      newEntry,
    });
  }
  if (nonFileConflict !== undefined) {
    return { outcome: nonFileConflict };
  }
  if (
    oursEntry.kind !== "file" ||
    oldEntry.kind !== "file" ||
    newEntry.kind !== "file"
  ) {
    return { outcome: "conflict" };
  }
  return {
    outcome: await mergeRegularFiles({
      relativePath,
      targetFolder,
      oldFolder,
      newFolder,
      oursBytes: oursEntry.bytes,
      oldBytes: oldEntry.bytes,
      newBytes: newEntry.bytes,
      env,
    }),
  };
}

async function mergeSinglePath(options: {
  readonly relativePath: string;
  readonly ownerLabel: TemplateUpgradeFileOwner;
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly targetFolder: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}): Promise<PathMergeResult> {
  const { relativePath, ownerLabel, oldFolder, newFolder, targetFolder, env } =
    options;

  const [oldEntry, newEntry, oursEntry] = await Promise.all([
    inspectTreeEntry(oldFolder, relativePath),
    inspectTreeEntry(newFolder, relativePath),
    inspectTreeEntry(targetFolder, relativePath),
  ]);

  if (entriesEqual(oldEntry, newEntry)) {
    return { outcome: "untouched" };
  }
  if (ownerLabel === "repository") {
    return { outcome: "template-copy-changed" };
  }
  if (entriesEqual(oursEntry, newEntry)) {
    return { outcome: "already" };
  }
  if (relativePath === STAMP_FILE) {
    return {
      outcome: await applyUnchangedPathUpdate(
        targetFolder,
        relativePath,
        newEntry,
      ),
    };
  }
  if (entriesEqual(oursEntry, oldEntry)) {
    return {
      outcome: await applyUnchangedPathUpdate(
        targetFolder,
        relativePath,
        newEntry,
      ),
    };
  }
  return await mergeDivergentPath({
    relativePath,
    targetFolder,
    oldFolder,
    newFolder,
    oursEntry,
    oldEntry,
    newEntry,
    env,
  });
}

async function assertAllPathAncestorsSafe(
  allPaths: readonly string[],
  oldFolder: string,
  newFolder: string,
  targetFolder: string,
): Promise<void> {
  for (const relativePath of allPaths) {
    await assertNoSymlinkAncestors(oldFolder, relativePath);
    await assertNoSymlinkAncestors(newFolder, relativePath);
    await assertNoSymlinkAncestors(targetFolder, relativePath);
  }
}

export async function mergeTemplateUpgradeTrees(
  oldFolder: string,
  newFolder: string,
  targetFolder: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly TemplateUpgradeRow[]> {
  const [oldPaths, newPaths] = await Promise.all([
    collectTreePaths(oldFolder),
    collectTreePaths(newFolder),
  ]);
  const allPaths = [...new Set([...oldPaths, ...newPaths])].sort(
    compareCodeUnits,
  );
  await assertAllPathAncestorsSafe(
    allPaths,
    oldFolder,
    newFolder,
    targetFolder,
  );
  const rowByPath = new Map<string, TemplateUpgradeRow>();
  for (const relativePath of allPaths) {
    if (relativePath === LOCK_FILE) {
      continue;
    }
    const ownerLabel = classifyTemplateUpgradeFileOwner(relativePath);
    const merged = await mergeSinglePath({
      relativePath,
      ownerLabel,
      oldFolder,
      newFolder,
      targetFolder,
      env,
    });
    rowByPath.set(
      relativePath,
      Object.freeze({
        path: relativePath,
        ownerLabel,
        outcome: merged.outcome,
        ...(merged.reason === undefined ? {} : { reason: merged.reason }),
      }),
    );
  }
  if (allPaths.includes(LOCK_FILE)) {
    const packageRow = rowByPath.get(PACKAGE_FILE);
    const packageChanged =
      packageRow !== undefined &&
      packageRow.outcome !== "untouched" &&
      packageRow.outcome !== "already";
    rowByPath.set(
      LOCK_FILE,
      Object.freeze({
        path: LOCK_FILE,
        ownerLabel: "generated",
        outcome: packageChanged ? "regenerate" : "untouched",
      }),
    );
  }
  return Object.freeze(
    allPaths.flatMap((relativePath) => {
      const row = rowByPath.get(relativePath);
      return row === undefined ? [] : [row];
    }),
  );
}

export async function diffTemplateUpgradeCopyChanges(
  oldFolder: string,
  newFolder: string,
  rows: readonly TemplateUpgradeRow[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<readonly TemplateUpgradeCopyChange[]> {
  const changes: TemplateUpgradeCopyChange[] = [];
  for (const row of rows) {
    if (row.outcome !== "template-copy-changed") {
      continue;
    }
    await assertNoSymlinkAncestors(oldFolder, row.path);
    await assertNoSymlinkAncestors(newFolder, row.path);
    const diff = await gitDiffFiles({
      oldPath: join(oldFolder, row.path),
      newPath: join(newFolder, row.path),
      relativePath: row.path,
      env,
    });
    changes.push(Object.freeze({ path: row.path, diff }));
  }
  return Object.freeze(changes);
}
