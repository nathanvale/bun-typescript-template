import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";

export const RULE_FILES = [
  "config/anti-slop-bindings.mjs",
  "config/anti-slop-rules.mjs",
  "config/anti-slop-type-rules.mjs",
  "config/payload-rules.mjs",
  "config/platform-rules.mjs",
  "config/template-rules.mjs",
] as const;

export type Kind = "source" | "test" | "config";

export const TEMPLATE_FILES: Readonly<Record<Kind, string>> = {
  source: "src/recipe.ts",
  test: "tests/template/doctor/doctor.test.ts",
  config: "eslint.config.mjs",
};

const TEMPLATE_RULE = /^(?:repository|anti-slop)\//;
const SOURCE_FOLDER = /^(?:packages\/[^/]+\/)?src\//;
const TEST_FILE = /(?:^tests\/|\.test\.ts$)/;
const REPAIR =
  "Repair: copy the rule's entry from the template's eslint.config.mjs into the eslint.config.mjs this recipe copies.";

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
    Object.entries(config?.rules ?? {}).filter(
      ([rule]) => TEMPLATE_RULE.test(rule) || rule === "no-restricted-syntax",
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

export async function templateRulesOn(
  root: string,
  file: string,
): Promise<string[]> {
  return [...(await turnedOn(new ESLint({ cwd: root }), file)).keys()].sort();
}

export function kindsOf(file: string): Kind[] {
  if (file.endsWith(".mjs")) return ["config"];
  return [
    ...(SOURCE_FOLDER.test(file) ? (["source"] as const) : []),
    ...(TEST_FILE.test(file) ? (["test"] as const) : []),
  ];
}

async function lintedFiles(root: string): Promise<string[]> {
  const files = await Array.fromAsync(
    new Bun.Glob("**/*.{ts,mjs}").scan({ cwd: root }),
  );
  return files.filter((file) => !file.includes("node_modules/")).sort();
}

function ruleFileProblems(
  template: string,
  generated: string,
  name: string,
): string[] {
  return RULE_FILES.flatMap((file) => {
    const copy = join(generated, file);
    if (!existsSync(copy))
      return [
        `${name} has no ${file}, a rule file the template's eslint.config.mjs loads. Repair: name it in LINT_RULE_FILES in src/recipe.ts, so that Bootstrap copies it.`,
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
  const wanted = {
    source: await turnedOn(ours, TEMPLATE_FILES.source),
    test: await turnedOn(ours, TEMPLATE_FILES.test),
    config: await turnedOn(ours, TEMPLATE_FILES.config),
  };
  const problems: string[] = [];
  for (const file of await lintedFiles(generated)) {
    const given = await settingsFor(theirs, file);
    for (const kind of kindsOf(file))
      for (const [rule, setting] of wanted[kind])
        if (!Bun.deepEquals(given.get(rule), setting))
          problems.push(
            `${name} does not turn on ${rule} for ${file} as the template's eslint.config.mjs does for ${TEMPLATE_FILES[kind]}. ${REPAIR}`,
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
