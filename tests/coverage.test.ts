import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  convertLcov,
  type FileCoverage,
  fileCoverage,
  type Position,
  parseLcov,
} from "../scripts/coverage.ts";
import { testFolder } from "./support/test-folder.ts";

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

function repository(files: Record<string, string>): string {
  const folder = testFolder("coverage-");
  folders.push(folder);
  const root = join(folder, "repo");
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(join(folder, name)), { recursive: true });
    writeFileSync(join(folder, name), content);
  }
  mkdirSync(root, { recursive: true });
  return root;
}

function lcov(file: string, hits: Record<number, number>): string {
  const rows = Object.entries(hits).map(
    ([line, count]) => `DA:${line},${count}`,
  );
  return ["TN:", `SF:${file}`, ...rows, "end_of_record", ""].join("\n");
}

function at({ line, column }: Position): string {
  return `${line}:${column}`;
}

function outline(coverage: FileCoverage): string[] {
  return Object.values(coverage.fnMap).map(
    ({ name, decl, loc }) =>
      `${name} decl ${at(decl.start)}-${at(decl.end)} loc ${at(loc.start)}-${at(loc.end)}`,
  );
}

function contains(
  outer: FileCoverage["fnMap"][string]["loc"],
  inner: typeof outer,
) {
  const afterStart =
    inner.start.line > outer.start.line ||
    (inner.start.line === outer.start.line &&
      inner.start.column >= outer.start.column);
  const beforeEnd =
    inner.end.line < outer.end.line ||
    (inner.end.line === outer.end.line && inner.end.column <= outer.end.column);
  return afterStart && beforeEnd;
}

function owners(coverage: FileCoverage): string[] {
  return Object.values(coverage.statementMap).map((statement) => {
    let owner = "none";
    for (const { name, loc } of Object.values(coverage.fnMap))
      if (contains(loc, statement)) owner = name;
    return `${statement.start.line} ${owner}`;
  });
}

const sample = [
  "export function add(a: number): number {",
  "  return a + 1;",
  "}",
  "export const twice = (n: number) => {",
  "  return add(n);",
  "};",
  "export class Counter {",
  "  count = 0;",
  "  constructor() {",
  "    this.count = 1;",
  "  }",
  "  get value(): number {",
  "    return this.count;",
  "  }",
  "}",
  "export const doubled = [1].map((n) => {",
  "  return n * 2;",
  "});",
  "export const one = () => 1;",
  "",
].join("\n");
const sampleHits = {
  1: 1,
  2: 3,
  3: 1,
  4: 1,
  5: 2,
  6: 1,
  7: 1,
  8: 1,
  9: 1,
  10: 1,
  11: 1,
  12: 0,
  13: 0,
  14: 0,
  16: 1,
  17: 2,
  18: 1,
  19: 1,
};

describe("lcov to Istanbul", () => {
  test("CV.a a file's coverage holds its function, its statements and their hits", () => {
    const source = "export function pick() {\n  return 1;\n}\n";
    expect(
      fileCoverage(
        "/repo/pick.ts",
        source,
        new Map([
          [1, 1],
          [2, 2],
          [3, 2],
        ]),
      ),
    ).toEqual({
      path: "/repo/pick.ts",
      statementMap: {
        "0": { start: { line: 1, column: 0 }, end: { line: 1, column: 24 } },
        "1": { start: { line: 2, column: 2 }, end: { line: 2, column: 11 } },
        "2": { start: { line: 3, column: 0 }, end: { line: 3, column: 1 } },
      },
      fnMap: {
        "0": {
          name: "pick",
          decl: { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
          loc: { start: { line: 1, column: 23 }, end: { line: 3, column: 1 } },
          line: 1,
        },
      },
      branchMap: {},
      s: { "0": 1, "1": 2, "2": 2 },
      f: { "0": 2 },
      b: {},
    });
  });

  test("CV.b each kind of function keeps its name and its body from open to close", () => {
    const coverage = fileCoverage(
      "/repo/sample.ts",
      sample,
      new Map(Object.entries(sampleHits).map(([line, hits]) => [+line, hits])),
    );
    expect(outline(coverage)).toEqual([
      "add decl 1:0-1:19 loc 1:39-3:1",
      "twice decl 4:21-4:21 loc 4:36-6:1",
      "constructor decl 9:2-9:2 loc 9:16-11:3",
      "value decl 12:2-12:11 loc 12:22-14:3",
      "(anonymous_0) decl 16:31-16:31 loc 16:38-18:1",
      "one decl 19:19-19:19 loc 19:25-19:26",
    ]);
  });

  test("CV.c a statement stands for each line the report counts, with that line's hits", () => {
    const coverage = fileCoverage(
      "/repo/sample.ts",
      sample,
      new Map(Object.entries(sampleHits).map(([line, hits]) => [+line, hits])),
    );
    expect(
      Object.values(coverage.statementMap).map(
        ({ start, end }, index) =>
          `${at(start)}-${at(end)}=${coverage.s[String(index)]}`,
      ),
    ).toEqual([
      "1:0-1:40=1",
      "2:2-2:15=3",
      "3:0-3:1=1",
      "4:0-4:37=1",
      "5:2-5:16=2",
      "6:0-6:1=1",
      "7:0-7:22=1",
      "8:2-8:12=1",
      "9:2-9:17=1",
      "10:4-10:19=1",
      "11:2-11:3=1",
      "12:2-12:23=0",
      "13:4-13:22=0",
      "14:2-14:3=0",
      "16:0-16:39=1",
      "17:2-17:15=2",
      "18:0-18:1=1",
      "19:0-19:27=1",
    ]);
  });

  test("CV.d a line outside every body, such as a signature or a class field, has no function owner", () => {
    const coverage = fileCoverage(
      "/repo/sample.ts",
      sample,
      new Map(Object.entries(sampleHits).map(([line, hits]) => [+line, hits])),
    );
    expect(owners(coverage)).toEqual([
      "1 none",
      "2 add",
      "3 add",
      "4 none",
      "5 twice",
      "6 twice",
      "7 none",
      "8 none",
      "9 none",
      "10 constructor",
      "11 constructor",
      "12 none",
      "13 value",
      "14 value",
      "16 none",
      "17 (anonymous_0)",
      "18 (anonymous_0)",
      "19 none",
    ]);
  });

  test("CV.e a function calls count as the busiest line of its body, and a one-line function uses its own line", () => {
    const coverage = fileCoverage(
      "/repo/sample.ts",
      sample,
      new Map(Object.entries(sampleHits).map(([line, hits]) => [+line, hits])),
    );
    expect(Object.values(coverage.f)).toEqual([3, 2, 1, 0, 2, 1]);
  });

  test("CV.f a nested function owns its own lines and the outer function owns the rest", () => {
    const source = [
      "export function outer() {",
      "  const inner = () => {",
      "    return 1;",
      "  };",
      "  return inner();",
      "}",
      "",
    ].join("\n");
    const coverage = fileCoverage(
      "/repo/nested.ts",
      source,
      new Map([
        [1, 1],
        [2, 1],
        [3, 1],
        [4, 1],
        [5, 1],
        [6, 1],
      ]),
    );
    expect(owners(coverage)).toEqual([
      "1 none",
      "2 outer",
      "3 inner",
      "4 inner",
      "5 outer",
      "6 outer",
    ]);
  });

  test("CV.g a function takes the name of the variable, property or assignment that holds it", () => {
    const source = [
      "export const handlers = {",
      "  open() {",
      "    return 1;",
      "  },",
      "  close: () => {",
      "    return 2;",
      "  },",
      "};",
      "const mod = { exports: {} as Record<string, unknown> };",
      "mod.exports.done = function () {",
      "  return 3;",
      "};",
      "export const named = function inner() {",
      "  return 4;",
      "};",
      "export default function () {",
      "  return 5;",
      "}",
      "",
    ].join("\n");
    expect(
      Object.values(
        fileCoverage("/repo/names.ts", source, new Map()).fnMap,
      ).map(({ name }) => name),
    ).toEqual(["open", "close", "done", "inner", "(anonymous_0)"]);
  });

  test("CV.h a report converts only files inside the repository, keyed by absolute path", () => {
    const root = repository({
      "repo/src/sample.ts": sample,
      "outside/sample.ts": sample,
    });
    const report = [
      lcov("src/sample.ts", sampleHits),
      lcov("../outside/sample.ts", sampleHits),
      lcov(join(root, "..", "outside", "sample.ts"), sampleHits),
    ].join("");
    const converted = convertLcov(report, root);
    expect(Object.keys(converted)).toEqual([join(root, "src/sample.ts")]);
    expect(converted[join(root, "src/sample.ts")]?.path).toBe(
      join(root, "src/sample.ts"),
    );
  });

  test("CV.i a file that no longer exists on disk is skipped", () => {
    const root = repository({
      "repo/src/kept.ts": "export const kept = () => 1;\n",
    });
    const report = [
      lcov("src/gone.ts", { 1: 1 }),
      lcov("src/kept.ts", { 1: 1 }),
    ].join("");
    expect(Object.keys(convertLcov(report, root))).toEqual([
      join(root, "src/kept.ts"),
    ]);
  });

  test("CV.j a repository folder counts as a missing file, not as source", () => {
    const root = repository({
      "repo/src/kept.ts": "export const kept = () => 1;\n",
    });
    expect(convertLcov(lcov("src", { 1: 1 }), root)).toEqual({});
  });

  test("CV.k two records for one file add their hits, and a checksum column is ignored", () => {
    const records = parseLcov(
      [
        "SF:src/a.ts",
        "FNF:1",
        "DA:2,1,0u4a9Fb",
        "DA:3,2",
        "end_of_record",
        "SF:src/b.ts",
        "DA:1,5",
        "end_of_record",
        "SF:src/a.ts",
        "DA:2,4",
        "end_of_record",
        "",
      ].join("\n"),
    );
    expect(records.map(({ file, lines }) => [file, [...lines]])).toEqual([
      [
        "src/a.ts",
        [
          [2, 5],
          [3, 2],
        ],
      ],
      ["src/b.ts", [[1, 5]]],
    ]);
  });
});
