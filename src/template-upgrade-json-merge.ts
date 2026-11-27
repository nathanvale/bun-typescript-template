import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitMergeFile } from "./template-upgrade-git.ts";
import { mergeDuplicatesMember } from "./template-upgrade-json-members.ts";
import { assertNoSymlinkAncestors } from "./template-upgrade-worktree.ts";

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonKeyConflict {
  readonly path: string;
  readonly base?: JsonValue;
  readonly ours?: JsonValue;
  readonly next?: JsonValue;
}

export interface JsonMergeResult {
  readonly mergedText: string;
  readonly markedText: string;
  readonly conflictPaths: readonly string[];
  readonly conflicts: readonly JsonKeyConflict[];
}

export interface PackageDependencyChange {
  readonly section: "dependencies" | "devDependencies" | "overrides";
  readonly packageName: string;
  readonly before: string | null;
  readonly after: string | null;
}

export interface PackageChangesResult {
  readonly changes: readonly PackageDependencyChange[];
  readonly unavailableReason?: string;
}

type RenderedMember =
  | {
      readonly kind: "clean";
      readonly key: string;
      readonly rendered: string;
    }
  | {
      readonly kind: "conflict";
      readonly key: string;
      readonly ours: JsonValue | undefined;
      readonly next: JsonValue | undefined;
    };

const DEPENDENCY_SECTIONS: readonly PackageDependencyChange["section"][] = [
  "dependencies",
  "devDependencies",
  "overrides",
];

function isJsonObject(
  value: JsonValue | undefined,
): value is { readonly [key: string]: JsonValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function equalJson(
  left: JsonValue | undefined,
  right: JsonValue | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatJsonIndented(value: JsonValue, indent: number): string {
  const serialized = JSON.stringify(value, null, 2);
  if (indent === 0) {
    return serialized;
  }
  const prefix = " ".repeat(indent);
  return serialized.replaceAll("\n", `\n${prefix}`);
}

function makeJsonKeyConflict(
  path: string,
  base: JsonValue | undefined,
  ours: JsonValue | undefined,
  next: JsonValue | undefined,
): JsonKeyConflict {
  return Object.freeze({
    path,
    ...(base === undefined ? {} : { base }),
    ...(ours === undefined ? {} : { ours }),
    ...(next === undefined ? {} : { next }),
  });
}

function mergeObjectKeyOrder(
  oursKeys: readonly string[],
  nextKeys: readonly string[],
): string[] {
  const mergedKeys = [...oursKeys];
  for (let index = 0; index < nextKeys.length; index += 1) {
    const key = nextKeys[index];
    if (key === undefined || mergedKeys.includes(key)) {
      continue;
    }
    const earlier = nextKeys
      .slice(0, index)
      .reverse()
      .find((candidate) => mergedKeys.includes(candidate));
    const insertAt =
      earlier === undefined ? 0 : mergedKeys.indexOf(earlier) + 1;
    mergedKeys.splice(insertAt, 0, key);
  }
  return mergedKeys;
}

function renderObjectMembers(
  members: readonly RenderedMember[],
  indent: number,
): string {
  if (members.length === 0) {
    return "{}";
  }
  const memberIndent = " ".repeat(indent + 2);
  const closeIndent = " ".repeat(indent);
  const lines = members.map((member, index) => {
    const comma = index < members.length - 1 ? "," : "";
    if (member.kind === "clean") {
      return `${memberIndent}${JSON.stringify(member.key)}: ${member.rendered}${comma}`;
    }
    const oursBlock =
      member.ours === undefined
        ? ""
        : `${memberIndent}${JSON.stringify(member.key)}: ${formatJsonIndented(member.ours, indent + 2)}${comma}\n`;
    const nextBlock =
      member.next === undefined
        ? ""
        : `${memberIndent}${JSON.stringify(member.key)}: ${formatJsonIndented(member.next, indent + 2)}${comma}\n`;
    return `<<<<<<< ours\n${oursBlock}=======\n${nextBlock}>>>>>>> new`;
  });
  return `{\n${lines.join("\n")}\n${closeIndent}}`;
}

type JsonObject = { readonly [key: string]: JsonValue };

interface MergedObjectMember {
  readonly entry?: readonly [string, JsonValue];
  readonly member?: RenderedMember;
}

function cleanJsonMember(
  key: string,
  value: JsonValue | undefined,
  indent: number,
): MergedObjectMember {
  if (value === undefined) {
    return {};
  }
  return {
    entry: [key, value],
    member: {
      kind: "clean",
      key,
      rendered: formatJsonIndented(value, indent),
    },
  };
}

function mergeJsonObjectMember(options: {
  readonly key: string;
  readonly oursValue: JsonValue | undefined;
  readonly baseValue: JsonValue | undefined;
  readonly nextValue: JsonValue | undefined;
  readonly path: string;
  readonly conflicts: JsonKeyConflict[];
  readonly indent: number;
}): MergedObjectMember {
  const { key, oursValue, baseValue, nextValue, path, conflicts, indent } =
    options;
  if (equalJson(baseValue, nextValue)) {
    return cleanJsonMember(key, oursValue, indent);
  }
  if (equalJson(baseValue, oursValue) || equalJson(oursValue, nextValue)) {
    return cleanJsonMember(key, nextValue, indent);
  }
  if (isJsonObject(oursValue) && isJsonObject(nextValue)) {
    const child = mergeJsonObjects({
      ours: oursValue,
      base: baseValue,
      next: nextValue,
      path,
      conflicts,
      indent,
    });
    return {
      entry: [key, child.value],
      member: { kind: "clean", key, rendered: child.marked },
    };
  }
  conflicts.push(makeJsonKeyConflict(path, baseValue, oursValue, nextValue));
  return {
    ...(oursValue === undefined ? {} : { entry: [key, oursValue] }),
    member: { kind: "conflict", key, ours: oursValue, next: nextValue },
  };
}

function mergeJsonObjects(options: {
  readonly ours: JsonObject;
  readonly base: JsonValue | undefined;
  readonly next: JsonObject;
  readonly path: string;
  readonly conflicts: JsonKeyConflict[];
  readonly indent: number;
}): {
  readonly value: JsonObject;
  readonly marked: string;
} {
  const { ours, base, next, path, conflicts, indent } = options;
  const baseEntries = isJsonObject(base)
    ? new Map<string, JsonValue>(Object.entries(base))
    : new Map<string, JsonValue>();
  const oursEntries = new Map<string, JsonValue>(Object.entries(ours));
  const nextEntries = new Map<string, JsonValue>(Object.entries(next));
  const mergedKeys = mergeObjectKeyOrder(
    [...oursEntries.keys()],
    Object.keys(next),
  );
  const entries: (readonly [string, JsonValue])[] = [];
  const members: RenderedMember[] = [];
  for (const key of mergedKeys) {
    const result = mergeJsonObjectMember({
      key,
      oursValue: oursEntries.get(key),
      baseValue: baseEntries.get(key),
      nextValue: nextEntries.get(key),
      path: `${path}.${key}`,
      conflicts,
      indent: indent + 2,
    });
    if (result.entry !== undefined) {
      entries.push(result.entry);
    }
    if (result.member !== undefined) {
      members.push(result.member);
    }
  }
  return {
    value: Object.fromEntries(entries),
    marked: renderObjectMembers(members, indent),
  };
}

export function mergeJsonDocuments(
  ours: JsonValue,
  base: JsonValue,
  next: JsonValue,
): JsonMergeResult {
  const conflicts: JsonKeyConflict[] = [];
  if (equalJson(base, next)) {
    const mergedText = `${JSON.stringify(ours, null, 2)}\n`;
    return Object.freeze({
      mergedText,
      markedText: mergedText,
      conflictPaths: Object.freeze([]),
      conflicts: Object.freeze([]),
    });
  }
  if (equalJson(base, ours) || equalJson(ours, next)) {
    const mergedText = `${JSON.stringify(next, null, 2)}\n`;
    return Object.freeze({
      mergedText,
      markedText: mergedText,
      conflictPaths: Object.freeze([]),
      conflicts: Object.freeze([]),
    });
  }
  if (isJsonObject(ours) && isJsonObject(next)) {
    const merged = mergeJsonObjects({
      ours,
      base,
      next,
      path: "$",
      conflicts,
      indent: 0,
    });
    return Object.freeze({
      mergedText: `${JSON.stringify(merged.value, null, 2)}\n`,
      markedText: `${merged.marked}\n`,
      conflictPaths: Object.freeze(conflicts.map((conflict) => conflict.path)),
      conflicts: Object.freeze(conflicts),
    });
  }
  conflicts.push(makeJsonKeyConflict("$", base, ours, next));
  return Object.freeze({
    mergedText: `${JSON.stringify(ours, null, 2)}\n`,
    markedText:
      `<<<<<<< ours\n` +
      `${formatJsonIndented(ours, 0)}\n` +
      `=======\n` +
      `${formatJsonIndented(next, 0)}\n` +
      `>>>>>>> new\n`,
    conflictPaths: Object.freeze(["$"]),
    conflicts: Object.freeze(conflicts),
  });
}

function parseJsonValue(
  text: string,
): { readonly ok: true; readonly value: JsonValue } | { readonly ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as JsonValue };
  } catch {
    return { ok: false };
  }
}

export function tryMergeJsonText(
  oursText: string,
  baseText: string,
  nextText: string,
): JsonMergeResult | undefined {
  const ours = parseJsonValue(oursText);
  const base = parseJsonValue(baseText);
  const next = parseJsonValue(nextText);
  if (!ours.ok || !base.ok || !next.ok) {
    return undefined;
  }
  return mergeJsonDocuments(ours.value, base.value, next.value);
}

function sectionRecord(
  document: JsonValue | undefined,
  section: PackageDependencyChange["section"],
): Map<string, string> {
  const entries = new Map<string, string>();
  if (!isJsonObject(document)) {
    return entries;
  }
  const top = new Map<string, JsonValue>(Object.entries(document));
  const raw = top.get(section);
  if (!isJsonObject(raw)) {
    return entries;
  }
  for (const [name, version] of Object.entries(raw)) {
    if (typeof version === "string") {
      entries.set(name, version);
    }
  }
  return entries;
}

function parsePackageJsonObject(
  text: string | undefined,
):
  | { readonly ok: true; readonly value: JsonValue | undefined }
  | { readonly ok: false } {
  if (text === undefined) {
    return { ok: true, value: undefined };
  }
  const parsed = parseJsonValue(text);
  if (!parsed.ok || !isJsonObject(parsed.value)) {
    return { ok: false };
  }
  return { ok: true, value: parsed.value };
}

function diffDependencySection(
  beforeValue: JsonValue | undefined,
  afterValue: JsonValue | undefined,
  section: PackageDependencyChange["section"],
): PackageDependencyChange[] {
  const beforeMap = sectionRecord(beforeValue, section);
  const afterMap = sectionRecord(afterValue, section);
  const names = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(
    compareCodeUnits,
  );
  const changes: PackageDependencyChange[] = [];
  for (const packageName of names) {
    const beforeVersion = beforeMap.get(packageName) ?? null;
    const afterVersion = afterMap.get(packageName) ?? null;
    if (beforeVersion !== afterVersion) {
      changes.push(
        Object.freeze({
          section,
          packageName,
          before: beforeVersion,
          after: afterVersion,
        }),
      );
    }
  }
  return changes;
}

export function readPackageChanges(
  beforeText: string | undefined,
  afterText: string | undefined,
): PackageChangesResult {
  const before = parsePackageJsonObject(beforeText);
  if (!before.ok) {
    return Object.freeze({
      changes: Object.freeze([]),
      unavailableReason: "current package.json could not be parsed as JSON",
    });
  }
  const after = parsePackageJsonObject(afterText);
  if (!after.ok) {
    return Object.freeze({
      changes: Object.freeze([]),
      unavailableReason: "merged package.json could not be parsed as JSON",
    });
  }
  const changes = DEPENDENCY_SECTIONS.flatMap((section) =>
    diffDependencySection(before.value, after.value, section),
  );
  return Object.freeze({ changes: Object.freeze(changes) });
}

export function diffPackageDependencies(
  beforeText: string | undefined,
  afterText: string | undefined,
): readonly PackageDependencyChange[] {
  return readPackageChanges(beforeText, afterText).changes;
}

const STRICT_UTF8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

function decodeUtf8IfValid(bytes: Uint8Array): string | undefined {
  try {
    return STRICT_UTF8.decode(bytes);
  } catch {
    return undefined;
  }
}

function withTrailingNewline(content: string): string {
  return content === "" || content.endsWith("\n") ? content : `${content}\n`;
}

export async function mergeJsonUpgradeFile(options: {
  readonly targetFolder: string;
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly relativePath: string;
  readonly oursBytes: Uint8Array;
  readonly oldBytes: Uint8Array;
  readonly newBytes: Uint8Array;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly keyMergedPaths: Set<string>;
  readonly mergedJsonTexts: Map<string, string>;
}): Promise<{
  readonly outcome: "merge" | "conflict";
  readonly keyConflicts?: readonly JsonKeyConflict[];
}> {
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
  const oursText = decodeUtf8IfValid(oursBytes);
  const oldText = decodeUtf8IfValid(oldBytes);
  const newText = decodeUtf8IfValid(newBytes);
  if (
    oursText === undefined ||
    oldText === undefined ||
    newText === undefined
  ) {
    return {
      outcome:
        gitMergeFile(oursPath, oldPath, newPath, env) === "clean"
          ? "merge"
          : "conflict",
    };
  }
  const json = tryMergeJsonText(oursText, oldText, newText);
  if (json !== undefined) {
    options.mergedJsonTexts.set(relativePath, json.mergedText);
    options.keyMergedPaths.add(relativePath);
    if (json.conflictPaths.length === 0) {
      await writeFile(oursPath, json.mergedText);
      return { outcome: "merge" };
    }
    await writeFile(oursPath, json.markedText);
    return { outcome: "conflict", keyConflicts: json.conflicts };
  }
  const textResult = gitMergeFile(oursPath, oldPath, newPath, env);
  if (!mergeDuplicatesMember(await readFile(oursPath, "utf8"))) {
    return { outcome: textResult === "clean" ? "merge" : "conflict" };
  }
  await writeFile(
    oursPath,
    `<<<<<<< ours\n` +
      `${withTrailingNewline(oursText)}` +
      `=======\n` +
      `${withTrailingNewline(newText)}` +
      `>>>>>>> new\n`,
  );
  return { outcome: "conflict" };
}
