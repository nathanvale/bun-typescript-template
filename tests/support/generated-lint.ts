import { afterAll } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { readKernelPin } from "../../src/kernel-pin.ts";
import { invoke, requireSuccess, ROOT } from "./bootstrap-cli-fixture.ts";
import { kernelCheckout } from "./kernel-sibling.ts";
import { EXPECTED_RULE_FILES } from "./lint-rule-files.ts";
import { testFolder } from "./test-folder.ts";

const PROBES = [
  "probe.cjs",
  "probe.js",
  "probe.mjs",
  "probe.ts",
  "scripts/probe.ts",
  "src/probe.cts",
  "src/probe.jsx",
  "src/probe.mts",
  "src/probe.ts",
  "src/probe.tsx",
  "tests/probe.ts",
  "tests/support/probe.mts",
  "tests/fixtures/probe.ts.txt",
] as const;

const TEMPLATE_RULE = /^(?:repository|anti-slop)\//;
const REPAIR =
  "Repair: copy the lint rule's entry, with its files, from the template's eslint.config.mjs into the eslint.config.mjs this recipe copies.";

type Settings = ReadonlyMap<string, unknown>;

function isOn(setting: unknown): boolean {
  const level: unknown = Array.isArray(setting) ? setting[0] : setting;
  return level === 2 || level === "error";
}

async function settingsFor(eslint: ESLint, file: string): Promise<Settings> {
  const config = (await eslint.calculateConfigForFile(file)) as
    | { rules?: Record<string, unknown> }
    | undefined;
  return new Map(
    Object.entries(config?.rules ?? {}).filter(([rule]) =>
      TEMPLATE_RULE.test(rule),
    ),
  );
}

async function turnedOn(eslint: ESLint, file: string): Promise<Settings> {
  return new Map(
    [...(await settingsFor(eslint, file))].filter(([, setting]) =>
      isOn(setting),
    ),
  );
}

export async function lintRulesOn(
  root: string,
  file: string,
): Promise<string[]> {
  return [...(await turnedOn(new ESLint({ cwd: root }), file)).keys()].sort();
}

async function lintedFiles(root: string): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}").scan({ cwd: root }),
  );
  return files.filter((file) => !file.includes("node_modules/"));
}

function ruleFileProblems(
  template: string,
  generated: string,
  name: string,
): string[] {
  return EXPECTED_RULE_FILES.flatMap((file) => {
    const copy = join(generated, file);
    if (!existsSync(copy))
      return [
        `${name} has no ${file}, a lint rule file the template's eslint.config.mjs loads. Repair: name it in LINT_RULE_FILES in src/recipe.ts, so that Bootstrap copies it.`,
      ];
    return readFileSync(copy, "utf8") ===
      readFileSync(join(template, file), "utf8")
      ? []
      : [
          `${name} ${file} differs from the template's ${file}. Repair: let Bootstrap copy the template's file unchanged.`,
        ];
  });
}

async function ruleSettingProblems(
  template: string,
  generated: string,
  name: string,
): Promise<string[]> {
  const ours = new ESLint({ cwd: template });
  const theirs = new ESLint({ cwd: generated });
  const files = new Set([...(await lintedFiles(generated)), ...PROBES]);
  const problems: string[] = [];
  for (const file of [...files].sort()) {
    const given = await settingsFor(theirs, file);
    for (const [rule, setting] of await turnedOn(ours, file))
      if (!Bun.deepEquals(given.get(rule), setting))
        problems.push(
          `${name} does not turn on ${rule} for ${file} as the template's eslint.config.mjs does for a file at that path. ${REPAIR}`,
        );
  }
  return problems;
}

export async function generatedLintProblems(
  template: string,
  generated: string,
  name: string,
): Promise<string[]> {
  const files = ruleFileProblems(template, generated, name);
  return files.length > 0
    ? files
    : await ruleSettingProblems(template, generated, name);
}

export function generatedLint(root: string) {
  const eslint = new ESLint({ cwd: root });
  return async (file: string, code: string, rules: ReadonlySet<string>) => {
    const [result] = await eslint.lintText(code, { filePath: file });
    return (result?.messages ?? [])
      .filter(({ ruleId }) => ruleId === null || rules.has(ruleId))
      .map(({ ruleId, line }) => ({ ruleId, line }));
  };
}

function installTemplatePackagesAndKernel(destination: string): void {
  const modules = join(destination, "node_modules");
  mkdirSync(modules);
  for (const name of readdirSync(join(ROOT, "node_modules")))
    symlinkSync(join(ROOT, "node_modules", name), join(modules, name));
  kernelCheckout(join(modules, readKernelPin(ROOT).repository));
}

async function bootstrapped(folder: string): Promise<string> {
  const destination = join(folder, "repository");
  requireSuccess(
    await invoke(
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    "bootstrap",
  );
  installTemplatePackagesAndKernel(destination);
  return destination;
}

export function generatedRepositoryOnce(prefix: string): () => Promise<string> {
  const folder = testFolder(prefix);
  afterAll(() => rmSync(folder, { recursive: true }));
  let generated: Promise<string> | undefined;
  return () => {
    generated ??= bootstrapped(folder);
    return generated;
  };
}
