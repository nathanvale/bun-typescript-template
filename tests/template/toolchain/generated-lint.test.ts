import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { type ProjectRecipe, RECIPES } from "../../../src/recipe.ts";
import {
  invoke,
  parsePackage,
  requireSuccess,
  ROOT,
  rowKey,
} from "../../support/bootstrap-cli-fixture.ts";
import {
  generatedLint,
  generatedLintProblems,
  lintRulesOn,
} from "../../support/generated-lint.ts";
import { commentCases } from "../../support/lint-comment-cases.ts";
import { antiSlopGate, repositoryGate } from "../../support/lint-gate-cases.ts";
import { EXPECTED_RULE_FILES } from "../../support/lint-rule-files.ts";
import { processWatchdog } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const generationTimeout = processWatchdog(5);
const SOURCE_FILE = "src/commands.ts";
const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

const ANTI_SLOP = [
  "anti-slop/no-accumulating-spread",
  "anti-slop/no-module-mocking",
  "anti-slop/no-reduce-accumulator-copy",
  "anti-slop/no-unknown-type-aliases",
  "anti-slop/no-widen-then-assert",
  "no-restricted-syntax",
];
const EVERY_FILE = [
  ...ANTI_SLOP,
  "repository/no-comments",
  "repository/no-host-path-literal",
];
const SOURCE = [
  ...EVERY_FILE,
  "repository/no-in-operator",
  "repository/no-locale-compare",
];
const TEST = [
  ...EVERY_FILE,
  "repository/require-to-throw-message",
  "repository/tests-no-sleep",
  "repository/tests-use-test-folder",
];
const TEMPLATE_LINT_RULES: [string, string[]][] = [
  ["src/recipe.ts", SOURCE],
  ["scripts/doctor.ts", SOURCE],
  ["tests/template/doctor/doctor.test.ts", TEST],
  ["eslint.config.mjs", EVERY_FILE],
];
const LINTED = [
  "durable single-package",
  "durable monorepo",
  "durable single-package simple",
  "durable single-package complex",
];
const TURN_ON =
  "Repair: copy the lint rule's entry, with its files, from the template's eslint.config.mjs into the eslint.config.mjs this recipe copies.";

function recipeNamed(row: string): ProjectRecipe {
  const recipe = RECIPES.find((candidate) => rowKey(candidate) === row);
  if (recipe === undefined) throw new Error(`No recipe row is named ${row}.`);
  return recipe;
}

function flags({ request }: ProjectRecipe): string[] {
  return [
    "--profile",
    request.profile,
    ...(request.layout === "monorepo" ? ["--monorepo"] : []),
    ...(request.starter === undefined ? [] : ["--starter", request.starter]),
  ];
}

const generated = new Map<string, Promise<string>>();

async function bootstrapped(row: string): Promise<string> {
  const destination = join(testFolder("generated-lint-"), "repository");
  folders.push(dirname(destination));
  requireSuccess(
    await invoke(
      ...flags(recipeNamed(row)),
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ),
    `bootstrap ${row}`,
  );
  symlinkSync(join(ROOT, "node_modules"), join(destination, "node_modules"));
  return destination;
}

function generatedFrom(row: string): Promise<string> {
  const known = generated.get(row);
  if (known !== undefined) return known;
  const made = bootstrapped(row);
  generated.set(row, made);
  return made;
}

function testFileOf(root: string): string {
  const file = ["tests/cli.test.ts", "tests/unit/unit.test.ts"].find((path) =>
    existsSync(join(root, path)),
  );
  if (file === undefined) throw new Error(`${root} has no test file.`);
  return file;
}

const RULE = "{ create() { return {}; } }";
const FIXTURE_TEMPLATE_CONFIG = `const rule = ${RULE};
export default [
  {
    files: ["**/*.{js,mjs,cjs,jsx,ts,mts,cts,tsx}"],
    plugins: { repository: { rules: { "no-comments": rule, "tests-no-sleep": rule } } },
    rules: { "repository/no-comments": "error" },
  },
  { files: ["tests/**/*.ts"], rules: { "repository/tests-no-sleep": "error" } },
];
`;
const FIXTURE_FILES_WITH_NO_COMMENTS = [
  ...EXPECTED_RULE_FILES,
  "eslint.config.mjs",
  "probe.cjs",
  "probe.js",
  "probe.mjs",
  "probe.ts",
  "scripts/probe.ts",
  "src/cli.ts",
  "src/probe.cts",
  "src/probe.jsx",
  "src/probe.mts",
  "src/probe.ts",
  "src/probe.tsx",
  "tests/cli.test.ts",
  "tests/probe.ts",
  "tests/support/probe.mts",
];

function tree(files: Record<string, string>): string {
  const root = testFolder("generated-lint-fixture-");
  folders.push(root);
  for (const [path, text] of Object.entries({
    ...Object.fromEntries(
      EXPECTED_RULE_FILES.map((file) => [file, `export default "${file}";\n`]),
    ),
    "src/cli.ts": "",
    "tests/cli.test.ts": "",
    ...files,
  })) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

const fixtureTemplate = tree({ "eslint.config.mjs": FIXTURE_TEMPLATE_CONFIG });

async function problemsOf(files: Record<string, string>): Promise<string[]> {
  return await generatedLintProblems(
    fixtureTemplate,
    tree({ "eslint.config.mjs": FIXTURE_TEMPLATE_CONFIG, ...files }),
    "recipe",
  );
}

test.each(TEMPLATE_LINT_RULES)(
  "the template turns on exactly these lint rules of its own for %s",
  async (file, rules) => {
    expect(await lintRulesOn(ROOT, file)).toEqual(rules.toSorted());
  },
);

test("a generated tree with the template's lint rule files and settings has no problem", async () => {
  expect(await problemsOf({})).toEqual([]);
});

test("a generated tree that lacks a lint rule file names the file and the recipe table", async () => {
  const root = tree({ "eslint.config.mjs": FIXTURE_TEMPLATE_CONFIG });
  rmSync(join(root, "config/payload-rules.mjs"));
  expect(await generatedLintProblems(fixtureTemplate, root, "recipe")).toEqual([
    "recipe has no config/payload-rules.mjs, a lint rule file the template's eslint.config.mjs loads. Repair: name it in LINT_RULE_FILES in src/recipe.ts, so that Bootstrap copies it.",
  ]);
});

test("a generated tree whose lint rule file has other text names the file", async () => {
  expect(
    await problemsOf({ "config/template-rules.mjs": "export default {};\n" }),
  ).toEqual([
    "recipe config/template-rules.mjs differs from the template's config/template-rules.mjs. Repair: let Bootstrap copy the template's file unchanged.",
  ]);
});

test.each([
  [
    "leaves a lint rule off",
    FIXTURE_TEMPLATE_CONFIG.replace(
      '"repository/no-comments": "error"',
      '"repository/no-comments": "off"',
    ),
  ],
  [
    "only warns on a lint rule",
    FIXTURE_TEMPLATE_CONFIG.replace(
      '"repository/no-comments": "error"',
      '"repository/no-comments": "warn"',
    ),
  ],
])(
  "a generated tree that %s names it for each file and probe path it misses",
  async (_, config) => {
    expect(await problemsOf({ "eslint.config.mjs": config })).toEqual(
      FIXTURE_FILES_WITH_NO_COMMENTS.map(
        (file) =>
          `recipe does not turn on repository/no-comments for ${file} as the template's eslint.config.mjs does for a file at that path. ${TURN_ON}`,
      ),
    );
  },
);

test("a generated tree that narrows a lint rule to the files it has today names the probe path it misses", async () => {
  expect(
    await problemsOf({
      "eslint.config.mjs": FIXTURE_TEMPLATE_CONFIG.replace(
        '["tests/**/*.ts"]',
        '["tests/cli.test.ts"]',
      ),
    }),
  ).toEqual([
    `recipe does not turn on repository/tests-no-sleep for tests/probe.ts as the template's eslint.config.mjs does for a file at that path. ${TURN_ON}`,
  ]);
});

test(
  "a generated monorepo turns the source and test lint rules on inside a package",
  async () => {
    const root = await generatedFrom("durable monorepo");
    expect({
      source: await lintRulesOn(root, "packages/probe/src/probe.ts"),
      test: await lintRulesOn(root, "packages/probe/tests/probe.ts"),
    }).toEqual({ source: SOURCE.toSorted(), test: TEST.toSorted() });
  },
  generationTimeout,
);

test(
  "the recipes whose generated repository has a lint script are the four durable ones",
  async () => {
    const linted: string[] = [];
    for (const recipe of RECIPES) {
      const root = await generatedFrom(rowKey(recipe));
      const { scripts } = parsePackage(
        readFileSync(join(root, "package.json"), "utf8"),
      );
      if (scripts.lint !== undefined) linted.push(rowKey(recipe));
    }
    expect(linted.toSorted()).toEqual(LINTED.toSorted());
  },
  generationTimeout,
);

test.each(LINTED)(
  "a repository generated from the %s recipe holds the template's lint rule files and turns on every lint rule the template turns on",
  async (row) => {
    expect(
      await generatedLintProblems(ROOT, await generatedFrom(row), row),
    ).toEqual([]);
  },
  generationTimeout,
);

test.each(LINTED)(
  "a repository generated from the %s recipe refuses and admits each comment as the template does",
  async (row) => {
    const lint = generatedLint(await generatedFrom(row));
    const rules = new Set(["repository/no-comments"]);
    const verdicts: [string, number[]][] = [];
    for (const [, code] of commentCases)
      verdicts.push([
        code,
        (await lint(SOURCE_FILE, code, rules)).map(({ line }) => line),
      ]);
    expect(verdicts).toEqual(
      commentCases.map(([, code, lines]) => [code, [...lines]]),
    );
  },
  generationTimeout,
);

test.each(LINTED)(
  "a repository generated from the %s recipe refuses a planted violation of each lint rule and admits its clean form",
  async (row) => {
    const root = await generatedFrom(row);
    const lint = generatedLint(root);
    const cases = [
      ...antiSlopGate.map((item) => ({ ...item, kind: "source" })),
      ...repositoryGate,
    ];
    const rules = new Set<string>(cases.map(({ ruleId }) => ruleId));
    const verdicts: Record<string, unknown> = {};
    for (const { ruleId, kind, refused, admitted } of cases) {
      const file = kind === "test" ? testFileOf(root) : SOURCE_FILE;
      verdicts[ruleId] = {
        refused: (await lint(file, refused, rules)).map((hit) => hit.ruleId),
        admitted: (await lint(file, admitted, rules)).map((hit) => hit.ruleId),
      };
    }
    expect(verdicts).toEqual(
      Object.fromEntries(
        cases.map(({ ruleId }) => [
          ruleId,
          { refused: [ruleId], admitted: [] },
        ]),
      ),
    );
  },
  generationTimeout,
);

const MARKERS =
  "A comment that opens with `Platform:` or `Interface:` makes a claim that a reviewer checks. It is not a way to keep a comment.";
const LINTED_GUIDANCE = `## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
${MARKERS}

The lint rule files in config/ are the template's. Change a lint rule in the template, not here.
`;
const UNLINTED_GUIDANCE = `## Comments

Write no comment in code. Say it in a name, a type or a test title.
${MARKERS}
`;

test(
  "every generated AGENTS.md ends with the comment guidance its recipe's lint can back",
  async () => {
    const guidance: Record<string, string> = {};
    for (const recipe of RECIPES) {
      const text = readFileSync(
        join(await generatedFrom(rowKey(recipe)), "AGENTS.md"),
        "utf8",
      );
      guidance[rowKey(recipe)] = text.slice(text.indexOf("## Comments"));
    }
    expect(guidance).toEqual(
      Object.fromEntries(
        RECIPES.map((recipe) => [
          rowKey(recipe),
          LINTED.includes(rowKey(recipe)) ? LINTED_GUIDANCE : UNLINTED_GUIDANCE,
        ]),
      ),
    );
  },
  generationTimeout,
);
