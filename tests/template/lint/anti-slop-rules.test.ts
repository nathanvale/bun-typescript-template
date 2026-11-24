import { expect, test } from "bun:test";
import antiSlop from "../../../config/anti-slop-rules.mjs";
import { ruleHits } from "../../support/template-lint.ts";

const antiSlopCases = [
  {
    rule: "anti-slop/no-chained-type-assertions",
    witness: "anti-slop 13909c9",
    message: "This assertion chain discards type evidence.",
    filePath: "scripts/doctor.ts",
    failing: [
      "declare const input: string;",
      "export const parenthesized = (input as unknown) as number;",
      "export const angled = <number>(<unknown>input);",
      "export const constThenType = ({ id: 1 } as const) as { id: number };",
    ],
    passing: [
      "declare const input: unknown;",
      "export const single = input as number;",
      'export const constant = ["a"] as const;',
    ],
    lines: [2, 3, 4],
  },
  {
    rule: "anti-slop/no-widen-then-assert",
    witness: "anti-slop 13909c9",
    message: "discards type evidence and later recreates it with an assertion.",
    filePath: "scripts/doctor.ts",
    failing: [
      'const source = { id: "second" };',
      "const widened: unknown = source;",
      "export const parsed = widened as { readonly id: string };",
    ],
    passing: [
      "declare const input: unknown;",
      "export const parsed = input as { readonly id: string };",
    ],
    lines: [3],
  },
  {
    rule: "anti-slop/no-widen-then-assert",
    witness: "r4608976401",
    message: "discards type evidence and later recreates it with an assertion.",
    filePath: "scripts/doctor.ts",
    failing: [
      'const source = { id: "second" };',
      "const widened: unknown = source;",
      "export const parsed = (widened) as { readonly id: string };",
      "export const angled = <{ readonly id: string }>(widened);",
    ],
    passing: [
      "declare const input: unknown;",
      "export const parsed = (input) as { readonly id: string };",
    ],
    lines: [3, 4],
  },
  {
    rule: "anti-slop/no-unknown-type-aliases",
    witness: "r4608976364",
    message: "hides `unknown`.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export type Payload = (unknown);",
      "export type Loose = (string | (unknown));",
    ],
    passing: ["export type Payload = (string);"],
    lines: [1, 2],
  },
  {
    rule: "anti-slop/no-unknown-type-aliases",
    witness: "r4609019138",
    message: "hides `unknown`.",
    filePath: "scripts/doctor.ts",
    failing: [
      "type Identity<T> = T;",
      "export type Payload = Identity<Identity<unknown>>;",
    ],
    passing: [
      "type Identity<T> = T;",
      "export type Payload = Identity<Identity<string>>;",
    ],
    lines: [2],
  },
  {
    rule: "anti-slop/no-unknown-type-aliases",
    witness: "r4609659195",
    message: "hides `unknown`.",
    filePath: "scripts/doctor.ts",
    failing: [
      "type T = unknown;",
      "type Fixed = T;",
      "type Wrap<T = string> = Fixed;",
      "type Given<T> = Fixed;",
      "export type Payload = Wrap;",
      "export type Loose = Given<string>;",
    ],
    passing: [
      "type T = string;",
      "type Fixed = T;",
      "type Wrap<T = unknown> = Fixed;",
      "type Given<T> = Fixed;",
      "export type Safe = Wrap;",
      "export type Named = Given<unknown>;",
    ],
    lines: [1, 2, 3, 4, 5, 6],
  },
  {
    rule: "anti-slop/no-unknown-type-aliases",
    witness: "r4609659195 parameter chain",
    message: "hides `unknown`.",
    filePath: "scripts/doctor.ts",
    failing: [
      "type Inner<U> = U;",
      "type Outer<T> = Inner<T>;",
      "type Later<A, B = A> = B;",
      "type Shadow<T> = Inner<string> | T;",
      "export type Payload = Outer<unknown>;",
      "export type Loose = Later<unknown>;",
      "export type Mixed = Shadow<unknown>;",
    ],
    passing: [
      "type Inner<U> = U;",
      "type Outer<T> = Inner<T>;",
      "type Later<A, B = A> = B;",
      "export type Payload = Outer<string>;",
      "export type Loose = Later<string>;",
    ],
    lines: [5, 6, 7],
  },
  {
    rule: "anti-slop/no-unknown-type-aliases",
    witness: "anti-slop 13909c9",
    message: "hides `unknown`.",
    filePath: "scripts/doctor.ts",
    failing: [
      "type Identity<T> = T;",
      "export type Payload = Identity<unknown>;",
      "export type Loose = string | unknown;",
    ],
    passing: [
      "type Box<T> = { readonly value: T };",
      "export type Payload = Box<unknown>;",
    ],
    lines: [2, 3],
  },
  {
    rule: "anti-slop/no-module-mocking",
    witness: "anti-slop 13909c9",
    message: "Replace module mocking with dependency injection",
    filePath: "tests/template/doctor/doctor.test.ts",
    failing: [
      'import { vi as testApi } from "vitest";',
      'testApi.mock("./user-store.ts");',
      'jest.unstable_mockModule("./user-store.ts");',
    ],
    passing: [
      'import { mock } from "bun:test";',
      'import { vi as localVi } from "./helpers.ts";',
      'mock.module("./user-store.ts", () => ({}));',
      'localVi.mock("./user-store.ts");',
      "export const store = { save() {} };",
      'vi.spyOn(store, "save");',
    ],
    lines: [2, 3],
  },
  {
    rule: "anti-slop/no-module-mocking",
    witness: "r4609902952",
    message: "Replace module mocking with dependency injection",
    filePath: "tests/template/doctor/doctor.test.ts",
    failing: [
      'import { vi } from "vitest";',
      'vi.mock("./user-store.ts");',
      'vi[`mock`]("./user-store.ts");',
    ],
    passing: [
      'import { vi } from "vitest";',
      "export const store = { save() {} };",
      'vi[`spyOn`](store, "save");',
    ],
    lines: [2, 3],
  },
  {
    rule: "anti-slop/no-reduce-accumulator-copy",
    witness: "anti-slop 13909c9",
    message: "Do not copy the reducer accumulator on every iteration;",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const byId = (items: { id: string }[]) =>",
      "  items.reduce((all, item) => Object.assign({}, all, { [item.id]: item }), {});",
      "export const sorted = (items: number[]) =>",
      "  items.reduce<number[]>((all) => all.toSorted(), []);",
    ],
    passing: [
      "export const byId = (items: { id: string }[]) =>",
      "  items.reduce<Record<string, { id: string }>>((all, item) => {",
      "    all[item.id] = item;",
      "    return all;",
      "  }, {});",
    ],
    lines: [2, 4],
  },
  {
    rule: "anti-slop/no-reduce-accumulator-copy",
    witness: "r4609902960",
    message: "Do not copy the reducer accumulator on every iteration;",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const joined = (items: number[][]) =>",
      "  items.reduce<number[]>((all, item) => all.concat(item), []);",
      "export const keyed = (items: number[][]) =>",
      "  items.reduce<number[]>((all, item) => all[`concat`](item), []);",
      "export const named = (items: number[][]) =>",
      "  items[`reduce`]<number[]>((all, item) => all.concat(item), []);",
    ],
    passing: [
      "export const joined = (items: number[][]) =>",
      "  items[`reduce`]<number[]>((all, item) => {",
      "    all[`push`](...item);",
      "    return all;",
      "  }, []);",
    ],
    lines: [2, 4, 6],
  },
  {
    rule: "anti-slop/no-reduce-accumulator-copy",
    witness: "r4609902960 sibling keys",
    message: "Do not copy the reducer accumulator on every iteration;",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const byId = (items: { id: string }[]) =>",
      "  items.reduce((all, item) => Object[`assign`]({}, all, { [item.id]: item }), {});",
      "export const copied = (items: number[]) =>",
      "  items.reduce<number[]>((all) => Array[`from`](all), []);",
      "export const sorted = (items: number[]) =>",
      "  items.reduce<number[]>((all) => all.toSorted(), [0][`slice`]());",
    ],
    passing: [
      "export const byId = (items: { id: string }[]) =>",
      "  items.reduce((all, item) => Object[`assign`](all, { [item.id]: item }), {});",
      "export const sorted = (items: number[], source: { slice(): number[] }) =>",
      "  items.reduce<number[]>((all) => all.toSorted(), source[`slice`]());",
    ],
    lines: [2, 4, 6],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "oxc 1.93.0",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const keyed = (names: string[]) =>",
      "  names.reduce((all, name) => ({ ...all, [name]: name }), {});",
      "export function counted() {",
      "  let seen: number[] = [];",
      "  for (let index = 0; index < 3; index++) seen = [...seen, index];",
      "  return seen;",
      "}",
    ],
    passing: [
      "export function counted() {",
      "  const seen: number[] = [];",
      "  for (let index = 0; index < 3; index++) seen.push(index);",
      "  return seen;",
      "}",
      "export const both = (left: number[], right: number[]) => [...left, ...right];",
    ],
    lines: [2, 5],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "r4608976426",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const listed = (names: string[]) =>",
      "  names.reduce<string[]>((all, name, index) => [...all, `${index}:${name}`], []);",
      "export const counted = (names: string[]) =>",
      "  names.reduce((all, name, index, every) => ({ ...all, [name]: every.length - index }), {});",
    ],
    passing: [
      "export const listed = (names: string[]) =>",
      "  names.reduce<string[]>((all, name, index) => {",
      "    all.push(`${index}:${name}`);",
      "    return all;",
      "  }, []);",
    ],
    lines: [2, 4],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "r4609659202",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const marked = (names: string[]) =>",
      '  names.reduce<string[]>((all) => [...all, "x"], []);',
      "export const keyed = (names: string[]) =>",
      "  names.reduce((all) => ({ ...all, x: 1 }), {});",
      "export const spare = (names: string[]) =>",
      "  names.reduce<string[]>((all, name, index, every, extra?: string) => [...all, extra ?? name], []);",
    ],
    passing: [
      "export const marked = (names: string[]) =>",
      "  names.reduce<string[]>((all) => {",
      '    all.push("x");',
      "    return all;",
      "  }, []);",
    ],
    lines: [2, 4, 6],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "r4609659202 initial value",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "declare const owned: <T>(callback: T) => T;",
      "export const rows = (items: number[][]) =>",
      "  items.reduce<number[][]>(owned((all, row) => [...all, row]), []);",
    ],
    passing: [
      "declare const join: (all: number[][], row: number[]) => number[][];",
      "export const copied = (items: number[][]) =>",
      "  items.reduce(join, items.map((row) => [...row]));",
      "export const indexed = (items: number[][]) =>",
      "  items.reduce(join, items.map((row, index) => [...row, index]));",
    ],
    lines: [3],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "r4609659207",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const fed = (items: string[]) =>",
      '  items.reduce((args, item) => [...args, item], ["fixed"]);',
      "export function looped(items: string[]) {",
      '  let args = ["fixed"];',
      "  for (const item of items) args = [...args, item];",
      "  return args;",
      "}",
    ],
    passing: [
      "declare function consume(...values: string[]): string;",
      "export const fed = (items: string[]) =>",
      "  items.reduce((args, item) => {",
      "    consume(item, ...args);",
      "    return args;",
      '  }, ["fixed"]);',
      "export const built = (items: string[]) =>",
      '  items.reduce((args, item) => [consume(item, ...args), String(new Set(...args))], ["fixed"]);',
      "export function looped(items: string[]) {",
      '  let args = ["fixed"];',
      "  for (const item of items) args = [consume(item, ...args)];",
      "  return args;",
      "}",
    ],
    lines: [2, 5],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "r4609019144",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export const rows = (items: number[][]) =>",
      "  items.reduce<number[][]>((all, row) => [...all, row.map((cell, index) => cell + index)], []);",
    ],
    passing: [
      "export const rows = (items: number[][]) =>",
      "  items.reduce<number[][]>((all, row) => {",
      "    all.push(row.map((cell, index) => cell + index));",
      "    all.push(items.map((item, index) => [...item, index]).flat());",
      "    return all;",
      "  }, []);",
    ],
    lines: [2],
  },
  {
    rule: "anti-slop/no-accumulating-spread",
    witness: "r4609019149",
    message:
      "Using spreads within accumulators leads to `O(n^2)` time complexity.",
    filePath: "scripts/doctor.ts",
    failing: [
      "export function counted() {",
      "  let seen: number[] = [];",
      "  seen = [];",
      "  for (let index = 0; index < 3; index++) seen = [...seen, index];",
      "  return seen;",
      "}",
      "export function primed() {",
      "  let seen: number[] = [];",
      "  seen = [...seen, 0];",
      "  for (let index = 0; index < 3; index++) seen = [...seen, index];",
      "  return seen;",
      "}",
    ],
    passing: [
      "export function primed() {",
      "  let seen: number[] = [];",
      "  seen = [...seen, 0];",
      "  for (let index = 0; index < 3; index++) seen.push(index);",
      "  return seen;",
      "}",
    ],
    lines: [4, 10],
  },
];

for (const item of antiSlopCases)
  test(`${item.rule} refuses the ${item.witness} shape in ${item.filePath} and admits its clean form`, async () => {
    const found = await ruleHits(
      item.rule,
      item.filePath,
      item.failing.join("\n"),
    );
    expect(found.map(({ line }) => line)).toEqual(item.lines);
    expect(
      found.filter(({ message }) => !message.includes(item.message)),
    ).toEqual([]);
    expect(
      await ruleHits(item.rule, item.filePath, item.passing.join("\n")),
    ).toEqual([]);
  });

test("every anti-slop rule has a case", () => {
  expect([...new Set(antiSlopCases.map(({ rule }) => rule))].sort()).toEqual(
    Object.keys(antiSlop.rules)
      .map((rule) => `anti-slop/${rule}`)
      .sort(),
  );
});
