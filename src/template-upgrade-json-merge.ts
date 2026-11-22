export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export interface JsonMergeResult {
  readonly mergedText: string;
  readonly conflictPaths: readonly string[];
}

export interface PackageDependencyChange {
  readonly section: "dependencies" | "devDependencies" | "overrides";
  readonly packageName: string;
  readonly before: string | null;
  readonly after: string | null;
}

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

function mergeJsonObjects(
  ours: { readonly [key: string]: JsonValue },
  base: JsonValue | undefined,
  next: { readonly [key: string]: JsonValue },
  path: string,
  conflicts: string[],
): { readonly [key: string]: JsonValue } {
  const baseEntries = isJsonObject(base)
    ? new Map<string, JsonValue>(Object.entries(base))
    : new Map<string, JsonValue>();
  const oursEntries = new Map<string, JsonValue>(Object.entries(ours));
  const nextEntries = new Map<string, JsonValue>(Object.entries(next));
  const mergedKeys = mergeObjectKeyOrder(
    [...oursEntries.keys()],
    Object.keys(next),
  );
  const entries: [string, JsonValue][] = [];
  for (const key of mergedKeys) {
    const value = mergeJsonValue(
      oursEntries.get(key),
      baseEntries.get(key),
      nextEntries.get(key),
      `${path}.${key}`,
      conflicts,
    );
    if (value !== undefined) {
      entries.push([key, value]);
    }
  }
  return Object.fromEntries(entries);
}

function mergeJsonValue(
  ours: JsonValue | undefined,
  base: JsonValue | undefined,
  next: JsonValue | undefined,
  path: string,
  conflicts: string[],
): JsonValue | undefined {
  if (equalJson(base, next)) {
    return ours;
  }
  if (equalJson(base, ours) || equalJson(ours, next)) {
    return next;
  }
  if (isJsonObject(ours) && isJsonObject(next)) {
    return mergeJsonObjects(ours, base, next, path, conflicts);
  }
  conflicts.push(path);
  return ours;
}

export function mergeJsonDocuments(
  ours: JsonValue,
  base: JsonValue,
  next: JsonValue,
): JsonMergeResult {
  const conflicts: string[] = [];
  const merged = mergeJsonValue(ours, base, next, "$", conflicts);
  return Object.freeze({
    mergedText: `${JSON.stringify(merged, null, 2)}\n`,
    conflictPaths: Object.freeze(conflicts),
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

export function diffPackageDependencies(
  beforeText: string | undefined,
  afterText: string | undefined,
): readonly PackageDependencyChange[] {
  const before =
    beforeText === undefined ? undefined : parseJsonValue(beforeText);
  const after = afterText === undefined ? undefined : parseJsonValue(afterText);
  const beforeValue = before?.ok ? before.value : undefined;
  const afterValue = after?.ok ? after.value : undefined;
  const changes: PackageDependencyChange[] = [];
  for (const section of DEPENDENCY_SECTIONS) {
    const beforeMap = sectionRecord(beforeValue, section);
    const afterMap = sectionRecord(afterValue, section);
    const names = [...new Set([...beforeMap.keys(), ...afterMap.keys()])].sort(
      compareCodeUnits,
    );
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
  }
  return Object.freeze(changes);
}
