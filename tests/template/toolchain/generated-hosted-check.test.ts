import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  invoke,
  requireSuccess,
  ROOT,
} from "../../support/bootstrap-cli-fixture.ts";
import { generatedHostedCheckProblems } from "../../support/generated-hosted-check.ts";
import { processWatchdog } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const folders: string[] = [];

afterAll(() => {
  for (const folder of folders) rmSync(folder, { recursive: true });
});

const TEMPLATE_WORKFLOW = `name: Hosted check

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun run check
`;

const GENERATED_WORKFLOW = `name: Hosted check

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun run check
      - name: Check Fallow recorded hits did not grow
        env:
          BASE: \${{ github.event.pull_request.base.sha || github.event.before }}
        run: |
          if [ -z "\${BASE:-}" ] || ! git cat-file -e "\${BASE}^{commit}" 2>/dev/null; then
            echo "Skipping Fallow recorded-hits growth check: no base commit \${BASE:-} in this checkout."
            exit 0
          fi
          bun run --silent quality:fallow -- --fail-on-baseline-growth --baseline-base "$BASE"
`;

function tree(files: Record<string, string>): string {
  const root = testFolder("generated-hosted-check-");
  folders.push(root);
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
  return root;
}

const fixtureTemplate = tree({
  "package.json": '{"packageManager":"bun@1.4.4"}\n',
  ".github/workflows/ci.yml": TEMPLATE_WORKFLOW,
});

function problemsFor(
  generatedFiles: Record<string, string>,
  template = fixtureTemplate,
): Promise<string[]> {
  return generatedHostedCheckProblems(template, tree(generatedFiles), "recipe");
}

test(
  "a repository Bootstrap generates holds a Hosted check workflow pinned to the template's actions and Bun version",
  async () => {
    const destination = join(testFolder("generated-hosted-check-"), "repo");
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
    expect(
      await generatedHostedCheckProblems(ROOT, destination, "generated"),
    ).toEqual([]);
  },
  processWatchdog(1),
);

test("a generated tree matching the template's Hosted check workflow and pins has no problem", async () => {
  expect(
    await problemsFor({ ".github/workflows/ci.yml": GENERATED_WORKFLOW }),
  ).toEqual([]);
});

test("a generated tree that lacks the Hosted check workflow fails, naming the workflow and the recipe table", async () => {
  expect(await problemsFor({})).toEqual([
    "recipe has no .github/workflows/ci.yml. Repair: copy generated-repository/hosted-check into .github/workflows in KERNEL_RECIPE in src/recipe.ts.",
  ]);
});

test.each<[string, string, string]>([
  [
    "an actions/checkout pin older than the template's",
    GENERATED_WORKFLOW.replace("actions/checkout@v4", "actions/checkout@v3"),
    "recipe .github/workflows/ci.yml job check step #1 uses actions/checkout@v3, and the template pins actions/checkout@v4. Repair: set uses: actions/checkout@v4 in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "an oven-sh/setup-bun pin older than the template's",
    GENERATED_WORKFLOW.replace("oven-sh/setup-bun@v2", "oven-sh/setup-bun@v1"),
    "recipe .github/workflows/ci.yml job check step #2 uses oven-sh/setup-bun@v1, and the template pins oven-sh/setup-bun@v2. Repair: set uses: oven-sh/setup-bun@v2 in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "a bun-version older than the template's toolchain pin",
    GENERATED_WORKFLOW.replace("bun-version: 1.4.4", "bun-version: 1.4.3"),
    "recipe .github/workflows/ci.yml job check step #2 sets bun-version 1.4.3, and the template pins 1.4.4. Repair: set bun-version: 1.4.4 in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "a setup-bun step without bun-version",
    GENERATED_WORKFLOW.replace(
      "        with:\n          bun-version: 1.4.4\n",
      "",
    ),
    "recipe .github/workflows/ci.yml job check step #2 has no bun-version. Repair: set bun-version: 1.4.4 in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "a setup-bun step using bun-version-file",
    GENERATED_WORKFLOW.replace(
      "bun-version: 1.4.4",
      "bun-version-file: .bun-version",
    ),
    "recipe .github/workflows/ci.yml job check step #2 uses bun-version-file. Repair: set bun-version: 1.4.4 in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "write permissions",
    GENERATED_WORKFLOW.replace("contents: read", "contents: write"),
    "recipe .github/workflows/ci.yml must set read-only permissions (contents: read). Repair: set top-level permissions to contents: read.",
  ],
  [
    "omitted permissions",
    GENERATED_WORKFLOW.replace("permissions:\n  contents: read\n\n", ""),
    "recipe .github/workflows/ci.yml must set read-only permissions (contents: read). Repair: set top-level permissions to contents: read.",
  ],
  [
    "a non-Linux runner",
    GENERATED_WORKFLOW.replace("ubuntu-latest", "macos-latest"),
    "recipe .github/workflows/ci.yml job check runs on macos-latest, not ubuntu-latest. Repair: set runs-on: ubuntu-latest.",
  ],
  [
    "a path filter on pull_request",
    GENERATED_WORKFLOW.replace(
      "  pull_request:\n",
      "  pull_request:\n    paths: [src/**]\n",
    ),
    "recipe .github/workflows/ci.yml pull_request trigger filters or narrows events. Repair: leave pull_request empty with no path filter.",
  ],
  [
    "a path filter on push",
    GENERATED_WORKFLOW.replace(
      "    branches: [main]\n",
      "    branches: [main]\n    paths-ignore: [README.md]\n",
    ),
    "recipe .github/workflows/ci.yml push trigger must target branches: [main] with no path filter. Repair: set push.branches to [main] with no paths or paths-ignore.",
  ],
  [
    "a check command other than bun run check",
    GENERATED_WORKFLOW.replace("bun run check", "bun test"),
    "recipe .github/workflows/ci.yml job check must run actions/checkout@v4 with fetch-depth: 0, oven-sh/setup-bun@v2, bun install --frozen-lockfile, bun run check, then the Fallow recorded-hits growth check with BASE ${{ github.event.pull_request.base.sha || github.event.before }}. Repair: match those five steps in order in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "a shallow checkout without fetch-depth: 0",
    GENERATED_WORKFLOW.replace("        with:\n          fetch-depth: 0\n", ""),
    "recipe .github/workflows/ci.yml job check must run actions/checkout@v4 with fetch-depth: 0, oven-sh/setup-bun@v2, bun install --frozen-lockfile, bun run check, then the Fallow recorded-hits growth check with BASE ${{ github.event.pull_request.base.sha || github.event.before }}. Repair: match those five steps in order in generated-repository/hosted-check/ci.yml.",
  ],
  [
    "a GitHub secret reference",
    `${GENERATED_WORKFLOW}      - env:\n          TOKEN: \${{ secrets.TOKEN }}\n        run: true\n`,
    "recipe .github/workflows/ci.yml references GitHub secrets. Repair: keep secrets out of generated-repository/hosted-check/ci.yml.",
  ],
])(
  "%s fails, naming the problem and repair",
  async (_fault, content, message) => {
    expect(
      await problemsFor({ ".github/workflows/ci.yml": content }),
    ).toContain(message);
  },
);

test("when the template moves an action pin and the generated workflow does not, the check fails", async () => {
  const movedTemplate = tree({
    "package.json": '{"packageManager":"bun@1.4.4"}\n',
    ".github/workflows/ci.yml": TEMPLATE_WORKFLOW.replace(
      "actions/checkout@v4",
      "actions/checkout@v5",
    ),
  });
  expect(
    await problemsFor(
      { ".github/workflows/ci.yml": GENERATED_WORKFLOW },
      movedTemplate,
    ),
  ).toEqual([
    "recipe .github/workflows/ci.yml job check step #1 uses actions/checkout@v4, and the template pins actions/checkout@v5. Repair: set uses: actions/checkout@v5 in generated-repository/hosted-check/ci.yml.",
  ]);
});
