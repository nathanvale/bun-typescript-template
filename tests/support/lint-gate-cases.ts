export const antiSlopGate = [
  {
    ruleId: "anti-slop/no-chained-type-assertions",
    refused: `export const value = Number("1") as unknown as string;
`,
    admitted: `export const value = ["a"] as const;
`,
  },
  {
    ruleId: "anti-slop/no-widen-then-assert",
    refused: `type Shape = { readonly name: string };
const known: Shape = { name: "a" };
const widened: unknown = known;
export const narrowed = widened as Shape;
`,
    admitted: `type Shape = { readonly name: string };
const known: Shape = { name: "a" };
export const same = known;
`,
  },
  {
    ruleId: "anti-slop/no-unknown-type-aliases",
    refused: `export type Opaque = unknown;
`,
    admitted: `export type Name = string;
`,
  },
  {
    ruleId: "anti-slop/no-module-mocking",
    refused: `import { vi } from "vitest";

vi.mock("./dependency.ts");
`,
    admitted: `import { vi } from "vitest";

export const spy = vi.fn();
`,
  },
  {
    ruleId: "anti-slop/no-reduce-accumulator-copy",
    refused: `export const copied = [1, 2].reduce((all, each) => all.concat([each]), []);
`,
    admitted: `export const total = [1, 2].reduce((sum, each) => sum + each, 0);
`,
  },
  {
    ruleId: "anti-slop/no-accumulating-spread",
    refused: `export const spread = [1, 2].reduce((all, each) => [...all, each], []);
`,
    admitted: `export const merged = [...[1, 2], 3];
`,
  },
] as const;

export const repositoryGate = [
  {
    ruleId: "repository/no-comments",
    kind: "source",
    refused: `// Loop over the names.
export const names = 1;
`,
    admitted: `// Platform: Bun drains spawn pipes.
export const names = 1;
`,
  },
  {
    ruleId: "repository/no-host-path-literal",
    kind: "source",
    refused: `export const folder = "/tmp/example";
`,
    admitted: `export const shell = "/bin/sh";
`,
  },
  {
    ruleId: "repository/no-locale-compare",
    kind: "source",
    refused: `export const order = (a: string, b: string) => a.localeCompare(b);
`,
    admitted: `export const order = (a: string, b: string) =>
  a < b ? -1 : a > b ? 1 : 0;
`,
  },
  {
    ruleId: "repository/no-in-operator",
    kind: "source",
    refused: `export const declared = (fields: Readonly<Record<string, unknown>>, key: string) =>
  key in fields;
`,
    admitted: `export const declared = (fields: Readonly<Record<string, unknown>>, key: string) =>
  Object.hasOwn(fields, key);
`,
  },
  {
    ruleId: "repository/require-to-throw-message",
    kind: "test",
    refused: `import { expect } from "bun:test";

expect(() => JSON.parse("{")).toThrow();
`,
    admitted: `import { expect } from "bun:test";

expect(() => JSON.parse("{")).toThrow("JSON Parse error");
`,
  },
  {
    ruleId: "repository/tests-use-test-folder",
    kind: "test",
    refused: `import { tmpdir } from "node:os";

export const folder = tmpdir();
`,
    admitted: `declare function testFolder(prefix: string): string;

export const folder = testFolder("example-");
`,
  },
  {
    ruleId: "repository/tests-no-sleep",
    kind: "test",
    refused: `export const settled = Bun.sleep(1);
`,
    admitted: `export const settled = Promise.resolve(1);
`,
  },
] as const;
