import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  invoke,
  requireSuccess,
  ROOT,
} from "../../support/bootstrap-cli-fixture.ts";
import {
  generatedLint,
  generatedLintProblems,
  lintRulesOn,
} from "../../support/generated-lint.ts";
import { kernelCheckout } from "../../support/kernel-sibling.ts";
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
const TURN_ON =
  "Repair: copy the lint rule's entry, with its files, from the template's eslint.config.mjs into the eslint.config.mjs this recipe copies.";

function installTemplatePackagesAndKernel(destination: string): void {
  const modules = join(destination, "node_modules");
  mkdirSync(modules);
  for (const name of readdirSync(join(ROOT, "node_modules")))
    symlinkSync(join(ROOT, "node_modules", name), join(modules, name));
  kernelCheckout(join(modules, readKernelPin(ROOT).repository));
}

async function bootstrapped(): Promise<string> {
  const destination = join(testFolder("generated-lint-"), "repository");
  folders.push(dirname(destination));
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

let generated: Promise<string> | undefined;

function generatedRepository(): Promise<string> {
  generated ??= bootstrapped();
  return generated;
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
  "a repository Bootstrap generates holds the template's lint rule files and turns on every lint rule the template turns on",
  async () => {
    expect(
      await generatedLintProblems(
        ROOT,
        await generatedRepository(),
        "generated",
      ),
    ).toEqual([]);
  },
  generationTimeout,
);

test(
  "a repository Bootstrap generates refuses and admits each comment as the template does",
  async () => {
    const lint = generatedLint(await generatedRepository());
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

test(
  "a repository Bootstrap generates refuses a planted violation of each lint rule and admits its clean form",
  async () => {
    const root = await generatedRepository();
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

const SCRIPT_RULES = new Set([
  "repository/no-in-operator",
  "repository/no-locale-compare",
]);

test(
  "a repository Bootstrap generates refuses no-in-operator and no-locale-compare in a script, with the type information they need, and admits their clean forms",
  async () => {
    const root = await generatedRepository();
    const lint = generatedLint(root);
    const script = "scripts/probe.ts";
    mkdirSync(join(root, "scripts"), { recursive: true });
    const verdicts: Record<string, unknown> = {};
    for (const { ruleId, refused, admitted } of repositoryGate.filter((item) =>
      SCRIPT_RULES.has(item.ruleId),
    )) {
      const rules = new Set([ruleId]);
      const lines = async (code: string) => {
        writeFileSync(join(root, script), code);
        return (await lint(script, code, rules)).map((hit) => hit.ruleId);
      };
      verdicts[ruleId] = {
        refused: await lines(refused),
        admitted: await lines(admitted),
      };
    }
    rmSync(join(root, "scripts"), { recursive: true });
    expect(verdicts).toEqual({
      "repository/no-in-operator": {
        refused: ["repository/no-in-operator"],
        admitted: [],
      },
      "repository/no-locale-compare": {
        refused: ["repository/no-locale-compare"],
        admitted: [],
      },
    });
  },
  generationTimeout,
);

test(
  "a generated AGENTS.md ends with the comment guidance its lint backs",
  async () => {
    const text = readFileSync(
      join(await generatedRepository(), "AGENTS.md"),
      "utf8",
    );
    expect(text.slice(text.indexOf("## Comments"))).toBe(`## Comments

Lint refuses a comment in code, so say it in a name, a type or a test title.
A comment that opens with \`Platform:\` or \`Interface:\` makes a claim that a reviewer checks. It is not a way to keep a comment.

The lint rule files in config/ are the template's. Change a lint rule in the template, not here.
`);
  },
  generationTimeout,
);
