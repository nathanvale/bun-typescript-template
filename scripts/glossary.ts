import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export const recordedHitsFile = "tests/template/names-check/recorded-hits.json";
export const recordedUnusedTermsFile =
  "tests/template/names-check/recorded-unused-terms.json";
const notReadAsUse = new Set([
  "GLOSSARY.md",
  "GLOSSARY-MAP.md",
  recordedUnusedTermsFile,
  "tests/template/names-check/shared-tool-words.txt",
  "glossary-ownership.json",
]);
const avoidLabel = "_Avoid_:";

export type Glossary = {
  readonly terms: readonly {
    readonly name: string;
    readonly avoid: readonly string[];
  }[];
  readonly qualify: readonly string[];
};

export type RecordedHit = {
  readonly path: string;
  readonly word: string;
  readonly reason: string;
};

export type RecordedUnusedTerm = {
  readonly term: string;
  readonly reason: string;
  readonly ticket: string;
};

type NameHit = {
  readonly path: string;
  readonly word: string;
  readonly problem: string;
};

function wordsIn(list: string): string[] {
  return list
    .split(",")
    .map((word) => word.trim())
    .filter((word) => word !== "");
}

function listAfter(label: string, line: string): string[] | undefined {
  if (!line.startsWith(label)) return undefined;
  return wordsIn(line.slice(label.length));
}

const note = /\([^()]*\)/g;
const noteMark = "\0";

function enforcedAvoidWords(line: string, term: string): string[] {
  if (!line.startsWith(avoidLabel)) return [];
  const marked = line.slice(avoidLabel.length).replace(note, noteMark);
  if (/[()]/.test(marked))
    throw new Error(
      `GLOSSARY.md: the Avoid line for "${term}" has a parenthesis with no partner, so the words its note covers cannot be told. Repair: close each note, and put no note inside another.`,
    );
  return marked.split(";").flatMap((run) => {
    const words = run.split(",");
    const lastNoted = words.findLastIndex((word) => word.includes(noteMark));
    return wordsIn(words.slice(lastNoted + 1).join(","));
  });
}

export function readGlossary(text: string): Glossary {
  const terms: { name: string; avoid: string[] }[] = [];
  const qualify: string[] = [];
  for (const line of text.split("\n")) {
    const heading = /^\*\*(.+)\*\*:$/.exec(line)?.[1];
    if (heading !== undefined) terms.push({ name: heading, avoid: [] });
    const term = terms.at(-1);
    term?.avoid.push(...enforcedAvoidWords(line, term.name));
    qualify.push(...(listAfter("_Qualify_:", line) ?? []));
  }
  return { terms, qualify };
}

export function recordedEntries(
  file: string,
  text: string,
  list: string,
): Map<string, unknown>[] {
  const parsed: unknown = JSON.parse(text);
  const entries: unknown =
    typeof parsed === "object" && parsed !== null
      ? new Map(Object.entries(parsed)).get(list)
      : undefined;
  if (!Array.isArray(entries))
    throw new Error(
      `${file} has no "${list}" array. Repair: add "${list}": [] at its top level.`,
    );
  return entries.map(
    (entry: unknown) =>
      new Map<string, unknown>(
        typeof entry === "object" && entry !== null
          ? Object.entries(entry)
          : [],
      ),
  );
}

function recordedFields(
  file: string,
  text: string,
  list: string,
  keys: readonly string[],
): string[][] {
  return recordedEntries(file, text, list).map((own, index) => {
    const fields = keys.flatMap((key) => {
      const value = own.get(key);
      return typeof value === "string" && value !== "" ? [value] : [];
    });
    if (fields.length !== keys.length)
      throw new Error(
        `${file}: ${list}[${index}] needs a non-empty ${keys.slice(0, -1).join(", ")} and ${keys.at(-1)}. Repair: write each one as a non-empty string.`,
      );
    return fields;
  });
}

export function readRecordedHits(text: string): RecordedHit[] {
  return recordedFields(recordedHitsFile, text, "hits", [
    "path",
    "word",
    "reason",
  ]).map(([path = "", word = "", reason = ""]) => ({ path, word, reason }));
}

export function readRecordedUnusedTerms(text: string): RecordedUnusedTerm[] {
  return recordedFields(recordedUnusedTermsFile, text, "terms", [
    "term",
    "reason",
    "ticket",
  ]).map(([term = "", reason = "", ticket = ""]) => ({ term, reason, ticket }));
}

function wordsOf(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word !== "");
}

function sameWord(found: string, word: string): boolean {
  return found === word || found === `${word}s` || found === `${word}es`;
}

function holdsPhrase(words: readonly string[], phrase: readonly string[]) {
  return words.some((_, start) =>
    phrase.every((word, at) => sameWord(words[start + at] ?? "", word)),
  );
}

function hitsIn(path: string, glossary: Glossary): NameHit[] {
  const name = (path.split("/").at(-1) ?? path).replace(/^\.+/, "");
  const words = wordsOf(name);
  const base = wordsOf(name.split(".")[0] ?? "");
  const avoided = glossary.terms.flatMap((term) =>
    term.avoid.flatMap((word) =>
      holdsPhrase(words, wordsOf(word))
        ? [
            {
              path,
              word,
              problem: `, which GLOSSARY.md lists under Avoid for "${term.name}". Repair: rename it with the glossary word.`,
            },
          ]
        : [],
    ),
  );
  const unqualified = glossary.qualify.flatMap((word) =>
    base.length === 1 && sameWord(base[0] ?? "", word)
      ? [
          {
            path,
            word,
            problem: ` with no qualifier. Repair: add a word that says which ${word} it is.`,
          },
        ]
      : [],
  );
  return [...avoided, ...unqualified];
}

function problemsByKind(
  paths: readonly string[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): { fresh: string[]; stale: string[] } {
  const hits = paths.flatMap((path) => hitsIn(path, glossary));
  const same = (one: NameHit | RecordedHit, other: NameHit | RecordedHit) =>
    one.path === other.path && one.word === other.word;
  const fresh = hits.flatMap((hit) =>
    recorded.some((entry) => same(entry, hit))
      ? []
      : [`${hit.path} uses "${hit.word}"${hit.problem}`],
  );
  const stale = recorded.flatMap((entry) =>
    hits.some((hit) => same(hit, entry))
      ? []
      : [
          `${recordedHitsFile} records "${entry.word}" in ${entry.path}, which no longer occurs. Repair: remove the recorded hit.`,
        ],
  );
  return { fresh, stale };
}

export function newNameProblems(
  paths: readonly string[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): string[] {
  return problemsByKind(paths, glossary, recorded).fresh;
}

export function nameProblems(
  paths: readonly string[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
): string[] {
  const { fresh, stale } = problemsByKind(paths, glossary, recorded);
  return [...fresh, ...stale];
}

const gitMilliseconds = 10_000;

// Platform: Bun starts a child with the environment the process started with
// unless `env` is given, so a change to process.env reaches git only through it.
function git(root: string, command: readonly string[]) {
  const result = Bun.spawnSync(["git", ...command], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `names check: git ${command.join(" ")} did not exit within ${gitMilliseconds} ms. Repair: find what holds git in ${root} (a stale index.lock, a hung hook or a stalled disk), then run the check again. Done when git ${command.join(" ")} exits 0 there.`,
    );
  return result;
}

function gitPaths(root: string, command: readonly string[]): string[] {
  const listed = git(root, [...command, "-z"]);
  if (listed.exitCode !== 0)
    throw new Error(
      `git ${command.join(" ")} failed: ${listed.stderr.toString().trim()}`,
    );
  return listed.stdout
    .toString()
    .split("\0")
    .filter((path) => path !== "");
}

// Platform: existsSync follows a symlink, so it drops a tracked link whose
// target is missing; lstatSync reads the link itself.
function gitFiles(root: string): string[] {
  return gitPaths(root, ["ls-files"]).filter(
    (path) =>
      lstatSync(join(root, path), { throwIfNoEntry: false }) !== undefined,
  );
}

export function stagedNewPaths(root: string): string[] {
  return gitPaths(root, [
    "diff",
    "--cached",
    "--name-only",
    "--diff-filter=ACR",
  ]);
}

export function stagedText(root: string, path: string): string {
  const shown = git(root, ["show", `:${path}`]);
  if (shown.exitCode !== 0)
    throw new Error(
      `git has no staged ${path}, so the names check cannot judge a commit by the ${path} it will contain. Repair: stage it with git add ${path}, then run the names check again.`,
    );
  return shown.stdout.toString();
}

export function mergeBaseOf(root: string, revision: string): string {
  const found = git(root, ["merge-base", revision, "HEAD"]);
  if (found.exitCode !== 0)
    throw new Error(
      `git has no common ancestor of ${revision} and HEAD: ${found.stderr.toString().trim()} Repair: run git fetch origin, then give a revision this branch grew from.`,
    );
  return found.stdout.toString().trim();
}

export function textAt(root: string, revision: string, path: string): string {
  let shown = git(root, ["show", `${revision}:${path}`]);
  if (shown.exitCode !== 0) {
    const earlier = gitPaths(root, [
      "ls-tree",
      "-r",
      "--name-only",
      revision,
      dirname(dirname(path)),
    ]).filter((file) => basename(file) === basename(path));
    if (earlier.length === 1)
      shown = git(root, ["show", `${revision}:${earlier[0]}`]);
  }
  if (shown.exitCode !== 0)
    throw new Error(
      `git has no ${path} at ${revision}, so the names check cannot compare it with this branch. Repair: give a revision that holds ${path}.`,
    );
  return shown.stdout.toString();
}

export function namesOnPaths(paths: readonly string[]): string[] {
  const names = new Set<string>();
  for (const path of paths) {
    const parts = path.split("/");
    for (let end = 1; end <= parts.length; end += 1)
      names.add(parts.slice(0, end).join("/"));
  }
  return [...names];
}

export function trackedNames(root: string): string[] {
  return namesOnPaths(gitFiles(root)).sort();
}

export function trackedTexts(root: string): string[] {
  return gitFiles(root).flatMap((path) =>
    notReadAsUse.has(path) || !lstatSync(join(root, path)).isFile()
      ? []
      : [readFileSync(join(root, path), "utf8")],
  );
}

function pluralOf(word: string): string {
  return /[^aeiou]y$/.test(word)
    ? `(?:${word}|${word.slice(0, -1)}ies)`
    : `${word}(?:e?s)?`;
}

function usePattern(term: string): RegExp {
  const words = wordsOf(term);
  const forms = [...words.slice(0, -1), pluralOf(words.at(-1) ?? "")];

  return new RegExp(`\\b${forms.join("[\\s_-]*")}\\b`, "i");
}

function isUsed(term: string, texts: readonly string[]): boolean {
  const use = usePattern(term);
  return texts.some((text) => use.test(text));
}

export function termUseProblems(
  glossary: Glossary,
  texts: readonly string[],
  recorded: readonly RecordedUnusedTerm[],
): string[] {
  const defined = glossary.terms.map(({ name }) => name);
  const awaited = new Set(recorded.map(({ term }) => term));
  const unused = defined.flatMap((name) =>
    awaited.has(name) || isUsed(name, texts)
      ? []
      : [
          `"${name}" appears in no tracked file outside the glossary files. Repair: use it, remove it from GLOSSARY.md, or record it in ${recordedUnusedTermsFile} with the ticket that will use it.`,
        ],
  );
  const stale = recorded.flatMap(({ term }) => {
    if (!defined.includes(term))
      return [
        `${recordedUnusedTermsFile} records "${term}", which GLOSSARY.md does not define. Repair: remove the entry.`,
      ];
    return isUsed(term, texts)
      ? [
          `${recordedUnusedTermsFile} records "${term}", which a tracked file now uses. Repair: remove the entry.`,
        ]
      : [];
  });
  return [...unused, ...stale];
}
