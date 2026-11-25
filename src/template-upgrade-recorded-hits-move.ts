import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import { runGitCommand } from "./template-upgrade-git.ts";

const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const SOURCE_FILE_PATTERN = /\.(?:[cm]?[jt]s|[jt]sx)$/i;

type FileReadResult =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable" };

export interface WorktreeSourceReader {
  readonly worktree: string;
  readAll(): ReadonlyMap<string, string> | undefined;
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

function identifierDefinedInSource(text: string, identifier: string): boolean {
  if (identifier === "default") {
    return /\bexport\s+default\b/.test(text);
  }
  if (!/^[$\w]+$/.test(identifier)) {
    return text.includes(identifier);
  }
  const id = escapeRegExp(identifier);
  const declarationPattern = new RegExp(
    `(?:^|[;{}])\\s*(?:export\\s+(?:default\\s+)?)?(?:declare\\s+)?(?:abstract\\s+|const\\s+|async\\s+)?(?:function\\s*\\*?|class|interface|type|enum|namespace|const|let|var)\\s+${id}(?![$\\w])`,
    "m",
  );
  if (declarationPattern.test(text)) return true;
  if (new RegExp(`\\bfunction\\s*\\*?\\s*${id}(?![$\\w])`).test(text)) {
    return true;
  }
  const methodPattern = new RegExp(
    `^\\s*(?:(?:public|private|protected|static|readonly|override|abstract|async|declare|get|set)\\s+)*\\*?\\s*${id}\\s*(?:<[^>\\n]*>\\s*)?\\([^)\\n]*\\)\\s*(?::[^{\\n]+)?\\{`,
    "m",
  );
  if (methodPattern.test(text)) return true;
  const propertyFunctionPattern = new RegExp(
    `(?<![$\\w])${id}\\s*:\\s*(?:async\\s+)?(?:function\\b|\\([^)\\n]*\\)\\s*(?::[^\\n=>]+)?=>|[$\\w]+\\s*=>)`,
  );
  if (propertyFunctionPattern.test(text)) return true;
  return new RegExp(`\\bexport\\s*\\{[^}]*\\bas\\s+${id}(?![$\\w])`).test(text);
}

function symbolDefinedInSource(text: string, symbol: string): boolean {
  const parts = symbol.split(/[.#]/).filter((part) => part.length > 0);
  const [rootPart, ...restParts] = parts;
  if (rootPart === undefined) return false;
  if (!identifierDefinedInSource(text, rootPart)) return false;
  return restParts.every((part) => symbolPartPresentInSource(text, part));
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

function readSourceFileText(fullPath: string): FileReadResult {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(fullPath);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    throw error;
  }
  if (!stats.isFile()) return { kind: "unreadable" };
  try {
    return { kind: "text", text: UTF8_STRICT.decode(readFileSync(fullPath)) };
  } catch {
    return { kind: "unreadable" };
  }
}

function loadTrackedSourceFiles(
  worktree: string,
): ReadonlyMap<string, string> | undefined {
  const listed = runGitCommand(worktree, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (listed.timedOut || listed.exitCode !== 0) return undefined;
  let decoded: string;
  try {
    decoded = UTF8_STRICT.decode(listed.stdout);
  } catch {
    return undefined;
  }
  const seen = new Set<string>();
  const sources = new Map<string, string>();
  for (const relativePath of decoded.split("\u0000")) {
    if (relativePath === "" || seen.has(relativePath)) continue;
    seen.add(relativePath);
    if (!SOURCE_FILE_PATTERN.test(relativePath)) continue;
    const fullPath = resolveWorktreePath(worktree, relativePath);
    if (fullPath === undefined) return undefined;
    const read = readSourceFileText(fullPath);
    if (read.kind === "missing") continue;
    if (read.kind === "unreadable") return undefined;
    sources.set(fullPath, read.text);
  }
  return sources;
}

export function createWorktreeSourceReader(
  worktree: string,
): WorktreeSourceReader {
  let loaded = false;
  let cached: ReadonlyMap<string, string> | undefined;
  return {
    worktree,
    readAll() {
      if (!loaded) {
        cached = loadTrackedSourceFiles(worktree);
        loaded = true;
      }
      return cached;
    },
  };
}

function isSoleSymbolDefinition(
  reader: WorktreeSourceReader,
  newPath: string,
  symbol: string,
): boolean {
  const newFullPath = resolveWorktreePath(reader.worktree, newPath);
  if (newFullPath === undefined) return false;
  const sources = reader.readAll();
  if (sources === undefined) return false;
  let newText = sources.get(newFullPath);
  if (newText === undefined) {
    const read = readSourceFileText(newFullPath);
    if (read.kind !== "text") return false;
    newText = read.text;
  }
  if (!symbolDefinedInSource(newText, symbol)) return false;
  for (const [fullPath, text] of sources) {
    if (fullPath === newFullPath) continue;
    if (symbolDefinedInSource(text, symbol)) return false;
  }
  return true;
}

export function isSymbolMove(
  sourceReader: WorktreeSourceReader,
  oldPath: string,
  newPath: string,
  symbol: string | undefined,
): boolean {
  if (symbol === undefined || symbol === "") return false;
  const oldFullPath = resolveWorktreePath(sourceReader.worktree, oldPath);
  if (oldFullPath === undefined) return false;
  const oldRead = readSourceFileText(oldFullPath);
  if (oldRead.kind === "unreadable") return false;
  if (oldRead.kind === "missing") {
    return isSoleSymbolDefinition(sourceReader, newPath, symbol);
  }
  if (symbolDefinedInSource(oldRead.text, symbol)) return false;
  return isSoleSymbolDefinition(sourceReader, newPath, symbol);
}
