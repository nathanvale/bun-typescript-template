import { resolve, relative, dirname } from "node:path";
import ts from "typescript";
import { matchesSurface, type PublicSurface } from "./surface-match.ts";
import {
  hitsIn,
  type Glossary,
  type RecordedHit,
  recordedHitsFile,
} from "./glossary.ts";

export type PublicDeclaration = {
  readonly path: string;
  readonly line: number;
  readonly name: string;
  readonly declaration: string;
};

function compiler(root: string, texts: ReadonlyMap<string, string>) {
  const sources = new Map(
    [...texts].map(([path, text]) => {
      const absolute = resolve(root, path);
      return [
        absolute,
        ts.createSourceFile(absolute, text, ts.ScriptTarget.Latest, true),
      ] as const;
    }),
  );
  const options: ts.CompilerOptions = {
    noLib: true,
    noResolve: true,
    types: [],
    allowJs: true,
    target: ts.ScriptTarget.Latest,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
  };
  const library = resolve(
    dirname(ts.getDefaultLibFilePath(options)),
    "lib.es5.d.ts",
  );
  const libraryText = ts.sys.readFile(library);
  if (libraryText !== undefined)
    sources.set(
      library,
      ts.createSourceFile(library, libraryText, ts.ScriptTarget.Latest, true),
    );
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (path) => sources.get(resolve(path));
  host.fileExists = (path) => sources.has(resolve(path));
  host.readFile = (path) => texts.get(relative(root, resolve(path)));
  host.getCurrentDirectory = () => root;
  const program = ts.createProgram([...sources.keys()], options, host);
  return { sources, checker: program.getTypeChecker() };
}

const declarationKinds: readonly ((node: ts.Node) => boolean)[] = [
  ts.isDeclarationStatement,
  ts.isVariableDeclaration,
  ts.isParameter,
  ts.isPropertyDeclaration,
  ts.isPropertySignature,
  ts.isMethodDeclaration,
  ts.isMethodSignature,
  ts.isGetAccessorDeclaration,
  ts.isSetAccessorDeclaration,
  ts.isEnumMember,
  ts.isExportSpecifier,
  ts.isBindingElement,
];

function declarationName(node: ts.Node) {
  return declarationKinds.some((kind) => kind(node))
    ? (node as ts.NamedDeclaration).name
    : undefined;
}

function publicNode(node: ts.Node): boolean {
  const modifiers = ts.canHaveModifiers(node)
    ? ts.getModifiers(node)
    : undefined;
  const name = declarationName(node);
  return (
    !modifiers?.some(
      (modifier) =>
        modifier.kind === ts.SyntaxKind.PrivateKeyword ||
        modifier.kind === ts.SyntaxKind.ProtectedKeyword,
    ) && !(name !== undefined && ts.isPrivateIdentifier(name))
  );
}

function resolved(checker: ts.TypeChecker, symbol: ts.Symbol): ts.Symbol {
  return symbol.flags & ts.SymbolFlags.Alias
    ? checker.getAliasedSymbol(symbol)
    : symbol;
}

function importedNodes(statement: ts.Statement): ts.Node[] {
  if (ts.isImportDeclaration(statement)) {
    const clause = statement.importClause;
    const bindings = clause?.namedBindings;
    const named =
      bindings === undefined
        ? []
        : ts.isNamespaceImport(bindings)
          ? [bindings.name]
          : bindings.elements.map((element) => element.name);
    return [...(clause?.name === undefined ? [] : [clause.name]), ...named];
  }
  if (ts.isExportDeclaration(statement) && statement.moduleSpecifier) {
    const clause = statement.exportClause;
    return clause === undefined || ts.isNamespaceExport(clause)
      ? [statement.moduleSpecifier]
      : clause.elements.map((element) => element.name);
  }
  return [];
}

function consumedSymbols(
  sources: Iterable<ts.SourceFile>,
  checker: ts.TypeChecker,
): Set<ts.Symbol> {
  const consumed = new Set<ts.Symbol>();
  for (const source of sources)
    for (const node of source.statements.flatMap(importedNodes)) {
      const symbol = checker.getSymbolAtLocation(node);
      if (symbol === undefined) continue;
      const target = resolved(checker, symbol);
      consumed.add(target);
      if (target.flags & ts.SymbolFlags.Module)
        for (const exported of checker.getExportsOfModule(target))
          consumed.add(resolved(checker, exported));
    }
  return consumed;
}

type Context = {
  readonly root: string;
  readonly texts: ReadonlyMap<string, string>;
  readonly checker: ts.TypeChecker;
  readonly found: Map<string, PublicDeclaration>;
};

function remember(
  context: Context,
  name: string,
  node: ts.Node,
  declaration: string,
) {
  const source = node.getSourceFile();
  const path = relative(context.root, source.fileName);
  if (!context.texts.has(path)) return;
  const line =
    source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  context.found.set(`${path}:${line}:${name}:${declaration}`, {
    path,
    line,
    name,
    declaration,
  });
}

function namedSymbol(context: Context, symbol: ts.Symbol, declaration: string) {
  for (const node of symbol.declarations ?? []) {
    if (!publicNode(node)) continue;
    const nameNode = declarationName(node);
    const name =
      symbol.getName() === "default" &&
      nameNode !== undefined &&
      ts.isIdentifier(nameNode)
        ? nameNode.text
        : symbol.getName();
    remember(context, name, nameNode ?? node, declaration);
  }
}

function bindingNames(name: ts.BindingName): ts.Identifier[] {
  return ts.isIdentifier(name)
    ? [name]
    : name.elements.flatMap((element) =>
        ts.isBindingElement(element) ? bindingNames(element.name) : [],
      );
}

function parameters(
  context: Context,
  signature: ts.Signature,
  declaration: string,
) {
  const nodes = signature.parameters
    .flatMap((parameter) => parameter.declarations ?? [])
    .filter((node) => publicNode(node) && ts.isParameter(node));
  for (const node of nodes)
    for (const name of bindingNames((node as ts.ParameterDeclaration).name))
      remember(context, name.text, name, `${declaration}.${name.text}`);
}

function returnedTypes(context: Context, signature: ts.Signature): ts.Type[] {
  const result = context.checker.getReturnTypeOfSignature(signature);
  const promised =
    result.symbol?.getName() === "Promise" && result.flags & ts.TypeFlags.Object
      ? context.checker.getTypeArguments(result as ts.TypeReference)[0]
      : undefined;
  return promised === undefined ? [result] : [result, promised];
}

function signatures(
  context: Context,
  type: ts.Type,
  declaration: string,
  returns: boolean,
) {
  for (const kind of [ts.SignatureKind.Call, ts.SignatureKind.Construct])
    for (const signature of context.checker.getSignaturesOfType(type, kind)) {
      parameters(context, signature, declaration);
      if (returns && kind === ts.SignatureKind.Call)
        for (const part of returnedTypes(context, signature))
          members(context, part, `${declaration}.return`, false);
    }
}

function members(
  context: Context,
  type: ts.Type,
  declaration: string,
  callable: boolean,
) {
  const parts = type.isUnionOrIntersection() ? type.types : [type];
  const properties = parts.flatMap((part) =>
    context.checker.getPropertiesOfType(part),
  );
  for (const member of properties) {
    const node = member.valueDeclaration ?? member.declarations?.[0];
    if (
      node === undefined ||
      !publicNode(node) ||
      !context.texts.has(relative(context.root, node.getSourceFile().fileName))
    )
      continue;
    const key = `${declaration}.${member.getName()}`;
    namedSymbol(context, member, key);
    if (callable)
      signatures(
        context,
        context.checker.getTypeOfSymbolAtLocation(member, node),
        key,
        false,
      );
  }
}

function exportedSymbol(context: Context, exported: ts.Symbol) {
  const { checker } = context;
  const symbol = resolved(checker, exported);
  const name = exported.getName();
  namedSymbol(context, exported, name);
  const node = symbol.valueDeclaration ?? symbol.declarations?.[0];
  if (node === undefined) return;
  const type =
    symbol.flags & ts.SymbolFlags.Type
      ? checker.getDeclaredTypeOfSymbol(symbol)
      : checker.getTypeOfSymbolAtLocation(symbol, node);
  members(context, type, name, true);
  signatures(context, type, name, true);
  if (symbol.flags & (ts.SymbolFlags.Class | ts.SymbolFlags.Enum)) {
    const valueType = checker.getTypeOfSymbolAtLocation(symbol, node);
    members(context, valueType, name, true);
    signatures(context, valueType, name, false);
  }
}

function compare(one: string, other: string): number {
  return one < other ? -1 : one > other ? 1 : 0;
}

export function publicDeclarations(
  root: string,
  texts: ReadonlyMap<string, string>,
  surface: PublicSurface,
): PublicDeclaration[] {
  if (texts.size === 0) return [];
  const { sources, checker } = compiler(root, texts);
  const consumed = consumedSymbols(
    [...sources.values()].filter((source) =>
      matchesSurface(relative(root, source.fileName), surface.importers),
    ),
    checker,
  );
  const context: Context = { root, texts, checker, found: new Map() };
  for (const source of sources.values()) {
    const path = relative(root, source.fileName);
    const all = matchesSurface(path, surface.exports);
    if (!all && !matchesSurface(path, surface.consumedExports)) continue;
    const module = checker.getSymbolAtLocation(source);
    if (module === undefined) continue;
    for (const exported of checker.getExportsOfModule(module))
      if (all || consumed.has(resolved(checker, exported)))
        exportedSymbol(context, exported);
  }
  return [...context.found.values()].sort(
    (one, other) =>
      compare(one.path, other.path) ||
      one.line - other.line ||
      compare(one.declaration, other.declaration),
  );
}

export function declarationProblems(
  declarations: readonly PublicDeclaration[],
  glossary: Glossary,
  recorded: readonly RecordedHit[],
  stale: boolean = false,
): string[] {
  const hits = declarations.flatMap((declaration) =>
    hitsIn(declaration.path, glossary, declaration.name).map((hit) => ({
      ...declaration,
      hit,
    })),
  );
  const same = (entry: RecordedHit, found: (typeof hits)[number]) =>
    entry.path === found.path &&
    entry.declaration === found.declaration &&
    entry.word === found.hit.word;
  return [
    ...hits
      .filter((found) => !recorded.some((entry) => same(entry, found)))
      .map(
        ({ path, line, name, hit }) =>
          `${path}:${line} public declaration "${name}" breaks ${hit.rule}: uses "${hit.word}"${hit.problem}`,
      ),
    ...(stale
      ? recorded
          .filter(
            (entry) =>
              entry.declaration !== undefined &&
              !hits.some((found) => same(entry, found)),
          )
          .map(
            (entry) =>
              `${recordedHitsFile} records "${entry.word}" in ${entry.path} declaration ${entry.declaration}, which no longer occurs. Repair: remove the recorded hit.`,
          )
      : []),
  ];
}
