import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type Glossary,
  gitInNamesCheck,
  gitNames,
  mergeBaseOf,
  namesOnPaths,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  stagedText,
} from "./glossary.ts";
import { ownershipFile } from "./glossary-ownership.ts";
import {
  keptByRenames,
  newPathItems,
  parseNameStatus,
  type PathItem,
  type RenamePair,
} from "./name-moves.ts";
import {
  blockedBaseWords,
  matchesWord,
  type NameWords,
  plainWordsFile,
  readNameWords,
  segmentWords,
  splitWords,
  unknownDeclarationProblems,
  unknownPathProblems,
} from "./plain-words.ts";
import type { PublicDeclaration } from "./public-declarations.ts";
import {
  publicSurfaceFile,
  readPublicSurface,
  surfaceTexts,
} from "./public-surface.ts";
import { treeTexts } from "./staged-texts.ts";
import { matchesSurface } from "./surface-match.ts";

const codeFile = /\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/;

function gitCommand(root: string, command: readonly string[]): Buffer {
  const result = gitInNamesCheck(root, command);
  if (result.exitCode !== 0)
    throw new Error(
      `git ${command.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

function gitOrThrow(root: string, command: readonly string[]): string {
  return gitCommand(root, command).toString();
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

function gitNameCommand(root: string, command: readonly string[]): string[] {
  return gitNames(gitCommand(root, command), `git ${command.join(" ")}`)
    .split("\0")
    .filter((field) => field !== "");
}

function committedFiles(root: string, revision: string): string[] {
  if (!hasCommit(root, revision)) return [];
  return gitNameCommand(root, ["ls-tree", "-r", "--name-only", "-z", revision]);
}

function committedNames(root: string, revision: string): Set<string> {
  return new Set(namesOnPaths(committedFiles(root, revision)));
}

function committedPathWords(root: string, revision: string): string[] {
  const files = committedFiles(root, revision);
  const dirs = new Set<string>();
  const words: string[] = [];
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end < parts.length; end += 1) {
      const dir = parts.slice(0, end).join("/");
      if (dirs.has(dir)) continue;
      dirs.add(dir);
      words.push(...segmentWords(dir, false));
    }
    words.push(...segmentWords(file, true));
  }
  return words;
}

function gitMoves(root: string): RenamePair[] {
  if (!hasCommit(root, "HEAD")) return [];
  return parseNameStatus(
    gitNameCommand(root, ["diff", "--name-status", "-M", "-z", "HEAD"]),
  ).renames;
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

async function baseDeclarations(
  root: string,
  base: string,
): Promise<PublicDeclaration[]> {
  if (!committedFileExists(root, base, publicSurfaceFile)) return [];
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
  if (texts.size === 0) return [];
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
  return publicDeclarations(root, texts, surface);
}

function withBaseWords(
  words: NameWords,
  root: string,
  base: string,
  declarations: readonly PublicDeclaration[],
  blocked: ReadonlySet<string>,
): NameWords {
  const baseWords = [
    ...committedPathWords(root, base),
    ...declarations.flatMap(({ name }) => splitWords(name)),
  ].filter((word) => !matchesWord(blocked, word));
  return {
    known: new Set([...words.known, ...baseWords]),
    plain: words.plain,
    avoidTerms: words.avoidTerms,
  };
}

async function newDeclarationsSince(
  root: string,
  base: string,
  staged: boolean,
  paths: readonly string[] | undefined,
  renames: readonly RenamePair[],
  baseDecls?: readonly PublicDeclaration[],
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
  const earlier = new Set(
    (baseDecls ?? (await baseDeclarations(root, base))).map(
      ({ path, declaration, name }) => declarationKey(path, declaration, name),
    ),
  );
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

function plainWordFile(
  fullPath: string,
  displayPath: string,
): string | undefined {
  let fd: number;
  try {
    fd = openSync(
      fullPath,
      fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW,
    );
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    if (code === "ELOOP")
      throw new Error(
        `${displayPath} is a symbolic link, not a regular file. Repair: replace it with a regular file.`,
        { cause: error },
      );
    throw new Error(
      `${displayPath} could not be opened (${String(code ?? error)}). Repair: make ${displayPath} a readable regular file.`,
      { cause: error },
    );
  }
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(
        `${displayPath} is not a regular file. Repair: replace it with a regular file.`,
      );
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function readWorkingNameWords(
  root: string,
): { words: NameWords; glossary: Glossary; blocked: Set<string> } | undefined {
  const plainText = plainWordFile(join(root, plainWordsFile), plainWordsFile);
  if (plainText === undefined) return undefined;
  const glossaryText = readFileSync(join(root, "GLOSSARY.md"), "utf8");
  const ownershipText = plainWordFile(join(root, ownershipFile), ownershipFile);
  const words = readNameWords(glossaryText, plainText, ownershipText);
  return {
    words,
    glossary: readGlossary(glossaryText),
    blocked: blockedBaseWords(words.avoidTerms, glossaryText),
  };
}

export async function givenNameWordProblems(
  tree: string,
  names: readonly string[],
  keptPaths: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const loaded = readWorkingNameWords(tree);
  if (loaded === undefined) {
    if (committedFileExists(tree, "HEAD", plainWordsFile))
      throw new Error(
        `${plainWordsFile} exists at HEAD but is missing from this tree. Repair: restore it with git restore ${plainWordsFile}.`,
      );
    return [];
  }
  const committed = committedNames(tree, "HEAD");
  const renames = gitMoves(tree);
  const kept = new Set([...keptPaths, ...keptByRenames(renames)]);
  const items: PathItem[] = names
    .filter((name) => !committed.has(name) && !kept.has(name))
    .map((name) => ({
      path: name,
      isFile:
        !names.some((other) => other.startsWith(`${name}/`)) &&
        !isDirectoryAt(tree, name),
    }));
  const existingFiles = names.filter((path) => isFileAt(tree, path));
  const earlierDecls = await baseDeclarations(tree, "HEAD");
  const words = withBaseWords(
    loaded.words,
    tree,
    "HEAD",
    earlierDecls,
    loaded.blocked,
  );
  const declarations = await newDeclarationsSince(
    tree,
    "HEAD",
    false,
    existingFiles,
    renames,
    earlierDecls,
  );
  return [
    ...unknownPathProblems(words, loaded.glossary, items),
    ...unknownDeclarationProblems(words, loaded.glossary, declarations),
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
  const baseWords = readNameWords(glossaryText, plainText, ownershipText);
  const glossary = readGlossary(glossaryText);
  const blocked = blockedBaseWords(baseWords.avoidTerms, glossaryText);
  const { added, renames } = parseNameStatus(
    gitNameCommand(root, ["diff", "--cached", "--name-status", "-M", "-z"]),
  );
  const { unkeptNew } = newPathItems(
    added,
    renames,
    committedNames(root, "HEAD"),
  );
  const earlierDecls = await baseDeclarations(root, "HEAD");
  const words = withBaseWords(baseWords, root, "HEAD", earlierDecls, blocked);
  const declarations = await newDeclarationsSince(
    root,
    "HEAD",
    true,
    undefined,
    renames,
    earlierDecls,
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
    if (committedFileExists(root, "HEAD", plainWordsFile))
      throw new Error(
        `${plainWordsFile} exists at HEAD but is missing from this tree. Repair: restore it with git restore ${plainWordsFile}.`,
      );
    return [];
  }
  const { added, renames } = parseNameStatus(
    gitNameCommand(root, ["diff", "--name-status", "-M", "-z", base]),
  );
  const untracked = gitNameCommand(root, [
    "ls-files",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  const { allNew, unkeptNew } = newPathItems(
    [...added, ...untracked],
    renames,
    committedNames(root, base),
  );
  const recorded = readRecordedHits(
    readFileSync(join(root, recordedHitsFile), "utf8"),
  );
  const earlierDecls = await baseDeclarations(root, base);
  const words = withBaseWords(
    loaded.words,
    root,
    base,
    earlierDecls,
    loaded.blocked,
  );
  const declarations = await newDeclarationsSince(
    root,
    base,
    false,
    undefined,
    renames,
    earlierDecls,
  );
  return [
    ...newNameProblems(
      allNew.map(({ path }) => path),
      loaded.glossary,
      recorded,
    ),
    ...unknownPathProblems(words, loaded.glossary, unkeptNew),
    ...unknownDeclarationProblems(words, loaded.glossary, declarations),
  ];
}
