import {
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import ts from "typescript";

export type Position = { readonly line: number; readonly column: number };
export type Span = { readonly start: Position; readonly end: Position };
export type FunctionSpan = {
  readonly name: string;
  readonly decl: Span;
  readonly loc: Span;
};
export type LineHits = ReadonlyMap<number, number>;
export type LcovRecord = { readonly file: string; readonly lines: LineHits };
export type FileCoverage = {
  readonly path: string;
  readonly statementMap: Readonly<Record<string, Span>>;
  readonly fnMap: Readonly<
    Record<string, FunctionSpan & { readonly line: number }>
  >;
  readonly branchMap: Readonly<Record<string, never>>;
  readonly s: Readonly<Record<string, number>>;
  readonly f: Readonly<Record<string, number>>;
  readonly b: Readonly<Record<string, never>>;
};
export type CoverageMap = Readonly<Record<string, FileCoverage>>;

export const lcovPath = "coverage/lcov.info";
export const istanbulPath = "coverage/coverage-final.json";

function hitsOf(row: string): [number, number] | undefined {
  if (!row.startsWith("DA:")) return undefined;
  const [line, hits] = row.slice(3).split(",").map(Number);
  return line !== undefined && hits !== undefined && Number.isFinite(hits)
    ? [line, hits]
    : undefined;
}

export function parseLcov(lcov: string): LcovRecord[] {
  const byFile = new Map<string, Map<number, number>>();
  let lines: Map<number, number> | undefined;
  for (const row of lcov.split(/\r?\n/)) {
    if (row.startsWith("SF:")) {
      const file = row.slice(3);
      lines = byFile.get(file) ?? new Map<number, number>();
      byFile.set(file, lines);
    } else if (row === "end_of_record") {
      lines = undefined;
    } else if (lines !== undefined) {
      const hit = hitsOf(row);
      if (hit !== undefined)
        lines.set(hit[0], (lines.get(hit[0]) ?? 0) + hit[1]);
    }
  }
  return [...byFile].map(([file, hits]) => ({ file, lines: hits }));
}

const wrappers = new Set([
  ts.SyntaxKind.ParenthesizedExpression,
  ts.SyntaxKind.AsExpression,
  ts.SyntaxKind.SatisfiesExpression,
  ts.SyntaxKind.NonNullExpression,
  ts.SyntaxKind.TypeAssertionExpression,
]);

function textOf(name: ts.Node | undefined, file: ts.SourceFile) {
  if (name === undefined) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isPrivateIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  )
    return name.text;
  if (ts.isComputedPropertyName(name))
    return `[${name.expression.getText(file)}]`;
  return undefined;
}

function initializedName(parent: ts.Node, child: ts.Node, file: ts.SourceFile) {
  return (ts.isVariableDeclaration(parent) ||
    ts.isPropertyAssignment(parent) ||
    ts.isPropertyDeclaration(parent) ||
    ts.isParameter(parent)) &&
    parent.initializer === child
    ? textOf(parent.name, file)
    : undefined;
}

function assignedToName(parent: ts.Node, child: ts.Node, file: ts.SourceFile) {
  if (
    !ts.isBinaryExpression(parent) ||
    parent.operatorToken.kind !== ts.SyntaxKind.EqualsToken ||
    parent.right !== child
  )
    return undefined;
  return ts.isPropertyAccessExpression(parent.left)
    ? textOf(parent.left.name, file)
    : textOf(parent.left, file);
}

function assignedName(node: ts.Node, file: ts.SourceFile) {
  let child = node;
  while (wrappers.has(child.parent.kind)) child = child.parent;
  return (
    initializedName(child.parent, child, file) ??
    assignedToName(child.parent, child, file)
  );
}

type Callable =
  | ts.FunctionDeclaration
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration
  | ts.ConstructorDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction;

function isCallable(node: ts.Node): node is Callable {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node)
  );
}

function ownName(node: Callable, file: ts.SourceFile) {
  if (ts.isConstructorDeclaration(node)) return "constructor";
  if (ts.isArrowFunction(node)) return undefined;
  return textOf(node.name, file);
}

function positionAt(file: ts.SourceFile, offset: number): Position {
  const { line, character } = file.getLineAndCharacterOfPosition(offset);
  return { line: line + 1, column: character };
}

export function functionSpans(path: string, source: string): FunctionSpan[] {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.ESNext, true);
  const spans: FunctionSpan[] = [];
  let anonymous = 0;
  const visit = (node: ts.Node): void => {
    if (isCallable(node) && node.body !== undefined) {
      const start = positionAt(file, node.getStart(file));
      const nameNode =
        ts.isConstructorDeclaration(node) || ts.isArrowFunction(node)
          ? undefined
          : node.name;
      const name =
        ownName(node, file) ??
        assignedName(node, file) ??
        `(anonymous_${anonymous++})`;
      spans.push({
        name,
        decl: {
          start,
          end:
            nameNode === undefined
              ? start
              : positionAt(file, nameNode.getEnd()),
        },
        loc: {
          start: positionAt(file, node.body.getStart(file)),
          end: positionAt(file, node.body.getEnd()),
        },
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return spans;
}

function notAfter(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.column <= b.column);
}

function statementSpan(
  row: string,
  line: number,
  functions: readonly FunctionSpan[],
): Span | undefined {
  const text = row.trimEnd();
  if (text.length === 0) return undefined;
  const start = { line, column: text.length - text.trimStart().length };
  let end = { line, column: text.length };
  for (const { loc } of functions)
    if (
      notAfter(loc.start, start) &&
      notAfter(start, loc.end) &&
      loc.end.line === line &&
      loc.end.column < end.column
    )
      end = loc.end;
  return { start, end };
}

function bodyHits(span: FunctionSpan, lines: LineHits): number {
  const { start, end } = span.loc;
  const first = end.line > start.line ? start.line + 1 : start.line;
  let hits = 0;
  for (let line = first; line <= end.line; line++)
    hits = Math.max(hits, lines.get(line) ?? 0);
  return hits;
}

export function fileCoverage(
  path: string,
  source: string,
  lines: LineHits,
): FileCoverage {
  const functions = functionSpans(path, source);
  const rows = source.split("\n");
  const statementMap: Record<string, Span> = {};
  const s: Record<string, number> = {};
  let statement = 0;
  for (const [line, hits] of [...lines].sort(([a], [b]) => a - b)) {
    const span = statementSpan(rows[line - 1] ?? "", line, functions);
    if (span === undefined) continue;
    statementMap[String(statement)] = span;
    s[String(statement)] = hits;
    statement += 1;
  }
  const fnMap: Record<string, FunctionSpan & { readonly line: number }> = {};
  const f: Record<string, number> = {};
  for (const [id, span] of functions.entries()) {
    fnMap[String(id)] = { ...span, line: span.loc.start.line };
    f[String(id)] = bodyHits(span, lines);
  }
  return { path, statementMap, fnMap, branchMap: {}, s, f, b: {} };
}

function isInside(root: string, path: string): boolean {
  const from = relative(root, path);
  return from !== "" && !from.startsWith("..") && !isAbsolute(from);
}

function sourceAt(path: string): string | undefined {
  return statSync(path, { throwIfNoEntry: false })?.isFile()
    ? readFileSync(path, "utf8")
    : undefined;
}

export function convertLcov(lcov: string, root: string): CoverageMap {
  const base = resolve(root);
  const map: Record<string, FileCoverage> = {};
  for (const { file, lines } of parseLcov(lcov)) {
    const path = resolve(base, file);
    if (!isInside(base, path)) continue;
    const source = sourceAt(path);
    if (source === undefined) continue;
    map[path] = fileCoverage(path, source, lines);
  }
  return map;
}

function run(root: string): number {
  rmSync(join(root, "coverage"), { recursive: true, force: true });
  const tests = Bun.spawnSync(
    [
      process.execPath,
      "run",
      "test",
      "--coverage",
      "--coverage-reporter=lcov",
      "--coverage-dir=coverage",
    ],
    { cwd: root, stdio: ["inherit", "inherit", "inherit"] },
  );
  if (tests.exitCode !== 0) {
    process.stderr.write(
      `bun run test exited ${tests.exitCode}, so ${istanbulPath} was not written. Fix the failing tests, then run bun run coverage again.\n`,
    );
    return tests.exitCode ?? 1;
  }
  const map = convertLcov(readFileSync(join(root, lcovPath), "utf8"), root);
  mkdirSync(join(root, "coverage"), { recursive: true });
  writeFileSync(join(root, istanbulPath), `${JSON.stringify(map)}\n`);
  const functions = Object.values(map).reduce(
    (total, each) => total + Object.keys(each.fnMap).length,
    0,
  );
  process.stdout.write(
    `Wrote ${istanbulPath}: ${Object.keys(map).length} files, ${functions} functions.\n`,
  );
  return 0;
}

if (import.meta.main) process.exitCode = run(join(import.meta.dir, ".."));
