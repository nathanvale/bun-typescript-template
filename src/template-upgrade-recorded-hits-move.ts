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

type PropertyNameResult =
  | { readonly kind: "name"; readonly text: string }
  | { readonly kind: "any" }
  | { readonly kind: "none" };

interface DeclaredSymbols {
  readonly names: ReadonlySet<string>;
  readonly definesAnyName: boolean;
}

interface LocalExportAlias {
  readonly localName: string;
  readonly exportedName: string;
}

interface SymbolCollector {
  readonly names: Set<string>;
  readonly importedNames: Set<string>;
  readonly exportAliases: LocalExportAlias[];
  definesAnyName: boolean;
}

function resolveComputedPropertyName(
  name: ts.ComputedPropertyName,
): PropertyNameResult {
  const { expression } = name;
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return { kind: "name", text: expression.text };
  }
  return { kind: "any" };
}

function resolvePropertyName(name: ts.PropertyName): PropertyNameResult {
  if (ts.isIdentifier(name)) return { kind: "name", text: name.text };
  if (ts.isPrivateIdentifier(name)) {
    const text = name.text.startsWith("#") ? name.text.slice(1) : name.text;
    return { kind: "name", text };
  }
  if (
    ts.isStringLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name) ||
    ts.isNumericLiteral(name)
  ) {
    return { kind: "name", text: name.text };
  }
  if (ts.isComputedPropertyName(name)) {
    return resolveComputedPropertyName(name);
  }
  return { kind: "none" };
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

function memberPropertyName(node: ts.Node): ts.PropertyName | undefined {
  if (
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isPropertyDeclaration(node)
  ) {
    return node.name;
  }
  if (
    ts.isPropertyAssignment(node) &&
    (ts.isFunctionLike(node.initializer) ||
      ts.isClassExpression(node.initializer))
  ) {
    return node.name;
  }
  return undefined;
}

function addMemberName(node: ts.Node, collector: SymbolCollector): boolean {
  const propertyName = memberPropertyName(node);
  if (propertyName === undefined) return false;
  const resolved = resolvePropertyName(propertyName);
  if (resolved.kind === "name") {
    collector.names.add(resolved.text);
  } else if (resolved.kind === "any") {
    collector.definesAnyName = true;
  }
  return true;
}

function addImportNames(node: ts.Node, importedNames: Set<string>): boolean {
  if (ts.isImportEqualsDeclaration(node)) {
    importedNames.add(node.name.text);
    return true;
  }
  if (!ts.isImportDeclaration(node)) return false;
  const clause = node.importClause;
  if (clause === undefined) return true;
  if (clause.name !== undefined) importedNames.add(clause.name.text);
  const bindings = clause.namedBindings;
  if (bindings === undefined) return true;
  if (ts.isNamespaceImport(bindings)) {
    importedNames.add(bindings.name.text);
    return true;
  }
  for (const element of bindings.elements) {
    importedNames.add(element.name.text);
  }
  return true;
}

function addTypeOrExportName(node: ts.Node, collector: SymbolCollector): void {
  if (
    ts.isInterfaceDeclaration(node) ||
    ts.isTypeAliasDeclaration(node) ||
    ts.isEnumDeclaration(node)
  ) {
    collector.names.add(node.name.text);
    return;
  }
  if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) {
    collector.names.add(node.name.text);
    return;
  }
  if (ts.isExportAssignment(node)) {
    collector.names.add("default");
    return;
  }
  if (
    ts.isExportSpecifier(node) &&
    node.propertyName !== undefined &&
    node.parent.parent.moduleSpecifier === undefined
  ) {
    collector.exportAliases.push({
      localName: node.propertyName.text,
      exportedName: node.name.text,
    });
  }
}

function recordDeclaredNode(node: ts.Node, collector: SymbolCollector): void {
  if (addImportNames(node, collector.importedNames)) return;
  if (addFunctionOrClassName(node, collector.names)) return;
  if (ts.isVariableDeclaration(node)) {
    addBindingNames(node.name, collector.names);
    return;
  }
  if (addMemberName(node, collector)) return;
  addTypeOrExportName(node, collector);
}

function collectDeclaredSymbols(
  filePath: string,
  text: string,
): DeclaredSymbols | undefined {
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
  const collector: SymbolCollector = {
    names: new Set<string>(),
    importedNames: new Set<string>(),
    exportAliases: [],
    definesAnyName: false,
  };
  const visit = (node: ts.Node): void => {
    recordDeclaredNode(node, collector);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  for (const alias of collector.exportAliases) {
    if (
      collector.names.has(alias.localName) &&
      !collector.importedNames.has(alias.localName)
    ) {
      collector.names.add(alias.exportedName);
    }
  }
  return collector;
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
  if (declared === undefined || declared.definesAnyName) return true;
  return parts.every((part) => declared.names.has(part));
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

function parseFallowIgnorePatterns(
  text: string,
): readonly Bun.Glob[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  if (!Object.hasOwn(parsed, "ignorePatterns")) return [];
  const patterns: unknown = Reflect.get(parsed, "ignorePatterns");
  if (
    !Array.isArray(patterns) ||
    !patterns.every(
      (entry): entry is string =>
        typeof entry === "string" && !entry.startsWith("!"),
    )
  ) {
    return undefined;
  }
  return patterns.map((pattern) => new Bun.Glob(pattern));
}

function loadFallowIgnoredPaths(
  worktree: string,
): readonly Bun.Glob[] | undefined {
  const configPath = resolveWorktreePath(worktree, ".fallowrc.json");
  if (configPath === undefined) return undefined;
  const read = readSourceFileText(configPath);
  if (read.kind === "missing") return [];
  if (read.kind === "unreadable") return undefined;
  return parseFallowIgnorePatterns(read.text);
}

function listWorktreePaths(worktree: string): string[] | undefined {
  const listed = runGitCommand(worktree, [
    "ls-files",
    "--cached",
    "--others",
    "--exclude-standard",
    "-z",
  ]);
  if (listed.timedOut || listed.exitCode !== 0) return undefined;
  try {
    return UTF8_STRICT.decode(listed.stdout).split("\u0000");
  } catch {
    return undefined;
  }
}

function loadTrackedSourceFiles(
  worktree: string,
): ReadonlyMap<string, string> | undefined {
  const ignoredPatterns = loadFallowIgnoredPaths(worktree);
  const paths = listWorktreePaths(worktree);
  if (ignoredPatterns === undefined || paths === undefined) return undefined;
  const seen = new Set<string>();
  const sources = new Map<string, string>();
  for (const relativePath of paths) {
    if (
      relativePath === "" ||
      seen.has(relativePath) ||
      !SOURCE_FILE_PATTERN.test(relativePath) ||
      ignoredPatterns.some((pattern) => pattern.match(relativePath))
    ) {
      continue;
    }
    seen.add(relativePath);
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
    !parts.every((part) => newDeclared.names.has(part))
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
