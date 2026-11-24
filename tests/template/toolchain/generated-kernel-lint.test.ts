import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { ESLint, type Linter } from "eslint";
import { generatedRepositoryOnce } from "../../support/generated-lint.ts";
import { processWatchdog } from "../../support/process.ts";

type KernelLint = (options: {
  readonly rootDir: string;
  readonly srcDir: string;
  readonly testDirs: readonly string[];
  readonly addons: readonly string[];
}) => Linter.Config[];

type Rules = Readonly<Record<string, unknown>>;

const generationTimeout = processWatchdog(5);
const generatedRepository = generatedRepositoryOnce("generated-kernel-lint-");

const KERNEL_PATHS = [
  "src/probe.cts",
  "src/probe.mts",
  "src/probe.ts",
  "src/subject/probe.test.ts",
  "src/subject/probe.ts",
  "tests/locks/probe.ts",
  "tests/probe.cts",
  "tests/probe.mts",
  "tests/probe.ts",
  "tests/support/probe.ts",
];

const TEMPLATE_UNUSED_PARAMETERS: Rules = {
  "@typescript-eslint/no-unused-vars": [
    2,
    { args: "all", argsIgnorePattern: "^_" },
  ],
};

async function kernelLintAlone(root: string): Promise<ESLint> {
  const { kernelLint } = (await import(
    Bun.resolveSync("agent-cli-kernel/lint", root)
  )) as { kernelLint: KernelLint };
  return new ESLint({
    cwd: root,
    overrideConfigFile: true,
    overrideConfig: kernelLint({
      rootDir: root,
      srcDir: "src",
      testDirs: ["tests"],
      addons: [],
    }),
  });
}

async function rulesFor(eslint: ESLint, file: string): Promise<Rules> {
  const config = (await eslint.calculateConfigForFile(file)) as
    | { rules?: Rules }
    | undefined;
  return config?.rules ?? {};
}

function trackedPaths(root: string, folder: string): string[] {
  return readdirSync(join(root, folder), { recursive: true, encoding: "utf8" })
    .filter((path) => path.endsWith(".ts"))
    .map((path) => `${folder}/${path}`);
}

async function hits(
  root: string,
  file: string,
  lines: readonly string[],
  rules: readonly string[],
) {
  const [result] = await new ESLint({ cwd: root }).lintText(lines.join("\n"), {
    filePath: file,
  });
  return (result?.messages ?? [])
    .filter(({ ruleId }) => ruleId === null || rules.includes(ruleId))
    .map(({ ruleId, line }) => [ruleId, line]);
}

test(
  "a repository Bootstrap generates keeps every lint rule setting the kernel's lint config gives each source and test path",
  async () => {
    const root = await generatedRepository();
    const kernel = await kernelLintAlone(root);
    const generated = new ESLint({ cwd: root });
    const paths = [
      ...KERNEL_PATHS,
      ...trackedPaths(root, "src"),
      ...trackedPaths(root, "tests"),
    ];
    const uncovered: string[] = [];
    const changed: string[] = [];
    for (const path of paths.toSorted()) {
      const given = await rulesFor(kernel, path);
      if (Object.keys(given).length === 0) uncovered.push(path);
      const kept = await rulesFor(generated, path);
      for (const [rule, setting] of Object.entries({
        ...given,
        ...TEMPLATE_UNUSED_PARAMETERS,
      }))
        if (!Bun.deepEquals(kept[rule], setting))
          changed.push(
            `${path} ${rule}: kernel ${JSON.stringify(setting)}, generated ${JSON.stringify(kept[rule])}`,
          );
    }
    expect(uncovered).toEqual([]);
    expect(changed).toEqual([]);
  },
  generationTimeout,
);

test(
  "a repository Bootstrap generates refuses a kernel refusal and a chained type assertion in one source file",
  async () => {
    const root = await generatedRepository();
    expect(
      await hits(
        root,
        "src/commands.ts",
        [
          'export const merged = Object.assign({}, { name: "a" });',
          "export const isName = (value: unknown): value is string =>",
          '  typeof value === "string";',
          'export const chained = Number("1") as unknown as string;',
        ],
        ["no-restricted-syntax", "anti-slop/no-chained-type-assertions"],
      ),
    ).toEqual([
      ["no-restricted-syntax", 1],
      ["no-restricted-syntax", 2],
      ["anti-slop/no-chained-type-assertions", 4],
    ]);
  },
  generationTimeout,
);

test(
  "a repository Bootstrap generates refuses a type assertion and a type predicate in a test file",
  async () => {
    const root = await generatedRepository();
    expect(
      await hits(
        root,
        "tests/cli.test.ts",
        [
          "const raw: object = { name: 'a' };",
          "export const named = raw as { readonly name: string };",
          "export const isName = (value: unknown): value is string =>",
          '  typeof value === "string";',
        ],
        [
          "no-restricted-syntax",
          "@typescript-eslint/consistent-type-assertions",
        ],
      ),
    ).toEqual([
      ["@typescript-eslint/consistent-type-assertions", 2],
      ["no-restricted-syntax", 3],
    ]);
  },
  generationTimeout,
);

test(
  "a repository Bootstrap generates refuses an unawaited promise, any, a non-null assertion and console in a script",
  async () => {
    const root = await generatedRepository();
    expect(
      await hits(
        root,
        "scripts/check-gated-paths.ts",
        [
          "declare const payload: { name: string } | undefined;",
          "export const loose: any = payload!.name;",
          "console.error(loose);",
          'Promise.reject(new Error("refused"));',
        ],
        [
          "@typescript-eslint/no-explicit-any",
          "@typescript-eslint/no-floating-promises",
          "@typescript-eslint/no-non-null-assertion",
          "no-console",
        ],
      ),
    ).toEqual([
      ["@typescript-eslint/no-explicit-any", 2],
      ["@typescript-eslint/no-non-null-assertion", 2],
      ["no-console", 3],
      ["@typescript-eslint/no-floating-promises", 4],
    ]);
  },
  generationTimeout,
);
