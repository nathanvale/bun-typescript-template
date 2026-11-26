import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import payloadRuleSet from "../../../config/payload-rules.mjs";
import platformRuleSet from "../../../config/platform-rules.mjs";
import templateRuleSet from "../../../config/template-rules.mjs";
import { commentCases } from "../../support/lint-comment-cases.ts";
import {
  hits,
  messages,
  root,
  ruleOn,
  templateSourceFile,
} from "../../support/template-lint.ts";

const templateRules = [
  templateRuleSet,
  platformRuleSet,
  payloadRuleSet,
].flatMap((module) => Object.keys(module.rules));
const tracked = execFileSync(
  "git",
  ["ls-files", "--cached", "--others", "--exclude-standard"],
  { cwd: root, encoding: "utf8" },
)
  .split("\n")
  .filter((path) => path !== "" && existsSync(resolve(root, path)));

const config = ts.parseJsonConfigFileContent(
  ts.readConfigFile(resolve(root, "tsconfig.json"), (path) =>
    ts.sys.readFile(path),
  ).config,
  ts.sys,
  root,
);
let previous: ts.Program | undefined;

function typeErrors(filePath: string, code: string): string[] {
  const target = resolve(root, filePath);
  const host = ts.createCompilerHost(config.options);
  host.getCurrentDirectory = () => root;
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === target
      ? ts.createSourceFile(name, code, language)
      : read(name, language, ...rest);
  const program = ts.createProgram([target], config.options, host, previous);
  previous = program;
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(target))
    .map((item) => ts.flattenDiagnosticMessageText(item.messageText, "\n"));
}

async function fixesFor(rule: string, filePath: string, failing: string) {
  const found = await hits(rule, filePath, failing);
  if (found.length === 0) throw new Error(`No ${rule} hit in ${failing}.`);
  return found.map(({ message }) => {
    const fix = message.split(" Repair: ")[1];
    if (fix === undefined) throw new Error(`No fix in ${message}.`);
    return fix;
  });
}

const fixes = [
  {
    rule: "no-locale-compare",
    filePath: templateSourceFile,
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: ([fix]: string[]) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-locale-compare",
    filePath: "scripts/test-area.ts",
    failing:
      "export const sorted = (names: string[]) => names.sort((a, b) => a.localeCompare(b));",
    fixed: ([fix]: string[]) =>
      `export const sorted = (names: string[]) => names.sort(${fix});`,
  },
  {
    rule: "no-in-operator",
    filePath: "scripts/test-area.ts",
    failing:
      'export const code = (error: Error): unknown => ("code" in error ? error.code : undefined);',
    fixed: ([fix]: string[]) =>
      `export const code = (error: Error): unknown => ${fix};`,
  },
  {
    rule: "no-in-operator",
    filePath: templateSourceFile,
    failing:
      'export const payload = (next: () => object) => ("payload" in next() ? 1 : 0);',
    fixed: ([fix]: string[]) =>
      `export const payload = (next: () => object): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: templateSourceFile,
    failing:
      "export const payload = (key: string, read: () => object) => (key in read() ? 1 : 0);",
    fixed: ([fix]: string[]) =>
      `export const payload = (key: string, read: () => object): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: templateSourceFile,
    failing:
      "export const payload = (key: string, read: () => object) => {\n  {\n    return key in read();\n  }\n};",
    fixed: ([fix]: string[]) =>
      `export const payload = (key: string, read: () => object): unknown => {\n  {\n    ${fix}\n    return own;\n  }\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: templateSourceFile,
    failing:
      'export const payload = (host: { readonly value: object }) => ("payload" in host.value ? 1 : 0);',
    fixed: ([fix]: string[]) =>
      `export const payload = (host: { readonly value: object }): unknown => {\n  ${fix}\n  return own;\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: templateSourceFile,
    failing:
      "export const consume = (value: object, use: (field: string) => void) => {\n  for (const field in value) use(field);\n};",
    fixed: ([fix]: string[]) =>
      `export const consume = (value: object, use: (field: string) => void) => {\n  ${fix} use(field);\n};`,
  },
  {
    rule: "no-in-operator",
    filePath: templateSourceFile,
    failing:
      "export const consume = (value: object, use: (field: string) => void) => {\n  let field: string;\n  for (field in value) use(field);\n};",
    fixed: ([fix]: string[]) =>
      `export const consume = (value: object, use: (field: string) => void) => {\n  let field: string;\n  ${fix} use(field);\n};`,
  },
];

for (const item of fixes)
  test(`${item.rule}: the fix its message names compiles and lints clean in ${item.filePath}`, async () => {
    const found = await fixesFor(item.rule, item.filePath, item.failing);
    const fixed = item.fixed(found);
    expect(typeErrors(item.filePath, fixed)).toEqual([]);
    expect(await messages(item.filePath, fixed)).toEqual([]);
  }, 60_000);

const refused = [
  {
    rule: "no-locale-compare",
    witness: "b456208",
    filePath: "scripts/test-area.ts",
    code: [
      "export const keys = (value: Record<string, unknown>) =>",
      "  Object.entries(value).sort(([left], [right]) => left.localeCompare(right));",
    ],
    lines: [2],
  },
  {
    rule: "no-locale-compare",
    witness: "57c8c8b",
    filePath: templateSourceFile,
    code: [
      'const collator = new Intl.Collator("sv");',
      'export const names = ["a", "b"].sort(collator.compare);',
    ],
    lines: [1],
  },
  {
    rule: "no-locale-compare",
    witness: "aliased bindings",
    filePath: templateSourceFile,
    code: [
      "const { Collator } = Intl;",
      'export const first = new globalThis.Intl.Collator("sv");',
      "const { localeCompare } = String.prototype;",
      'export const second = localeCompare.call("a", "b");',
      'export const third = Reflect.get(Intl, "Coll" + "ator");',
      "export const fourth = new Collator();",
      'export const fifth = Reflect.get(Intl, ["Coll", "ator"].join(""));',
    ],
    lines: [1, 2, 3, 5, 7],
  },
  {
    rule: "no-host-path-literal",
    witness: "8e4ec47",
    filePath: "tests/template/doctor/doctor.test.ts",
    code: [
      "export const roots = (first: (root: string, depth: number) => string) => ({",
      '  foreignFile: first("/usr/share", 2),',
      "});",
    ],
    lines: [2],
  },
  {
    rule: "no-in-operator",
    witness: "r4580070968",
    filePath: templateSourceFile,
    code: [
      "type Fields = Readonly<Record<string, { readonly required: boolean }>>;",
      "export const fields = (table: Fields, value: Readonly<Record<string, unknown>>) =>",
      "  Object.keys(value).every((key) => key in table) &&",
      "  Object.entries(table).every(([key, field]) => !field.required || key in value);",
    ],
    lines: [3, 4],
  },
  {
    rule: "no-in-operator",
    witness: "r4606943328",
    filePath: templateSourceFile,
    code: [
      'export const has = (value: object) => Reflect["has"](value, "toString");',
    ],
    lines: [1],
  },
];

for (const item of refused)
  test(`${item.rule} refuses the ${item.witness} shape in ${item.filePath}`, async () => {
    const found = await hits(item.rule, item.filePath, item.code.join("\n"));
    expect(found.map(({ line }) => line)).toEqual(item.lines);
  });

const cases = [
  {
    rule: "require-to-throw-message",
    witness: "185c90d",
    filePath: "tests/template/doctor/doctor.test.ts",
    failing: [
      'const list = { name: "list" };',
      'expect(() => contractFor({ cli: "notes", commands: [list, list] })).toThrow();',
    ],
    passing: [
      'const list = { name: "list" };',
      'expect(() => contractFor({ cli: "notes", commands: [list, list] })).toThrow(',
      '  "Duplicate command identity.",',
      ");",
      'expect(() => contractFor({ cli: "notes", commands: [list] })).not.toThrow();',
    ],
    line: 2,
    fix: "Repair: pass the message or the cause that the test's name gives",
  },
  {
    rule: "tests-use-test-folder",
    witness: "c0b4bf5",
    filePath: "tests/template/doctor/doctor.test.ts",
    failing: [
      'import { mkdtempSync, realpathSync } from "node:fs";',
      'import { tmpdir } from "node:os";',
      'import { join } from "node:path";',
      "export const folder = () =>",
      '  realpathSync.native(mkdtempSync(join(tmpdir(), "c3-route-")));',
    ],
    passing: [
      'import { testFolder } from "./support/test-folder.ts";',
      'export const folder = () => testFolder("c3-route-");',
    ],
    line: 5,
    fix: "testFolder(prefix) from tests/support/test-folder.ts",
  },
  {
    rule: "tests-no-sleep",
    witness: "d1436c0",
    filePath: "tests/template/doctor/doctor.test.ts",
    failing: [
      "export async function exitWithin(done: Promise<number>, ms: number) {",
      "  const observed = await Promise.race([",
      "    done,",
      "    Bun.sleep(ms).then(() => undefined),",
      "  ]);",
      "  if (observed === undefined) throw new Error(`No exit within ${ms} ms.`);",
      "  return observed;",
      "}",
    ],
    passing: [
      "export async function exitWithin(done: Promise<number>, ms: number) {",
      "  let timer: ReturnType<typeof setTimeout> | undefined;",
      "  const bound = new Promise<never>((_, reject) => {",
      "    timer = setTimeout(() => reject(new Error(`No exit within ${ms} ms.`)), ms);",
      "  });",
      "  try {",
      "    return await Promise.race([done, bound]);",
      "  } finally {",
      "    clearTimeout(timer);",
      "  }",
      "}",
    ],
    line: 4,
    fix: "Repair: wait on the event the test is about",
  },
  {
    rule: "no-host-path-literal",
    witness: "ff5fffe",
    filePath: "tests/template/doctor/doctor.test.ts",
    failing: [
      "export const probe = (separation: (root: string) => boolean) =>",
      '  separation("/private/tmp");',
    ],
    passing: [
      'import { testFolder } from "./support/test-folder.ts";',
      "export const probe = (separation: (root: string) => boolean) =>",
      '  separation(testFolder("separation-"));',
    ],
    line: 2,
    fix: "Repair: make a scratch folder with testFolder(prefix) from tests/support/test-folder.ts",
  },
  {
    rule: "no-in-operator",
    witness: "r4580070979",
    filePath: templateSourceFile,
    failing: [
      "type Fields = Readonly<Record<string, { readonly required: boolean }>>;",
      "export const compatible = (older: Fields, newer: Fields) => {",
      "  for (const [key, field] of Object.entries(newer))",
      '    if (!(key in older) && field.required) throw new Error("A new field must be optional.");',
      "};",
    ],
    passing: [
      "type Fields = Readonly<Record<string, { readonly required: boolean }>>;",
      "export const compatible = (older: Fields, newer: Fields) => {",
      "  for (const [key, field] of Object.entries(newer))",
      '    if (!Object.hasOwn(older, key) && field.required) throw new Error("A new field must be optional.");',
      "};",
    ],
    line: 4,
    fix: "Repair: (Object.hasOwn(older, key) ? Reflect.get(older, key) : undefined)",
  },
  {
    rule: "no-in-operator",
    witness: "r4580077776",
    filePath: "scripts/test-area.ts",
    failing: [
      "export const declared = (fields: Readonly<Record<string, unknown>>, value: object) =>",
      "  Object.keys(value).every((key) => key in fields);",
    ],
    passing: [
      "export const declared = (fields: Readonly<Record<string, unknown>>, value: object) =>",
      "  Object.keys(value).every((key) => Object.hasOwn(fields, key));",
    ],
    line: 2,
    fix: "Repair: (Object.hasOwn(fields, key) ? Reflect.get(fields, key) : undefined)",
  },
];

for (const item of cases)
  test(`${item.rule} refuses the ${item.witness} shape in ${item.filePath} and names the fix`, async () => {
    const found = await hits(item.rule, item.filePath, item.failing.join("\n"));
    expect(found[0]?.line).toBe(item.line);
    expect(found[0]?.message).toContain(item.fix);
    expect(
      await hits(item.rule, item.filePath, item.passing.join("\n")),
    ).toEqual([]);
  });

test("every template rule refuses a case on a template file", async () => {
  const proved = new Set<string>();
  for (const { rule, filePath, failing } of fixes)
    if ((await hits(rule, filePath, failing)).length > 0) proved.add(rule);
  for (const { rule, filePath, code } of refused)
    if ((await hits(rule, filePath, code.join("\n"))).length > 0)
      proved.add(rule);
  for (const { rule, filePath, failing } of cases)
    if ((await hits(rule, filePath, failing.join("\n"))).length > 0)
      proved.add(rule);
  for (const [filePath, code] of commentCases)
    if ((await hits("no-comments", filePath, code)).length > 0)
      proved.add("no-comments");
  expect([...proved].sort()).toEqual(templateRules.sort());
});

test("every template rule is on for a tracked template file", async () => {
  const off: string[] = [];
  for (const rule of templateRules) {
    let on = false;
    for (const path of tracked)
      if (await ruleOn(`repository/${rule}`, path)) {
        on = true;
        break;
      }
    if (!on) off.push(rule);
  }
  expect(off).toEqual([]);
});

test("every recorded hit names a tracked file with that rule on", async () => {
  const recorded = (await Bun.file(
    resolve(root, "eslint-suppressions.json"),
  ).json()) as Record<string, Record<string, unknown>>;
  const dead: string[] = [];
  for (const [path, rules] of Object.entries(recorded))
    for (const rule of Object.keys(rules))
      if (!tracked.includes(path) || !(await ruleOn(rule, path)))
        dead.push(`${path} ${rule}`);
  expect(dead).toEqual([]);
});
