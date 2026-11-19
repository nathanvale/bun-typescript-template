import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RECIPES } from "../../../src/recipe.ts";
import { installedPackage } from "../../../src/static-admission.ts";
import {
  type LockFile,
  type PackageJson,
  recipeFolders,
  toolchainProblems,
} from "../../support/generated-toolchain.ts";
import { testFolder } from "../../support/test-folder.ts";

const root = join(import.meta.dir, "../../..");
const fixtures: string[] = [];
const OVERRIDE = "@typescript/old@npm:typescript@^6";
const RELOCK =
  "Repair: run bun install --lockfile-only in a copy of recipe and copy its bun.lock back.";
const UNREAD =
  "which this test cannot compare with the template's version. Repair: use a plain version, an npm: alias or an entry of the default catalog, or teach tests/support/generated-toolchain.ts to read it.";

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true });
});

const TEMPLATE: Partial<PackageJson> = {
  packageManager: "bun@1.4.4",
  devDependencies: {
    "@types/bun": "1.4.4",
    eslint: "10.15.0",
    typescript: "npm:@typescript/typescript6@6.0.2",
    "@typescript/native": "npm:typescript@7.1.0-beta",
  },
  overrides: { [OVERRIDE]: "npm:typescript@6.0.2" },
};
const LATEST: Partial<PackageJson> = {
  packageManager: "bun@1.4.4",
  devDependencies: { "@types/bun": "1.4.4", typescript: "7.1.0-beta" },
};

function lockOf(packageJson: Partial<PackageJson>): Partial<LockFile> {
  const ranges = Object.entries({
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
    ...packageJson.optionalDependencies,
  }).filter(([, range]) => !range.startsWith("catalog:"));
  return {
    workspaces: { "": packageJson },
    ...(packageJson.catalog ? { catalog: packageJson.catalog } : {}),
    overrides: Object.fromEntries(
      Object.entries(packageJson.overrides ?? {}).map(([key, range]) => [
        key,
        { ".": range },
      ]),
    ),
    packages: Object.fromEntries(
      ranges.map(([name, range]) => [name, [installedPackage(name, range)]]),
    ),
  };
}

function treeWith(files: Record<string, unknown>): string {
  const tree = testFolder("generated-toolchain-");
  fixtures.push(tree);
  for (const [path, content] of Object.entries({
    "package.json": TEMPLATE,
    ...files,
  })) {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), JSON.stringify(content));
  }
  return tree;
}

async function problemsOf(files: Record<string, unknown>): Promise<string[]> {
  return await toolchainProblems(treeWith(files), ["recipe"]);
}

test("every recipe folder that ships a package.json installs the template's toolchain, and its bun.lock agrees", async () => {
  expect(await toolchainProblems(root, recipeFolders(root))).toEqual([]);
});

test("every recipe copies its package.json from a recipe folder this test compares", () => {
  const compared = new Set(recipeFolders(root));
  for (const { request, copies } of RECIPES)
    expect({
      request,
      compared: copies.some(({ from }) => compared.has(from)),
    }).toEqual({ request, compared: true });
});

test("a recipe folder on the template's toolchain, with a package the template lacks, passes", async () => {
  const packageJson = { ...LATEST, dependencies: { zod: "4.4.3" } };
  expect(
    await problemsOf({
      "recipe/package.json": packageJson,
      "recipe/bun.lock": lockOf(packageJson),
    }),
  ).toEqual([]);
});

test.each<[string, Partial<PackageJson>, string]>([
  [
    "a compiler older than the template's",
    {
      ...LATEST,
      devDependencies: { "@types/bun": "1.4.4", typescript: "7.0.2" },
    },
    "recipe/package.json devDependencies.typescript installs typescript@7.0.2, and the template's package.json has typescript@7.1.0-beta. Repair: make it install typescript@7.1.0-beta, then regenerate recipe/bun.lock.",
  ],
  [
    "a catalog entry older than the template's",
    { ...LATEST, catalog: { typescript: "npm:typescript@7.0.2" } },
    "recipe/package.json catalog.typescript installs typescript@7.0.2, and the template's package.json has typescript@7.1.0-beta. Repair: make it install typescript@7.1.0-beta, then regenerate recipe/bun.lock.",
  ],
  [
    "an optional dependency older than the template's",
    { ...LATEST, optionalDependencies: { eslint: "10.0.0" } },
    "recipe/package.json optionalDependencies.eslint installs eslint@10.0.0, and the template's package.json has eslint@10.15.0. Repair: make it install eslint@10.15.0, then regenerate recipe/bun.lock.",
  ],
  [
    "another override",
    { ...LATEST, overrides: { [OVERRIDE]: "npm:typescript@6.0.1" } },
    `recipe/package.json overrides.${OVERRIDE} is npm:typescript@6.0.1, and the template's package.json has npm:typescript@6.0.2. Repair: copy the template's override.`,
  ],
  [
    "another Bun",
    { ...LATEST, packageManager: "bun@1.4.3" },
    "recipe/package.json has packageManager bun@1.4.3, and the template's package.json has bun@1.4.4. Repair: set it to bun@1.4.4.",
  ],
  [
    "a named catalog",
    { ...LATEST, devDependencies: { typescript: "catalog:tools" } },
    `recipe/package.json devDependencies.typescript is catalog:tools, ${UNREAD}`,
  ],
  [
    "a catalog reference with no catalog entry",
    { ...LATEST, devDependencies: { typescript: "catalog:" } },
    `recipe/package.json devDependencies.typescript is catalog:, ${UNREAD}`,
  ],
  [
    "workspaces written as an object",
    { ...LATEST, workspaces: { packages: ["packages/*"] } },
    "recipe/package.json workspaces is not a list of folders, the only form this test reads. Repair: list member folders in workspaces, or teach tests/support/generated-toolchain.ts to read it.",
  ],
])(
  "%s fails, naming the file and what to change",
  async (_fault, packageJson, message) => {
    expect(
      await problemsOf({
        "recipe/package.json": packageJson,
        "recipe/bun.lock": lockOf(packageJson),
      }),
    ).toEqual([message]);
  },
);

test("a workspace member older than the template's fails, naming the member's package.json", async () => {
  const top = { ...LATEST, workspaces: ["packages/*"] };
  const member = { name: "lib", devDependencies: { typescript: "7.0.2" } };
  const lock = lockOf(top);
  expect(
    await problemsOf({
      "recipe/package.json": top,
      "recipe/packages/lib/package.json": member,
      "recipe/bun.lock": {
        ...lock,
        workspaces: { ...lock.workspaces, "packages/lib": member },
        packages: { ...lock.packages, "lib/typescript": ["typescript@7.0.2"] },
      },
    }),
  ).toEqual([
    "recipe/packages/lib/package.json devDependencies.typescript installs typescript@7.0.2, and the template's package.json has typescript@7.1.0-beta. Repair: make it install typescript@7.1.0-beta, then regenerate recipe/bun.lock.",
  ]);
});

test("a recipe folder whose bun.lock installs an overridden package without the template's override fails", async () => {
  const lock = lockOf(LATEST);
  expect(
    await problemsOf({
      "recipe/package.json": LATEST,
      "recipe/bun.lock": {
        ...lock,
        packages: { ...lock.packages, "@typescript/old": ["typescript@6.0.3"] },
      },
    }),
  ).toEqual([
    `recipe/package.json has no override ${OVERRIDE}, and recipe/bun.lock installs @typescript/old. Repair: add "${OVERRIDE}": "npm:typescript@6.0.2" to its overrides, then regenerate recipe/bun.lock.`,
  ]);
});

test("a recipe folder with no bun.lock fails", async () => {
  expect(await problemsOf({ "recipe/package.json": LATEST })).toEqual([
    `recipe has no bun.lock. ${RELOCK}`,
  ]);
});

test.each<[string, Partial<PackageJson>, Partial<LockFile>, string[]]>([
  [
    "a bun.lock that was not regenerated after a package.json change",
    LATEST,
    lockOf({
      ...LATEST,
      devDependencies: { "@types/bun": "1.4.0", typescript: "7.1.0-beta" },
    }),
    [
      `recipe/bun.lock records other devDependencies for package.json. ${RELOCK}`,
      `recipe/bun.lock resolves package.json devDependencies.@types/bun to @types/bun@1.4.0, not @types/bun@1.4.4. ${RELOCK}`,
    ],
  ],
  [
    "a bun.lock with another catalog",
    { ...LATEST, catalog: { "@types/bun": "1.4.4" } },
    { ...lockOf(LATEST), catalog: { "@types/bun": "1.4.0" } },
    [`recipe/bun.lock records another catalog. ${RELOCK}`],
  ],
  [
    "a bun.lock with other overrides",
    { ...LATEST, overrides: { [OVERRIDE]: "npm:typescript@6.0.2" } },
    lockOf(LATEST),
    [`recipe/bun.lock records other overrides. ${RELOCK}`],
  ],
])("%s fails, naming the lock", async (_fault, packageJson, lock, messages) => {
  expect(
    await problemsOf({
      "recipe/package.json": packageJson,
      "recipe/bun.lock": lock,
    }),
  ).toEqual(messages);
});
