import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import {
  type Glossary,
  gitInNamesCheck,
  hitsIn,
  mergeBaseOf,
  namesOnPaths,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  stagedText,
} from "./glossary.ts";
import { listedEntries, ownershipFile } from "./glossary-ownership.ts";
import type { PublicDeclaration } from "./public-declarations.ts";
import {
  publicSurfaceFile,
  readPublicSurface,
  surfaceTexts,
} from "./public-surface.ts";
import { treeTexts } from "./staged-texts.ts";
import { matchesSurface } from "./surface-match.ts";

export const plainWordsFile = "names-plain-words.json";

export const designWords: readonly string[] = [
  "module",
  "interface",
  "seam",
  "adapter",
  "implementation",
  "depth",
  "leverage",
  "locality",
];

export type NameWords = {
  readonly known: ReadonlySet<string>;
  readonly plain: ReadonlyMap<string, string>;
};

export type PathItem = {
  readonly path: string;
  readonly isFile: boolean;
};

type RenamePair = {
  readonly from: string;
  readonly to: string;
};

const codeFile = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;
const patchPrefix = "tests/planted-faults/patches/";

export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z]+/)
    .filter((word) => word !== "");
}

function segmentWords(path: string, isFile: boolean): string[] {
  let segment = path.slice(path.lastIndexOf("/") + 1);
  if (isFile && path.startsWith(patchPrefix) && segment.endsWith(".patch"))
    segment = segment.replace(/^[0-9a-f]{7,40}-/, "");
  const trimmed = segment.replace(/^\.+/, "");
  if (!isFile) return splitWords(trimmed);
  const dot = trimmed.lastIndexOf(".");
  return splitWords(dot > 0 ? trimmed.slice(0, dot) : trimmed);
}

function matchesWord(words: ReadonlySet<string>, word: string): boolean {
  return (
    words.has(word) ||
    words.has(`${word}s`) ||
    (word.endsWith("s") && word.length > 1 && words.has(word.slice(0, -1)))
  );
}

function coveredWord(covered: ReadonlySet<string>, word: string): boolean {
  return (
    matchesWord(covered, word) ||
    (word.endsWith("es") && word.length > 2 && covered.has(word.slice(0, -2)))
  );
}

function allowed({ known, plain }: NameWords, word: string): boolean {
  return (
    matchesWord(known, word) ||
    plain.has(word) ||
    plain.has(`${word}s`) ||
    (word.endsWith("s") && word.length > 1 && plain.has(word.slice(0, -1)))
  );
}

export function knownGlossaryWords(
  glossaryText: string,
  ownershipText?: string,
): Set<string> {
  const glossary = readGlossary(glossaryText);
  const kernelWords =
    ownershipText === undefined
      ? []
      : listedEntries(ownershipText).flatMap(splitWords);
  return new Set([
    ...glossary.terms.flatMap(({ name }) => splitWords(name)),
    ...kernelWords,
    ...designWords,
  ]);
}

function ownFields(value: unknown): Map<string, unknown> {
  return new Map(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );
}

function parsePlainEntry(
  entry: unknown,
  index: number,
): readonly [string, string] {
  const own = ownFields(entry);
  const word = own.get("word");
  const reason = own.get("reason");
  if (
    typeof word !== "string" ||
    word.trim() === "" ||
    typeof reason !== "string" ||
    reason.trim() === ""
  )
    throw new Error(
      `${plainWordsFile}: words[${index}] needs a non-empty word and reason. Repair: write each one as a non-empty string.`,
    );
  if (!/^[a-z]+$/.test(word))
    throw new Error(
      `${plainWordsFile}: words[${index}] word "${word}" must be one lowercase word. Repair: write a single lowercase word of letters only.`,
    );
  return [word, reason];
}

export function readPlainWords(
  text: string,
  known: ReadonlySet<string>,
): Map<string, string> {
  const entries = ownFields(JSON.parse(text)).get("words");
  if (!Array.isArray(entries))
    throw new Error(
      `${plainWordsFile} has no "words" array. Repair: add "words": [] at its top level.`,
    );
  const plain = new Map<string, string>();
  let previous: string | undefined;
  for (const [index, entry] of entries.entries()) {
    const [word, reason] = parsePlainEntry(entry, index);
    if (plain.has(word))
      throw new Error(
        `${plainWordsFile} lists "${word}" twice. Repair: remove the duplicate entry.`,
      );
    if (matchesWord(known, word))
      throw new Error(
        `${plainWordsFile} lists "${word}", which is already a glossary word. Repair: remove it from ${plainWordsFile}, because it belongs to the glossary.`,
      );
    if (previous !== undefined && word < previous)
      throw new Error(
        `${plainWordsFile} is not sorted at "${word}" (after "${previous}"). Repair: sort words alphabetically.`,
      );
    previous = word;
    plain.set(word, reason);
  }
  return plain;
}

export function readNameWords(
  glossaryText: string,
  plainText: string,
  ownershipText?: string,
): NameWords {
  const known = knownGlossaryWords(glossaryText, ownershipText);
  return { known, plain: readPlainWords(plainText, known) };
}

function coveredByGlossaryRule(
  path: string,
  glossary: Glossary,
  declarationName?: string,
): Set<string> {
  return new Set(
    hitsIn(path, glossary, declarationName).flatMap(({ word }) =>
      splitWords(word),
    ),
  );
}

function unknownWordRepair(target: string): string {
  return `Repair: use the glossary's word for what it names; if none fits, add a glossary entry (term, one sentence, Avoid list) or a ${plainWordsFile} entry first, for Nathan's decision. Done when bun run check:names ${target} passes.`;
}

function unknownWordsOf(
  words: NameWords,
  covered: ReadonlySet<string>,
  candidates: readonly string[],
): string[] {
  return [...new Set(candidates)].filter(
    (word) => !allowed(words, word) && !coveredWord(covered, word),
  );
}

export function unknownPathProblems(
  words: NameWords,
  glossary: Glossary,
  items: readonly PathItem[],
): string[] {
  return items.flatMap(({ path, isFile }) =>
    unknownWordsOf(
      words,
      coveredByGlossaryRule(path, glossary),
      segmentWords(path, isFile),
    ).map(
      (word) =>
        `${path} uses "${word}", which no glossary term uses. ${unknownWordRepair(path)}`,
    ),
  );
}

export function unknownDeclarationProblems(
  words: NameWords,
  glossary: Glossary,
  declarations: readonly PublicDeclaration[],
): string[] {
  return declarations.flatMap(({ path, line, name }) =>
    unknownWordsOf(
      words,
      coveredByGlossaryRule(path, glossary, name),
      splitWords(name),
    ).map(
      (word) =>
        `${path}:${line} public declaration "${name}" uses "${word}", which no glossary term uses. ${unknownWordRepair(path)}`,
    ),
  );
}

function gitOrThrow(root: string, command: readonly string[]): string {
  const result = gitInNamesCheck(root, command);
  if (result.exitCode !== 0)
    throw new Error(
      `git ${command.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout.toString();
}

function hasCommit(root: string, revision: string): boolean {
  return (
    gitInNamesCheck(root, [
      "rev-parse",
      "--verify",
      "--quiet",
      `${revision}^{commit}`,
    ]).exitCode === 0
  );
}

function committedFileExists(
  root: string,
  revision: string,
  path: string,
): boolean {
  return (
    hasCommit(root, revision) &&
    gitInNamesCheck(root, ["cat-file", "-e", `${revision}:${path}`])
      .exitCode === 0
  );
}

function stagedFileExists(root: string, path: string): boolean {
  return gitInNamesCheck(root, ["cat-file", "-e", `:${path}`]).exitCode === 0;
}

function nullFields(text: string): string[] {
  return text.split("\0").filter((field) => field !== "");
}

function committedNames(root: string, revision: string): Set<string> {
  if (!hasCommit(root, revision)) return new Set();
  return new Set(
    namesOnPaths(
      nullFields(
        gitOrThrow(root, ["ls-tree", "-r", "--name-only", "-z", revision]),
      ),
    ),
  );
}

function recordStatus(
  status: string,
  first: string,
  second: string,
  added: string[],
  renames: RenamePair[],
): void {
  if (status.startsWith("R")) renames.push({ from: first, to: second });
  else if (status.startsWith("A")) added.push(first);
  else if (status.startsWith("C")) added.push(second);
}

function parseNameStatus(fields: readonly string[]): {
  added: string[];
  renames: RenamePair[];
} {
  const added: string[] = [];
  const renames: RenamePair[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? "";
    const hasSecond = status.startsWith("R") || status.startsWith("C");
    const first = fields[index + 1] ?? "";
    const second = fields[index + 2] ?? "";
    recordStatus(status, first, second, added, renames);
    index += hasSecond ? 3 : 2;
  }
  return { added, renames };
}

function keptByRenames(renames: readonly RenamePair[]): Set<string> {
  const kept = new Set<string>();
  for (const { from, to } of renames) {
    const fromParts = from.split("/");
    const toParts = to.split("/");
    const fromFolders = new Set(fromParts.slice(0, -1));
    if (fromParts.at(-1) === toParts.at(-1)) kept.add(to);
    for (let end = 1; end < toParts.length; end += 1) {
      if (fromFolders.has(toParts[end - 1] ?? ""))
        kept.add(toParts.slice(0, end).join("/"));
    }
  }
  return kept;
}

function itemsFromFiles(files: readonly string[]): PathItem[] {
  const items = new Map<string, boolean>();
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end += 1) {
      const path = parts.slice(0, end).join("/");
      const isFile = end === parts.length;
      if (!items.has(path) || !isFile) items.set(path, isFile);
    }
  }
  return [...items].map(([path, isFile]) => ({ path, isFile }));
}

function newPathItems(
  added: readonly string[],
  renames: readonly RenamePair[],
  earlier: ReadonlySet<string>,
): { allNew: PathItem[]; unkeptNew: PathItem[] } {
  const kept = keptByRenames(renames);
  const allNew = itemsFromFiles([
    ...added,
    ...renames.map(({ to }) => to),
  ]).filter(({ path }) => !earlier.has(path));
  return {
    allNew,
    unkeptNew: allNew.filter(({ path }) => !kept.has(path)),
  };
}

function isDirectoryAt(root: string, path: string): boolean {
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  return stat !== undefined && stat.isDirectory();
}

function isFileAt(root: string, path: string): boolean {
  const stat = lstatSync(join(root, path), { throwIfNoEntry: false });
  return stat !== undefined && stat.isFile();
}

function declarationKey(
  path: string,
  declaration: string,
  name: string,
): string {
  return `${path}\0${declaration}\0${name}`;
}

async function baseDeclarationKeys(
  root: string,
  base: string,
): Promise<Set<string>> {
  if (!committedFileExists(root, base, publicSurfaceFile)) return new Set();
  const surface = readPublicSurface(
    gitOrThrow(root, ["show", `${base}:${publicSurfaceFile}`]),
  );
  const patterns = [
    ...surface.exports,
    ...surface.consumedExports,
    ...surface.importers,
  ];
  const present = new Set<string>();
  const texts = treeTexts(root, base, (path) => {
    present.add(path);
    return matchesSurface(path, patterns);
  });
  if (texts.size === 0) return new Set();
  const { publicDeclarations, followReexports } = await import(
    "./public-declarations.ts"
  );
  followReexports(
    root,
    texts,
    surface,
    (path) => present.has(path),
    (path) => gitOrThrow(root, ["show", `${base}:${path}`]),
  );
  return new Set(
    publicDeclarations(root, texts, surface).map(
      ({ path, declaration, name }) => declarationKey(path, declaration, name),
    ),
  );
}

async function newDeclarationsSince(
  root: string,
  base: string,
  staged: boolean,
  paths: readonly string[] | undefined,
  renames: readonly RenamePair[],
): Promise<PublicDeclaration[]> {
  if (paths !== undefined && !paths.some((path) => codeFile.test(path)))
    return [];
  const hasSurface = staged
    ? stagedFileExists(root, publicSurfaceFile)
    : existsSync(join(root, publicSurfaceFile));
  if (!hasSurface) return [];
  const { surface, texts, exists, textOf } = surfaceTexts(root, staged);
  if (texts.size === 0) return [];
  const { publicDeclarations, followReexports } = await import(
    "./public-declarations.ts"
  );
  followReexports(root, texts, surface, exists, textOf);
  const current = publicDeclarations(root, texts, surface).filter(
    (declaration) => paths === undefined || paths.includes(declaration.path),
  );
  if (current.length === 0) return [];
  const earlier = await baseDeclarationKeys(root, base);
  const renamedFrom = new Map(renames.map(({ from, to }) => [to, from]));
  return current.filter(({ path, declaration, name }) => {
    if (earlier.has(declarationKey(path, declaration, name))) return false;
    const from = renamedFrom.get(path);
    return (
      from === undefined ||
      !earlier.has(declarationKey(from, declaration, name))
    );
  });
}

function readWorkingNameWords(
  root: string,
): { words: NameWords; glossary: Glossary } | undefined {
  const plainPath = join(root, plainWordsFile);
  if (!existsSync(plainPath)) return undefined;
  const glossaryText = readFileSync(join(root, "GLOSSARY.md"), "utf8");
  const ownershipPath = join(root, ownershipFile);
  const ownershipText = existsSync(ownershipPath)
    ? readFileSync(ownershipPath, "utf8")
    : undefined;
  return {
    words: readNameWords(
      glossaryText,
      readFileSync(plainPath, "utf8"),
      ownershipText,
    ),
    glossary: readGlossary(glossaryText),
  };
}

export async function givenNameWordProblems(
  tree: string,
  names: readonly string[],
  keptPaths: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const loaded = readWorkingNameWords(tree);
  if (loaded === undefined) return [];
  const committed = committedNames(tree, "HEAD");
  const items: PathItem[] = names
    .filter((name) => !committed.has(name) && !keptPaths.has(name))
    .map((name) => ({
      path: name,
      isFile:
        !names.some((other) => other.startsWith(`${name}/`)) &&
        !isDirectoryAt(tree, name),
    }));
  const existingFiles = names.filter((path) => isFileAt(tree, path));
  const declarations = await newDeclarationsSince(
    tree,
    "HEAD",
    false,
    existingFiles,
    [],
  );
  return [
    ...unknownPathProblems(loaded.words, loaded.glossary, items),
    ...unknownDeclarationProblems(loaded.words, loaded.glossary, declarations),
  ];
}

export async function stagedNameWordProblems(root: string): Promise<string[]> {
  const hasStagedPlain = stagedFileExists(root, plainWordsFile);
  if (!hasStagedPlain && !committedFileExists(root, "HEAD", plainWordsFile))
    return [];
  const plainText = stagedText(root, plainWordsFile);
  const glossaryText = stagedText(root, "GLOSSARY.md");
  const ownershipText = stagedFileExists(root, ownershipFile)
    ? stagedText(root, ownershipFile)
    : undefined;
  const words = readNameWords(glossaryText, plainText, ownershipText);
  const glossary = readGlossary(glossaryText);
  const { added, renames } = parseNameStatus(
    nullFields(
      gitOrThrow(root, ["diff", "--cached", "--name-status", "-M", "-z"]),
    ),
  );
  const { unkeptNew } = newPathItems(
    added,
    renames,
    committedNames(root, "HEAD"),
  );
  const declarations = await newDeclarationsSince(
    root,
    "HEAD",
    true,
    undefined,
    renames,
  );
  return [
    ...unknownPathProblems(words, glossary, unkeptNew),
    ...unknownDeclarationProblems(words, glossary, declarations),
  ];
}

export async function againstNameWordProblems(
  root: string,
  revision: string,
): Promise<string[]> {
  const base = mergeBaseOf(root, revision);
  const loaded = readWorkingNameWords(root);
  if (loaded === undefined) {
    if (committedFileExists(root, base, plainWordsFile))
      throw new Error(
        `${plainWordsFile} exists at ${revision} but is missing from this tree. Repair: restore it with git restore ${plainWordsFile}.`,
      );
    return [];
  }
  const { added, renames } = parseNameStatus(
    nullFields(gitOrThrow(root, ["diff", "--name-status", "-M", "-z", base])),
  );
  const untracked = nullFields(
    gitOrThrow(root, ["ls-files", "--others", "--exclude-standard", "-z"]),
  );
  const { allNew, unkeptNew } = newPathItems(
    [...added, ...untracked],
    renames,
    committedNames(root, base),
  );
  const recorded = readRecordedHits(
    readFileSync(join(root, recordedHitsFile), "utf8"),
  );
  const declarations = await newDeclarationsSince(
    root,
    base,
    false,
    undefined,
    renames,
  );
  return [
    ...newNameProblems(
      allNew.map(({ path }) => path),
      loaded.glossary,
      recorded,
    ),
    ...unknownPathProblems(loaded.words, loaded.glossary, unkeptNew),
    ...unknownDeclarationProblems(loaded.words, loaded.glossary, declarations),
  ];
}

export function keptMoveTargets(
  tool: unknown,
  input: ReadonlyMap<string, unknown>,
  from: string,
): Set<string> {
  if (tool !== "apply_patch") return new Set();
  const patch = input.get("command");
  if (typeof patch !== "string") return new Set();
  const kept = new Set<string>();
  let updated: string | undefined;
  for (const line of patch.split("\n")) {
    const updateMatch = /^\*\*\* Update File: (.+?)\s*$/.exec(line);
    if (updateMatch !== null) {
      updated = updateMatch[1];
      continue;
    }
    const moveMatch = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (moveMatch !== null && updated !== undefined) {
      const target = moveMatch[1] ?? "";
      if (basename(updated) === basename(target))
        kept.add(resolve(from, target));
      updated = undefined;
      continue;
    }
    if (line.startsWith("*** ")) updated = undefined;
  }
  return kept;
}
