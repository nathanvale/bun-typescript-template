import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
  type Glossary,
  gitInNamesCheck,
  gitNames,
  mergeBaseOf,
  namesOnPaths,
  newNameProblems,
  type RecordedHit,
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
import { matchesSurface, type PublicSurface } from "./surface-match.ts";

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

function revisionList(
  revisions: string | readonly string[],
): readonly string[] {
  return typeof revisions === "string" ? [revisions] : revisions;
}

function committedFiles(
  root: string,
  revisions: string | readonly string[],
): string[] {
  const files = new Set<string>();
  for (const revision of revisionList(revisions)) {
    if (!hasCommit(root, revision)) continue;
    for (const file of gitNameCommand(root, [
      "ls-tree",
      "-r",
      "--name-only",
      "-z",
      revision,
    ]))
      files.add(file);
  }
  return [...files];
}

function committedNames(
  root: string,
  revisions: string | readonly string[],
): Set<string> {
  return new Set(namesOnPaths(committedFiles(root, revisions)));
}

function committedPathWords(
  root: string,
  revisions: string | readonly string[],
): string[] {
  const files = committedFiles(root, revisions);
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

function gitMoves(root: string, parents: readonly string[]): RenamePair[] {
  const renames: RenamePair[] = [];
  for (const parent of parents) {
    if (!hasCommit(root, parent)) continue;
    renames.push(
      ...parseNameStatus(
        gitNameCommand(root, ["diff", "--name-status", "-M", "-z", parent]),
      ).renames,
    );
  }
  return renames;
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

function allExportSurface(surface: PublicSurface): PublicSurface {
  return {
    exports: [...surface.exports, ...surface.consumedExports],
    consumedExports: [],
    importers: [],
  };
}

async function revisionDeclarations(
  root: string,
  revision: string,
): Promise<PublicDeclaration[]> {
  if (!committedFileExists(root, revision, publicSurfaceFile)) return [];
  const surface = readPublicSurface(
    gitOrThrow(root, ["show", `${revision}:${publicSurfaceFile}`]),
  );
  const exportSurface = allExportSurface(surface);
  const patterns = [
    ...exportSurface.exports,
    ...exportSurface.consumedExports,
    ...exportSurface.importers,
  ];
  const present = new Set<string>();
  const texts = treeTexts(root, revision, (path) => {
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
    exportSurface,
    (path) => present.has(path),
    (path) => gitOrThrow(root, ["show", `${revision}:${path}`]),
  );
  return publicDeclarations(root, texts, exportSurface);
}

async function baseDeclarations(
  root: string,
  base: string | readonly string[],
): Promise<PublicDeclaration[]> {
  const groups = await Promise.all(
    revisionList(base).map((revision) => revisionDeclarations(root, revision)),
  );
  return groups.flat();
}

function withBaseWords(
  words: NameWords,
  root: string,
  base: string | readonly string[],
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

async function surfaceDeclarations(
  root: string,
  staged: boolean,
  paths: readonly string[] | undefined,
): Promise<PublicDeclaration[]> {
  const hasSurface = staged
    ? stagedFileExists(root, publicSurfaceFile)
    : existsSync(join(root, publicSurfaceFile));
  if (!hasSurface) return [];
  const { surface, texts, exists, textOf } = surfaceTexts(root, staged);
  if (texts.size === 0) return [];
  const exportSurface = allExportSurface(surface);
  const patterns = [
    ...exportSurface.exports,
    ...exportSurface.consumedExports,
    ...exportSurface.importers,
  ];
  const exportTexts = new Map(
    [...texts].filter(([path]) => matchesSurface(path, patterns)),
  );
  if (exportTexts.size === 0) return [];
  const { publicDeclarations, followReexports } = await import(
    "./public-declarations.ts"
  );
  followReexports(root, exportTexts, exportSurface, exists, textOf);
  return publicDeclarations(root, exportTexts, exportSurface).filter(
    (declaration) => paths === undefined || paths.includes(declaration.path),
  );
}

function renamesByPath(renames: readonly RenamePair[]): Map<string, string[]> {
  const renamedFrom = new Map<string, string[]>();
  for (const { from, to } of renames) {
    const list = renamedFrom.get(to);
    if (list === undefined) renamedFrom.set(to, [from]);
    else list.push(from);
  }
  return renamedFrom;
}

function addedDeclarations(
  current: readonly PublicDeclaration[],
  loadedBase: readonly PublicDeclaration[],
  renames: readonly RenamePair[],
): PublicDeclaration[] {
  const earlier = new Set(
    loadedBase.map(({ path, declaration, name }) =>
      declarationKey(path, declaration, name),
    ),
  );
  const renamedFrom = renamesByPath(renames);
  return current.filter(({ path, declaration, name }) => {
    if (earlier.has(declarationKey(path, declaration, name))) return false;
    return !(renamedFrom.get(path) ?? []).some((from) =>
      earlier.has(declarationKey(from, declaration, name)),
    );
  });
}

async function newDeclarationsSince(
  root: string,
  base: string | readonly string[],
  staged: boolean,
  paths: readonly string[] | undefined,
  renames: readonly RenamePair[],
  baseDecls?:
    | readonly PublicDeclaration[]
    | (() => Promise<readonly PublicDeclaration[]>),
): Promise<PublicDeclaration[]> {
  if (paths !== undefined && !paths.some((path) => codeFile.test(path)))
    return [];
  const current = await surfaceDeclarations(root, staged, paths);
  if (current.length === 0) return [];
  const loadedBase =
    typeof baseDecls === "function"
      ? await baseDecls()
      : (baseDecls ?? (await baseDeclarations(root, base)));
  return addedDeclarations(current, loadedBase, renames);
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

async function newDeclarationGlossaryProblems(
  declarations: readonly PublicDeclaration[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): Promise<string[]> {
  const exported = declarations.filter(
    ({ declaration }) => !declaration.includes("."),
  );
  if (exported.length === 0) return [];
  const { declarationProblems } = await import("./public-declarations.ts");
  return declarationProblems(exported, glossary, recorded);
}

function readWorkingNameWords(root: string):
  | {
      words: NameWords;
      glossary: Glossary;
      blocked: Set<string>;
      recorded: RecordedHit[];
    }
  | undefined {
  const plainText = plainWordFile(join(root, plainWordsFile), plainWordsFile);
  if (plainText === undefined) return undefined;
  const glossaryText = readFileSync(join(root, "GLOSSARY.md"), "utf8");
  const ownershipText = plainWordFile(join(root, ownershipFile), ownershipFile);
  const recordedText = plainWordFile(
    join(root, recordedHitsFile),
    recordedHitsFile,
  );
  const words = readNameWords(glossaryText, plainText, ownershipText);
  return {
    words,
    glossary: readGlossary(glossaryText),
    blocked: blockedBaseWords(words.avoidTerms, glossaryText),
    recorded: recordedText === undefined ? [] : readRecordedHits(recordedText),
  };
}

function mergeParents(root: string): string[] {
  const located = gitInNamesCheck(root, [
    "rev-parse",
    "--git-path",
    "MERGE_HEAD",
  ]);
  if (located.exitCode !== 0) return ["HEAD"];
  const gitPath = gitNames(
    located.stdout,
    "git rev-parse --git-path MERGE_HEAD",
  ).replace(/\r?\n$/, "");
  const mergeHeadText = plainWordFile(resolve(root, gitPath), "MERGE_HEAD");
  if (mergeHeadText === undefined) return ["HEAD"];
  const mergeHeads = mergeHeadText
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "");
  if (mergeHeads.length === 0)
    throw new Error(
      "MERGE_HEAD is empty, so the names check cannot read the merge parents. Repair: finish or abort the merge with git merge --abort, then run the check again.",
    );
  return [
    "HEAD",
    ...mergeHeads.map((revision) =>
      gitOrThrow(root, [
        "rev-parse",
        "--verify",
        `${revision}^{commit}`,
      ]).trim(),
    ),
  ];
}

export async function givenNameWordProblems(
  tree: string,
  names: readonly string[],
  keptPaths: ReadonlySet<string> = new Set(),
): Promise<string[]> {
  const parents = mergeParents(tree);
  const loaded = readWorkingNameWords(tree);
  if (loaded === undefined) {
    if (
      parents.some((parent) =>
        committedFileExists(tree, parent, plainWordsFile),
      )
    )
      throw new Error(
        `${plainWordsFile} exists at HEAD but is missing from this tree. Repair: restore it with git restore ${plainWordsFile}.`,
      );
    return [];
  }
  const committed = committedNames(tree, parents);
  const renames = gitMoves(tree, parents);
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
  let cachedDecls: Promise<PublicDeclaration[]> | undefined;
  const loadEarlierDecls = () => {
    cachedDecls ??= baseDeclarations(tree, parents);
    return cachedDecls;
  };
  const pathWords = withBaseWords(
    loaded.words,
    tree,
    parents,
    [],
    loaded.blocked,
  );
  let pathProblems = unknownPathProblems(pathWords, loaded.glossary, items);
  if (pathProblems.length > 0) {
    const words = withBaseWords(
      loaded.words,
      tree,
      parents,
      await loadEarlierDecls(),
      loaded.blocked,
    );
    pathProblems = unknownPathProblems(words, loaded.glossary, items);
  }
  const declarations = await newDeclarationsSince(
    tree,
    parents,
    false,
    existingFiles,
    renames,
    loadEarlierDecls,
  );
  const declarationProblems =
    declarations.length === 0
      ? []
      : [
          ...(await newDeclarationGlossaryProblems(
            declarations,
            loaded.glossary,
            loaded.recorded,
          )),
          ...unknownDeclarationProblems(
            withBaseWords(
              loaded.words,
              tree,
              parents,
              await loadEarlierDecls(),
              loaded.blocked,
            ),
            loaded.glossary,
            declarations,
          ),
        ];
  return [...pathProblems, ...declarationProblems];
}

function stagedChanges(
  root: string,
  parents: readonly string[],
): { added: string[]; renames: RenamePair[] } {
  const { added, renames } = parseNameStatus(
    gitNameCommand(root, ["diff", "--cached", "--name-status", "-M", "-z"]),
  );
  for (const parent of parents.slice(1)) {
    const parentDiff = parseNameStatus(
      gitNameCommand(root, [
        "diff",
        "--cached",
        "--name-status",
        "-M",
        "-z",
        parent,
      ]),
    );
    renames.push(...parentDiff.renames);
  }
  return { added, renames };
}

export async function stagedNameWordProblems(root: string): Promise<string[]> {
  const parents = mergeParents(root);
  const hasStagedPlain = stagedFileExists(root, plainWordsFile);
  if (
    !hasStagedPlain &&
    !parents.some((parent) => committedFileExists(root, parent, plainWordsFile))
  )
    return [];
  const plainText = stagedText(root, plainWordsFile);
  const glossaryText = stagedText(root, "GLOSSARY.md");
  const ownershipText = stagedFileExists(root, ownershipFile)
    ? stagedText(root, ownershipFile)
    : undefined;
  const baseWords = readNameWords(glossaryText, plainText, ownershipText);
  const glossary = readGlossary(glossaryText);
  const blocked = blockedBaseWords(baseWords.avoidTerms, glossaryText);
  const { added, renames } = stagedChanges(root, parents);
  const { unkeptNew } = newPathItems(
    added,
    renames,
    committedNames(root, parents),
  );
  const earlierDecls = await baseDeclarations(root, parents);
  const words = withBaseWords(baseWords, root, parents, earlierDecls, blocked);
  const declarations = await newDeclarationsSince(
    root,
    parents,
    true,
    undefined,
    renames,
    earlierDecls,
  );
  const recorded = stagedFileExists(root, recordedHitsFile)
    ? readRecordedHits(stagedText(root, recordedHitsFile))
    : [];
  return [
    ...unknownPathProblems(words, glossary, unkeptNew),
    ...(await newDeclarationGlossaryProblems(declarations, glossary, recorded)),
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
    ...(await newDeclarationGlossaryProblems(
      declarations,
      loaded.glossary,
      recorded,
    )),
    ...unknownDeclarationProblems(words, loaded.glossary, declarations),
  ];
}
