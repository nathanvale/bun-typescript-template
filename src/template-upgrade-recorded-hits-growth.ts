import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve, sep } from "node:path";

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const SYMBOL_FIELDS = ["export", "name", "symbol", "type", "function"] as const;
const METADATA_KEYS = new Set([
  "kind",
  "identity",
  "analysis_identity",
  "schema_version",
  "version",
]);

export interface RecordedHitsFileGrowth {
  readonly file: string;
  readonly entries: readonly string[];
}

export function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

export function parseJsonObjectText(
  text: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

export function decodeJsonObjectBytes(
  bytes: Uint8Array,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return parseJsonObjectText(UTF8_STRICT.decode(bytes));
  } catch {
    return undefined;
  }
}

export function readWorktreeFileBytes(
  fullPath: string,
): Uint8Array | undefined {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(fullPath);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  if (!stats.isFile()) return undefined;
  return readFileSync(fullPath);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
}

function formatEntryValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(canonicalizeJson(value));
}

function countArrayItems(
  items: readonly unknown[],
): Map<string, { readonly count: number; readonly sample: unknown }> {
  const counts = new Map<
    string,
    { readonly count: number; readonly sample: unknown }
  >();
  for (const item of items) {
    const key = JSON.stringify(canonicalizeJson(item));
    const existing = counts.get(key);
    counts.set(key, {
      count: (existing?.count ?? 0) + 1,
      sample: existing?.sample ?? item,
    });
  }
  return counts;
}

function pushMapList(map: Map<string, string[]>, key: string, item: string) {
  const list = map.get(key);
  if (list !== undefined) list.push(item);
  else map.set(key, [item]);
}

function splitIdentityKey(
  key: string,
): { readonly path: string; readonly symbol: string } | undefined {
  const separator = key.indexOf("\u0000");
  if (separator <= 0 || separator === key.length - 1) return undefined;
  const symbol = key.slice(separator + 1);
  if (symbol === "<file>") return undefined;
  return {
    path: key.slice(0, separator),
    symbol,
  };
}

function recordMovedPath(
  movedPaths: Map<string, Set<string>>,
  oldPath: string,
  newPath: string,
): void {
  const existing = movedPaths.get(newPath);
  if (existing !== undefined) {
    existing.add(oldPath);
    return;
  }
  movedPaths.set(newPath, new Set([oldPath]));
}

function collectRemovedIdentities(
  beforeRecord: Readonly<Record<string, unknown>>,
  afterRecord: Readonly<Record<string, unknown>>,
): Map<string, string[]> {
  const removedBySymbol = new Map<string, string[]>();
  for (const oldKey of Object.keys(beforeRecord)) {
    if (Object.hasOwn(afterRecord, oldKey)) continue;
    const parts = splitIdentityKey(oldKey);
    if (parts !== undefined) pushMapList(removedBySymbol, parts.symbol, oldKey);
  }
  return removedBySymbol;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function symbolPartPresentInSource(text: string, part: string): boolean {
  if (/^[$\w]+$/.test(part)) {
    return new RegExp(`(?<![$\\w])${escapeRegExp(part)}(?![$\\w])`).test(text);
  }
  return text.includes(part);
}

function symbolExistsInSource(text: string, symbol: string): boolean {
  const parts = symbol.split(/[.#]/).filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  return parts.every((part) => symbolPartPresentInSource(text, part));
}

function resolveWorktreePath(
  worktree: string,
  relativePath: string,
): string | undefined {
  if (
    relativePath === "" ||
    relativePath.includes("\u0000") ||
    isAbsolute(relativePath)
  ) {
    return undefined;
  }
  const root = resolve(worktree);
  const fullPath = resolve(root, relativePath);
  return fullPath.startsWith(`${root}${sep}`) ? fullPath : undefined;
}

function oldPathAllowsMove(
  worktree: string,
  oldPath: string,
  symbol: string | undefined,
): boolean {
  const fullPath = resolveWorktreePath(worktree, oldPath);
  if (fullPath === undefined) return false;
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(fullPath);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return true;
    throw error;
  }
  if (symbol === undefined || !stats.isFile()) return false;
  let text: string;
  try {
    text = UTF8_STRICT.decode(readFileSync(fullPath));
  } catch {
    return false;
  }
  return !symbolExistsInSource(text, symbol);
}

function findMatchingRemovedIdentity(
  worktree: string,
  symbol: string,
  afterValue: unknown,
  removedBySymbol: ReadonlyMap<string, readonly string[]>,
  beforeRecord: Readonly<Record<string, unknown>>,
  consumed: ReadonlySet<string>,
): string | undefined {
  const candidates = removedBySymbol.get(symbol);
  if (candidates === undefined) return undefined;
  for (const oldKey of candidates) {
    if (consumed.has(oldKey)) continue;
    const oldParts = splitIdentityKey(oldKey);
    if (
      oldParts === undefined ||
      !oldPathAllowsMove(worktree, oldParts.path, oldParts.symbol)
    ) {
      continue;
    }
    if (
      propertyGrowthEntries(worktree, "", beforeRecord[oldKey], afterValue)
        .length === 0
    ) {
      return oldKey;
    }
  }
  return undefined;
}

function compareKeyedCountTable(
  worktree: string,
  fieldName: string,
  beforeValue: unknown,
  afterValue: unknown,
  matchAdded: (
    key: string,
    entryValue: unknown,
    beforeRecord: Readonly<Record<string, unknown>>,
    afterRecord: Readonly<Record<string, unknown>>,
  ) => boolean,
): string[] {
  const afterRecord = asRecord(afterValue);
  if (afterRecord === undefined) {
    return propertyGrowthEntries(worktree, fieldName, beforeValue, afterValue);
  }
  const beforeRecord = beforeValue === undefined ? {} : asRecord(beforeValue);
  if (beforeRecord === undefined) return [fieldName];
  const grown: string[] = [];
  for (const [key, entryValue] of Object.entries(afterRecord)) {
    const nestedPath = `${fieldName}.${key}`;
    if (Object.hasOwn(beforeRecord, key)) {
      grown.push(
        ...propertyGrowthEntries(
          worktree,
          nestedPath,
          beforeRecord[key],
          entryValue,
        ),
      );
      continue;
    }
    if (!matchAdded(key, entryValue, beforeRecord, afterRecord)) {
      grown.push(nestedPath);
    }
  }
  return grown;
}

function identityFindingCountsGrowth(
  worktree: string,
  beforeValue: unknown,
  afterValue: unknown,
  movedPaths: Map<string, Set<string>>,
): string[] {
  const consumed = new Set<string>();
  let removedBySymbol: Map<string, string[]> | undefined;
  return compareKeyedCountTable(
    worktree,
    "identity_finding_counts",
    beforeValue,
    afterValue,
    (key, entryValue, beforeRecord, afterRecord) => {
      removedBySymbol ??= collectRemovedIdentities(beforeRecord, afterRecord);
      const parts = splitIdentityKey(key);
      if (parts === undefined) return false;
      const matched = findMatchingRemovedIdentity(
        worktree,
        parts.symbol,
        entryValue,
        removedBySymbol,
        beforeRecord,
        consumed,
      );
      if (matched === undefined) return false;
      consumed.add(matched);
      const oldParts = splitIdentityKey(matched);
      if (oldParts !== undefined) {
        recordMovedPath(movedPaths, oldParts.path, parts.path);
      }
      return true;
    },
  );
}

function findMatchingMovedPath(
  worktree: string,
  newPath: string,
  afterValue: unknown,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
  beforeRecord: Readonly<Record<string, unknown>>,
  afterRecord: Readonly<Record<string, unknown>>,
  consumed: ReadonlySet<string>,
): string | undefined {
  const oldPaths = movedPaths.get(newPath);
  if (oldPaths === undefined) return undefined;
  for (const oldPath of oldPaths) {
    if (consumed.has(oldPath)) continue;
    if (!Object.hasOwn(beforeRecord, oldPath)) continue;
    if (Object.hasOwn(afterRecord, oldPath)) continue;
    if (
      propertyGrowthEntries(worktree, "", beforeRecord[oldPath], afterValue)
        .length === 0
    ) {
      return oldPath;
    }
  }
  return undefined;
}

function findingCountsGrowth(
  worktree: string,
  beforeValue: unknown,
  afterValue: unknown,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const consumed = new Set<string>();
  return compareKeyedCountTable(
    worktree,
    "finding_counts",
    beforeValue,
    afterValue,
    (key, entryValue, beforeRecord, afterRecord) => {
      const matched = findMatchingMovedPath(
        worktree,
        key,
        entryValue,
        movedPaths,
        beforeRecord,
        afterRecord,
        consumed,
      );
      if (matched === undefined) return false;
      consumed.add(matched);
      return true;
    },
  );
}

function movedStringCounterpartKeys(
  item: string,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const keys: string[] = [];
  for (const [newPath, oldPaths] of movedPaths) {
    if (
      item !== newPath &&
      !item.startsWith(`${newPath}:`) &&
      !item.startsWith(`${newPath}\u0000`)
    ) {
      continue;
    }
    const suffix = item.slice(newPath.length);
    for (const oldPath of oldPaths) {
      keys.push(JSON.stringify(`${oldPath}${suffix}`));
    }
  }
  return keys;
}

function objectWithoutPathKey(value: unknown): string | undefined {
  const record = asRecord(value);
  if (record === undefined || typeof record.path !== "string") return undefined;
  const rest = Object.entries(record).filter(([key]) => key !== "path");
  if (rest.length === 0) return undefined;
  return JSON.stringify(canonicalizeJson(Object.fromEntries(rest)));
}

function parseDeadCodeString(
  value: unknown,
):
  | { readonly kind: string; readonly path: string; readonly symbol: string }
  | undefined {
  if (typeof value !== "string") return undefined;
  const firstColon = value.indexOf(":");
  const lastColon = value.lastIndexOf(":");
  if (firstColon <= 0 || lastColon <= firstColon + 1) return undefined;
  const path = value.slice(firstColon + 1, lastColon);
  const symbol = value.slice(lastColon + 1);
  if (symbol === "" || (!path.includes("/") && !path.includes("."))) {
    return undefined;
  }
  return { kind: value.slice(0, firstColon), path, symbol };
}

function itemWithoutPathKey(value: unknown): string | undefined {
  const deadCode = parseDeadCodeString(value);
  if (deadCode !== undefined) {
    return `string:${deadCode.kind}\u0000${deadCode.symbol}`;
  }
  return objectWithoutPathKey(value);
}

function consumeOneCandidate(
  keys: readonly string[] | undefined,
  removedCounts: Map<string, number>,
): boolean {
  if (keys === undefined) return false;
  for (const key of keys) {
    const remaining = removedCounts.get(key) ?? 0;
    if (remaining > 0) {
      removedCounts.set(key, remaining - 1);
      return true;
    }
  }
  return false;
}

function takeMovedArrayCounterpart(
  sample: unknown,
  removedCounts: Map<string, number>,
  removedByNonPath: ReadonlyMap<string, readonly string[]>,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
): boolean {
  if (
    typeof sample === "string" &&
    consumeOneCandidate(
      movedStringCounterpartKeys(sample, movedPaths),
      removedCounts,
    )
  ) {
    return true;
  }
  const nonPathKey = itemWithoutPathKey(sample);
  return nonPathKey === undefined
    ? false
    : consumeOneCandidate(removedByNonPath.get(nonPathKey), removedCounts);
}

function arrayOriginMoved(worktree: string, sample: unknown): boolean {
  const deadCode = parseDeadCodeString(sample);
  if (deadCode !== undefined) {
    return oldPathAllowsMove(worktree, deadCode.path, deadCode.symbol);
  }
  const record = asRecord(sample);
  if (record === undefined || typeof record.path !== "string") return false;
  for (const field of SYMBOL_FIELDS) {
    const candidate = Object.hasOwn(record, field) ? record[field] : undefined;
    if (typeof candidate === "string" && candidate !== "") {
      return oldPathAllowsMove(worktree, record.path, candidate);
    }
  }
  return oldPathAllowsMove(worktree, record.path, undefined);
}

function collectRemovedArrayEntries(
  worktree: string,
  beforeCounts: ReadonlyMap<
    string,
    { readonly count: number; readonly sample: unknown }
  >,
  afterCounts: ReadonlyMap<
    string,
    { readonly count: number; readonly sample: unknown }
  >,
): {
  readonly removedCounts: Map<string, number>;
  readonly removedByNonPath: Map<string, string[]>;
} {
  const removedCounts = new Map<string, number>();
  const removedByNonPath = new Map<string, string[]>();
  for (const [key, { count, sample }] of beforeCounts) {
    const afterCount = afterCounts.get(key)?.count ?? 0;
    if (count <= afterCount) continue;
    removedCounts.set(key, count - afterCount);
    const nonPathKey = itemWithoutPathKey(sample);
    if (nonPathKey !== undefined && arrayOriginMoved(worktree, sample)) {
      pushMapList(removedByNonPath, nonPathKey, key);
    }
  }
  return { removedCounts, removedByNonPath };
}

function formatArrayGrowthEntry(
  fieldPath: string,
  sample: unknown,
  prior: number,
  unmatched: number,
): string {
  return prior === 0
    ? `${fieldPath}: ${formatEntryValue(sample)}`
    : `${fieldPath}: ${formatEntryValue(sample)} (${prior} -> ${prior + unmatched})`;
}

function arrayGrowthEntries(
  worktree: string,
  fieldPath: string,
  beforeValue: unknown,
  afterValue: readonly unknown[],
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  if (beforeValue !== undefined && !Array.isArray(beforeValue)) {
    return [fieldPath];
  }
  const beforeCounts = countArrayItems(beforeValue ?? []);
  const afterCounts = countArrayItems(afterValue);
  const { removedCounts, removedByNonPath } = collectRemovedArrayEntries(
    worktree,
    beforeCounts,
    afterCounts,
  );
  const grown: string[] = [];
  for (const [key, { count, sample }] of afterCounts) {
    const prior = beforeCounts.get(key)?.count ?? 0;
    let unmatched = count - prior;
    while (
      unmatched > 0 &&
      takeMovedArrayCounterpart(
        sample,
        removedCounts,
        removedByNonPath,
        movedPaths,
      )
    ) {
      unmatched -= 1;
    }
    if (unmatched > 0) {
      grown.push(formatArrayGrowthEntry(fieldPath, sample, prior, unmatched));
    }
  }
  return grown;
}

function objectGrowthEntries(
  worktree: string,
  fieldPath: string,
  beforeValue: unknown,
  afterValue: Readonly<Record<string, unknown>>,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  const beforeRecord = beforeValue === undefined ? {} : asRecord(beforeValue);
  if (beforeRecord === undefined) return [fieldPath];
  const grown: string[] = [];
  for (const [key, entryValue] of Object.entries(afterValue)) {
    const nestedPath = fieldPath === "" ? key : `${fieldPath}.${key}`;
    const prior = Object.hasOwn(beforeRecord, key)
      ? beforeRecord[key]
      : undefined;
    grown.push(
      ...propertyGrowthEntries(
        worktree,
        nestedPath,
        prior,
        entryValue,
        movedPaths,
      ),
    );
  }
  return grown;
}

function propertyGrowthEntries(
  worktree: string,
  fieldPath: string,
  beforeValue: unknown,
  afterValue: unknown,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>> = new Map(),
): string[] {
  if (Array.isArray(afterValue)) {
    return arrayGrowthEntries(
      worktree,
      fieldPath,
      beforeValue,
      afterValue,
      movedPaths,
    );
  }
  const afterRecord = asRecord(afterValue);
  if (afterRecord !== undefined) {
    return objectGrowthEntries(
      worktree,
      fieldPath,
      beforeValue,
      afterRecord,
      movedPaths,
    );
  }
  if (beforeValue === undefined) return [fieldPath];
  if (typeof afterValue === "number" && typeof beforeValue === "number") {
    return afterValue > beforeValue
      ? [`${fieldPath} (${beforeValue} -> ${afterValue})`]
      : [];
  }
  return JSON.stringify(canonicalizeJson(beforeValue)) ===
    JSON.stringify(canonicalizeJson(afterValue))
    ? []
    : [fieldPath];
}

function fieldGrowthForTopLevelKey(
  worktree: string,
  key: string,
  beforeValue: unknown,
  afterValue: unknown,
  movedPaths: ReadonlyMap<string, ReadonlySet<string>>,
): string[] {
  if (key === "finding_counts") {
    return findingCountsGrowth(worktree, beforeValue, afterValue, movedPaths);
  }
  return propertyGrowthEntries(
    worktree,
    key,
    beforeValue,
    afterValue,
    movedPaths,
  );
}

function fileGrowthEntries(
  worktree: string,
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): string[] {
  const before = decodeJsonObjectBytes(beforeBytes);
  const after = decodeJsonObjectBytes(afterBytes);
  if (before === undefined || after === undefined) {
    return ["unreadable recorded-hits JSON"];
  }
  const movedPaths = new Map<string, Set<string>>();
  const beforeIdentities = Object.hasOwn(before, "identity_finding_counts")
    ? before.identity_finding_counts
    : undefined;
  const grown: string[] = Object.hasOwn(after, "identity_finding_counts")
    ? identityFindingCountsGrowth(
        worktree,
        beforeIdentities,
        after.identity_finding_counts,
        movedPaths,
      )
    : [];
  for (const [key, afterValue] of Object.entries(after)) {
    if (METADATA_KEYS.has(key) || key === "identity_finding_counts") continue;
    const beforeValue = Object.hasOwn(before, key) ? before[key] : undefined;
    grown.push(
      ...fieldGrowthForTopLevelKey(
        worktree,
        key,
        beforeValue,
        afterValue,
        movedPaths,
      ),
    );
  }
  return grown;
}

export function findRecordedHitsGrowth(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
): RecordedHitsFileGrowth[] {
  const growth: RecordedHitsFileGrowth[] = [];
  for (const [file, beforeBytes] of snapshots) {
    const afterBytes = readWorktreeFileBytes(join(worktree, file));
    if (beforeBytes === undefined) {
      if (afterBytes !== undefined) {
        growth.push({ file, entries: ["file added"] });
      }
      continue;
    }
    if (afterBytes === undefined) {
      growth.push({ file, entries: ["file removed"] });
      continue;
    }
    const entries = fileGrowthEntries(worktree, beforeBytes, afterBytes);
    if (entries.length > 0) {
      growth.push({ file, entries });
    }
  }
  return growth;
}
