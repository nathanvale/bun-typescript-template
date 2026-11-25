import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";
import ts from "typescript";
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

function addBindingNames(binding: ts.BindingName, names: Set<string>): void {
  if (ts.isIdentifier(binding)) {
    names.add(binding.text);
    return;
  }
  if (ts.isObjectBindingPattern(binding)) {
    for (const element of binding.elements) {
      addBindingNames(element.name, names);
    }
    return;
  }
  for (const element of binding.elements) {
    if (ts.isBindingElement(element)) {
      addBindingNames(element.name, names);
    }
  }
}

function propertyNameText(name: ts.PropertyName): string | undefined {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isPrivateIdentifier(name)) {
    return name.text.startsWith("#") ? name.text.slice(1) : name.text;
  }
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return undefined;
}

function hasDefaultModifier(node: ts.Node): boolean {
  if (!ts.canHaveModifiers(node)) return false;
  const modifiers = ts.getModifiers(node);
  return (
    modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.DefaultKeyword,
    ) ?? false
  );
}

function addFunctionOrClassName(node: ts.Node, names: Set<string>): boolean {
  if (
    !ts.isFunctionDeclaration(node) &&
    !ts.isFunctionExpression(node) &&
    !ts.isClassDeclaration(node) &&
    !ts.isClassExpression(node)
  ) {
    return false;
  }
  if (node.name !== undefined) names.add(node.name.text);
  if (hasDefaultModifier(node)) names.add("default");
  return true;
}

function addMemberName(node: ts.Node, names: Set<string>): boolean {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    const memberName = propertyNameText(node.name);
    if (memberName !== undefined) names.add(memberName);
    return true;
  }
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isFunctionLike(node.initializer) ||
      ts.isClassExpression(node.initializer))
  ) {
    const memberName = propertyNameText(node.name);
    if (memberName !== undefined) names.add(memberName);
    return true;
  }
  return false;
}

function addTypeOrExportName(node: ts.Node, names: Set<string>): void {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    names.add(node.name.text);
    return;
  }
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    names.add(node.name.text);
    return;
  }
  if (ts.isExportAssignment(node)) {
    names.add("default");
    return;
  }
  if (ts.isExportSpecifier(node)) {
    names.add(node.name.text);
  }
}

function recordDeclaredNode(node: ts.Node, names: Set<string>): void {
  if (addFunctionOrClassName(node, names)) return;
  if (ts.isVariableDeclaration(node)) {
    addBindingNames(node.name, names);
    return;
  }
  if (addMemberName(node, names)) return;
  addTypeOrExportName(node, names);
}

function collectDeclaredSymbols(
  filePath: string,
  text: string,
): ReadonlySet<string> | undefined {
  const sourceFile = ts.createSourceFile(
    filePath,
    text,
    ts.ScriptTarget.Latest,
    true,
  );
  const diagnostics: unknown = Reflect.get(sourceFile, "parseDiagnostics");
  if (!Array.isArray(diagnostics) || diagnostics.length > 0) {
    return undefined;
  }
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    recordDeclaredNode(node, names);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return names;
}

function symbolParts(symbol: string): string[] {
  return symbol.split(/[.#]/).filter((part) => part.length > 0);
}

function symbolDefinedInSource(
  filePath: string,
  text: string,
  symbol: string,
): boolean {
  const parts = symbolParts(symbol);
  if (parts.length === 0) return false;
  const declared = collectDeclaredSymbols(filePath, text);
  if (declared === undefined) return true;
  return parts.every((part) => declared.has(part));
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

function readTargetSourceText(
  sources: ReadonlyMap<string, string>,
  newFullPath: string,
): string | undefined {
  const existing = sources.get(newFullPath);
  if (existing !== undefined) return existing;
  const read = readSourceFileText(newFullPath);
  return read.kind === "text" ? read.text : undefined;
}

function isSoleSymbolDefinition(
  reader: WorktreeSourceReader,
  newPath: string,
  symbol: string,
): boolean {
  const parts = symbolParts(symbol);
  const newFullPath = resolveWorktreePath(reader.worktree, newPath);
  const sources = reader.readAll();
  if (
    parts.length === 0 ||
    newFullPath === undefined ||
    sources === undefined
  ) {
    return false;
  }
  const newText = readTargetSourceText(sources, newFullPath);
  const newDeclared =
    newText === undefined
      ? undefined
      : collectDeclaredSymbols(newFullPath, newText);
  if (
    newDeclared === undefined ||
    !parts.every((part) => newDeclared.has(part))
  ) {
    return false;
  }
  for (const [fullPath, text] of sources) {
    if (
      fullPath !== newFullPath &&
      symbolDefinedInSource(fullPath, text, symbol)
    ) {
      return false;
    }
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
  if (symbolDefinedInSource(oldFullPath, oldRead.text, symbol)) return false;
  return isSoleSymbolDefinition(sourceReader, newPath, symbol);
}
