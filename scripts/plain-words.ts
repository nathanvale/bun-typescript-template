import { type Glossary, hitsIn, readGlossary } from "./glossary.ts";
import { listedEntries } from "./glossary-ownership.ts";
import type { PathItem } from "./name-moves.ts";
import type { PublicDeclaration } from "./public-declarations.ts";

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
  readonly avoidTerms: ReadonlyMap<string, readonly string[]>;
};

const patchPrefix = "tests/planted-faults/patches/";
const leadingDatePrefix = /^(\d{4})-(\d{2})-(\d{2})-(?=[^.])/;
const glossaryNote = /\([^()]*\)/g;

export function splitWords(text: string): string[] {
  return text
    .normalize("NFC")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== "");
}

function isCalendarDate(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function stripDatePrefix(segment: string): string {
  const match = leadingDatePrefix.exec(segment);
  if (match === null) return segment;
  if (!isCalendarDate(Number(match[1]), Number(match[2]), Number(match[3])))
    return segment;
  return segment.slice(match[0].length);
}

function stripFilePrefix(path: string, segment: string): string {
  if (path.startsWith(patchPrefix) && segment.endsWith(".patch")) {
    const withoutCommit = segment.replace(/^[0-9a-f]{7,40}-/, "");
    if (withoutCommit !== segment) return withoutCommit;
  }
  return stripDatePrefix(segment);
}

export function segmentWords(path: string, isFile: boolean): string[] {
  let segment = path.slice(path.lastIndexOf("/") + 1);
  if (isFile) segment = stripFilePrefix(path, segment);
  const trimmed = segment.replace(/^\.+/, "");
  if (!isFile) return splitWords(trimmed);
  const dot = trimmed.lastIndexOf(".");
  return splitWords(dot > 0 ? trimmed.slice(0, dot) : trimmed);
}

export function matchesWord(words: ReadonlySet<string>, word: string): boolean {
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

function singleAvoidWords(line: string): string[] {
  if (!line.startsWith("_Avoid_:")) return [];
  const stripped = line.slice("_Avoid_:".length).replace(glossaryNote, "");
  return stripped.split(/[;,]/).flatMap((part) => {
    const parts = splitWords(part.trim());
    return parts.length === 1 && parts[0] !== undefined ? [parts[0]] : [];
  });
}

function avoidTermsByWord(glossaryText: string): Map<string, string[]> {
  const byWord = new Map<string, string[]>();
  let currentTerm: string | undefined;
  for (const line of glossaryText.split("\n")) {
    const heading = /^\*\*(.+)\*\*:$/.exec(line)?.[1];
    if (heading !== undefined) {
      currentTerm = heading;
      continue;
    }
    if (currentTerm === undefined) continue;
    for (const word of singleAvoidWords(line)) {
      const existing = byWord.get(word) ?? [];
      if (!existing.includes(currentTerm)) existing.push(currentTerm);
      byWord.set(word, existing);
    }
  }
  return byWord;
}

function listedQualifyWords(glossaryText: string): Set<string> {
  const words = new Set<string>();
  for (const line of glossaryText.split("\n")) {
    if (!line.startsWith("_Qualify_:")) continue;
    for (const part of line.slice("_Qualify_:".length).split(","))
      for (const word of splitWords(part.trim())) words.add(word);
  }
  return words;
}

export function blockedBaseWords(
  avoidTerms: ReadonlyMap<string, readonly string[]>,
  glossaryText: string,
): Set<string> {
  return new Set([...avoidTerms.keys(), ...listedQualifyWords(glossaryText)]);
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
  if (
    !/^[\p{L}\p{N}]+$/u.test(word) ||
    word !== word.normalize("NFC") ||
    word !== word.toLowerCase()
  )
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
  return {
    known,
    plain: readPlainWords(plainText, known),
    avoidTerms: avoidTermsByWord(glossaryText),
  };
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

function avoidTermsFor(
  avoidTerms: ReadonlyMap<string, readonly string[]>,
  word: string,
): readonly string[] {
  const exact = avoidTerms.get(word);
  if (exact !== undefined) return exact;
  const plural = avoidTerms.get(`${word}s`);
  if (plural !== undefined) return plural;
  if (word.endsWith("s") && word.length > 1)
    return avoidTerms.get(word.slice(0, -1)) ?? [];
  return [];
}

function unknownReason(words: NameWords, word: string): string {
  const terms = avoidTermsFor(words.avoidTerms, word);
  if (terms.length > 0)
    return `which GLOSSARY.md lists under Avoid for ${terms.map((term) => `"${term}"`).join(", ")}`;
  return "which no glossary term uses";
}

function unknownWordRepair(target: string): string {
  return `Repair: Look in the glossary first; if it has a word for this, use it. Otherwise propose the word for the names table in your pull request (the plain-words list or a new glossary entry), for Nathan's decision. Done when bun run check:names ${target} passes.`;
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

function isPlantedFaultPatch(path: string, isFile: boolean): boolean {
  return isFile && path.startsWith(patchPrefix) && path.endsWith(".patch");
}

function isExportedDeclaration({ declaration }: PublicDeclaration): boolean {
  return !declaration.includes(".");
}

export function unknownPathProblems(
  words: NameWords,
  glossary: Glossary,
  items: readonly PathItem[],
): string[] {
  return items.flatMap(({ path, isFile }) =>
    isPlantedFaultPatch(path, isFile)
      ? []
      : unknownWordsOf(
          words,
          coveredByGlossaryRule(path, glossary),
          segmentWords(path, isFile),
        ).map(
          (word) =>
            `${path} uses "${word}", ${unknownReason(words, word)}. ${unknownWordRepair(path)}`,
        ),
  );
}

export function unknownDeclarationProblems(
  words: NameWords,
  glossary: Glossary,
  declarations: readonly PublicDeclaration[],
): string[] {
  return declarations
    .filter(isExportedDeclaration)
    .flatMap(({ path, line, name }) =>
      unknownWordsOf(
        words,
        coveredByGlossaryRule(path, glossary, name),
        splitWords(name),
      ).map(
        (word) =>
          `${path}:${line} public declaration "${name}" uses "${word}", ${unknownReason(words, word)}. ${unknownWordRepair(path)}`,
      ),
    );
}
