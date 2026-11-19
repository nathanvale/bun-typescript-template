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
} from "../../support/bootstrap-cli-fixture.ts";
import {
  generatedLint,
  generatedLintProblems,
  kindsOf,
  RULE_FILES,
  TEMPLATE_FILES,
  templateRulesOn,
} from "../../support/generated-lint.ts";
import { commentCases } from "../../support/lint-comment-cases.ts";
import { antiSlopGate, repositoryGate } from "../../support/lint-gate-cases.ts";
import { testFolder } from "../../support/test-folder.ts";

const generationTimeout = 120_000;
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
const TEMPLATE_RULES = {
  source: [
    ...EVERY_FILE,
    "repository/no-in-operator",
    "repository/no-locale-compare",
  ],
  test: [
    ...EVERY_FILE,
    "repository/require-to-throw-message",
    "repository/tests-no-sleep",
    "repository/tests-use-test-folder",
  ],
  config: EVERY_FILE,
};
const LINTED = [
  "durable single-package",
  "durable monorepo",
  "durable single-package simple",
  "durable single-package complex",
];
const TURN_ON =
  "Repair: copy the rule's entry from the template's eslint.config.mjs into the eslint.config.mjs this recipe copies.";

function rowKey({ request }: ProjectRecipe): string {
  return [request.profile, request.layout, request.starter]
    .filter((word) => word !== undefined)
    .join(" ");
}

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
    files: ["**/*.ts", "**/*.mjs"],
    plugins: { repository: { rules: { "no-comments": rule, "tests-no-sleep": rule } } },
    rules: { "repository/no-comments": "error" },
  },
  { files: ["tests/**/*.ts"], rules: { "repository/tests-no-sleep": "error" } },
];
`;

function tree(files: Record<string, string>): string {
  const root = testFolder("generated-lint-fixture-");
  folders.push(root);
  for (const [path, text] of Object.entries({
    ...Object.fromEntries(RULE_FILES.map((file) => [file, `// ${file}\n`])),
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

test.each(Object.entries(TEMPLATE_RULES))(
  "the template turns on exactly these rules of its own for its %s file",
  async (kind, rules) => {
    const file = TEMPLATE_FILES[kind as keyof typeof TEMPLATE_FILES];
    expect(await templateRulesOn(ROOT, file)).toEqual(rules.toSorted());
  },
);

test("a generated file is judged as source, as a test, as both or as a rule file by its path", () => {
  expect(
    Object.fromEntries(
      [
        "src/cli.ts",
        "packages/example-lib/src/index.ts",
        "src/index.test.ts",
        "tests/support/test-folder.ts",
        "config/template-rules.mjs",
      ].map((file) => [file, kindsOf(file)]),
    ),
  ).toEqual({
    "src/cli.ts": ["source"],
    "packages/example-lib/src/index.ts": ["source"],
    "src/index.test.ts": ["source", "test"],
    "tests/support/test-folder.ts": ["test"],
    "config/template-rules.mjs": ["config"],
  });
});

test("a generated tree with the template's rule files and rule settings has no problem", async () => {
  expect(await problemsOf({})).toEqual([]);
});

test("a generated tree that lacks a rule file names the file and the recipe table", async () => {
  const root = tree({ "eslint.config.mjs": FIXTURE_TEMPLATE_CONFIG });
  rmSync(join(root, "config/payload-rules.mjs"));
  expect(await generatedLintProblems(fixtureTemplate, root, "recipe")).toEqual([
    "recipe has no config/payload-rules.mjs, a rule file the template's eslint.config.mjs loads. Repair: name it in LINT_RULES in src/recipe.ts, so that Bootstrap copies it.",
  ]);
});

test("a generated tree whose rule file has other text names the file", async () => {
  expect(
    await problemsOf({ "config/template-rules.mjs": "export default {};\n" }),
  ).toEqual([
    "recipe config/template-rules.mjs differs from the template's config/template-rules.mjs. Repair: let Bootstrap copy the template's file unchanged.",
  ]);
});

test.each([
  [
    "leaves a rule off",
    FIXTURE_TEMPLATE_CONFIG.replace(
      '"repository/no-comments": "error"',
      '"repository/no-comments": "off"',
    ),
  ],
  [
    "only warns on a rule",
    FIXTURE_TEMPLATE_CONFIG.replace(
      '"repository/no-comments": "error"',
      '"repository/no-comments": "warn"',
    ),
  ],
])(
  "a generated tree that %s names the rule for each file it misses",
  async (_, config) => {
    expect(await problemsOf({ "eslint.config.mjs": config })).toEqual(
      [
        ...RULE_FILES,
        "eslint.config.mjs",
        "src/cli.ts",
        "tests/cli.test.ts",
      ].map(
        (file) =>
          `recipe does not turn on repository/no-comments for ${file} as the template's eslint.config.mjs does for ${TEMPLATE_FILES[kindsOf(file)[0] ?? "config"]}. ${TURN_ON}`,
      ),
    );
  },
);

test("a generated tree that narrows a test rule to one file names each test file it misses", async () => {
  expect(
    await problemsOf({
      "tests/other.test.ts": "",
      "eslint.config.mjs": FIXTURE_TEMPLATE_CONFIG.replace(
        '["tests/**/*.ts"]',
        '["tests/cli.test.ts"]',
      ),
    }),
  ).toEqual([
    `recipe does not turn on repository/tests-no-sleep for tests/other.test.ts as the template's eslint.config.mjs does for tests/template/doctor/doctor.test.ts. ${TURN_ON}`,
  ]);
});

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
  "a repository generated from the %s recipe holds the template's rule files and turns on every rule the template turns on",
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
  "a repository generated from the %s recipe refuses a planted violation of each rule and admits its clean form",
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
