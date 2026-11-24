import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  CHANGESET_FOLDER,
  copiesOf,
  HOSTED_CHECK_FOLDER,
  KERNEL_LOCKFILE,
  KERNEL_RECIPE,
  LINT_RULE_FILES,
  PIN_SETTINGS,
  type Recipe,
} from "../../../src/recipe.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { EXPECTED_RULE_FILES } from "../../support/lint-rule-files.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const bootstrapBound = 20_000;
const bootstrapTestTimeout = 30_000;

async function filesUnder(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...(await filesUnder(root, path)));
    else files.push(path);
  }
  return files;
}

async function copiedPairs(
  recipe: Recipe,
): Promise<{ from: string; to: string }[]> {
  const pairs: { from: string; to: string }[] = [];
  for (const copy of copiesOf(recipe)) {
    const source = join(ROOT, copy.from);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (copy.only !== undefined && !copy.only.includes(entry.name)) continue;
      const paths = entry.isDirectory()
        ? await filesUnder(source, entry.name)
        : [entry.name];
      pairs.push(
        ...paths.map((path) => ({
          from: join(source, path),
          to: join(copy.into, path),
        })),
      );
    }
  }
  return pairs;
}

async function copiedFiles(recipe: Recipe): Promise<string[]> {
  return (await copiedPairs(recipe)).map(({ to }) => to);
}

function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function duplicates(values: string[]): string[] {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

describe("the recipe", () => {
  test("its source folders exist and copy disjoint files", async () => {
    for (const copy of copiesOf(KERNEL_RECIPE)) {
      const source = join(ROOT, copy.from);
      expect({ source, folder: statSync(source).isDirectory() }).toEqual({
        source,
        folder: true,
      });
    }
    expect(duplicates(await copiedFiles(KERNEL_RECIPE))).toEqual([]);
  });

  test("every file it copies is UTF-8 text, because token substitution rewrites each copied file as text", async () => {
    const notText: string[] = [];
    for (const { from } of await copiedPairs(KERNEL_RECIPE))
      if (!isUtf8Text(await readFile(from))) notText.push(relative(ROOT, from));
    expect(notText).toEqual([]);
  });

  test("its Pin copies the settings whose package.json names the kernel by the token Bootstrap fills with the template's Pin", async () => {
    const { dependencies } = JSON.parse(
      await readFile(join(ROOT, PIN_SETTINGS.from, "package.json"), "utf8"),
    ) as { dependencies: Record<string, string> };
    expect({ pin: KERNEL_RECIPE.pin, dependencies }).toEqual({
      pin: PIN_SETTINGS,
      dependencies: { "agent-cli-kernel": "__KERNEL_PIN__" },
    });
  });

  test("its check command is the generated repository's bun run check", () => {
    expect(KERNEL_RECIPE.checkCommand).toBe("bun run check");
  });

  test("it copies every lint rule file into config", async () => {
    const ruleFiles = [...EXPECTED_RULE_FILES];
    expect(LINT_RULE_FILES.map((file) => `config/${file}`)).toEqual(ruleFiles);
    expect(
      (await copiedFiles(KERNEL_RECIPE))
        .filter((file) => file.startsWith("config/"))
        .toSorted(),
    ).toEqual(ruleFiles);
  });

  test("it copies the Hosted check workflow into .github/workflows", async () => {
    expect(
      (await copiedFiles(KERNEL_RECIPE))
        .filter((file) => file.startsWith(`${HOSTED_CHECK_FOLDER}/`))
        .toSorted(),
    ).toEqual([`${HOSTED_CHECK_FOLDER}/ci.yml`]);
  });

  test("it copies the Changesets config and README into .changeset and the gated-paths script into scripts", async () => {
    const files = await copiedFiles(KERNEL_RECIPE);
    expect(
      files
        .filter((file) => file.startsWith(`${CHANGESET_FOLDER}/`))
        .toSorted(),
    ).toEqual([
      `${CHANGESET_FOLDER}/README.md`,
      `${CHANGESET_FOLDER}/config.json`,
    ]);
    expect(
      files.filter((file) => file.startsWith("scripts/")).toSorted(),
    ).toEqual(["scripts/check-gated-paths.ts", "scripts/test-run.ts"]);
  });
});

const probeFolder = ownedFolders();

async function compile(row: string) {
  const probe = probeFolder("recipe-compile-");
  writeFileSync(
    join(probe, "probe.ts"),
    `import { PIN_SETTINGS, type Recipe } from ${JSON.stringify(join(ROOT, "src/recipe.ts"))};\nexport const row: Recipe = ${row};\nexport const settings = PIN_SETTINGS;\n`,
  );
  writeFileSync(
    join(probe, "tsconfig.json"),
    JSON.stringify({
      extends: join(ROOT, "tsconfig.base.json"),
      compilerOptions: { typeRoots: [join(ROOT, "node_modules/@types")] },
      files: ["probe.ts"],
    }),
  );
  const run = await spawnBounded(
    [join(ROOT, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
    { cwd: probe },
  );
  return {
    exit: run.exit,
    errors: [
      ...run.stdout.matchAll(/probe\.ts\((\d+),\d+\): error (TS\d+)/g),
    ].map(([, line, code]) => `line ${line}: ${code}`),
  };
}

describe("the type check on a recipe row", () => {
  test(
    "the control: a row with the Pin's settings compiles",
    async () => {
      expect(
        await compile(
          '{ pin: PIN_SETTINGS, copies: [], checkCommand: "bun run check" }',
        ),
      ).toEqual({ exit: 0, errors: [] });
    },
    processWatchdog(1),
  );

  test(
    "refuses a row without the Pin",
    async () => {
      expect(
        await compile(
          '{ copies: [{ from: "generated-repository/application", into: "." }], checkCommand: "bun run check" }',
        ),
      ).toEqual({ exit: 2, errors: ["line 2: TS2741"] });
    },
    processWatchdog(1),
  );

  test(
    "refuses a row whose Pin copies another folder's settings",
    async () => {
      expect(
        await compile(
          '{ pin: { from: "settings", into: "." }, copies: [], checkCommand: "bun run check" }',
        ),
      ).toEqual({ exit: 2, errors: ["line 2: TS2322"] });
    },
    processWatchdog(1),
  );
});

const carryOutFolders: string[] = [];

afterEach(async () => {
  await Promise.all(
    carryOutFolders
      .splice(0)
      .map((folder) => rm(folder, { force: true, recursive: true })),
  );
});

describe("Bootstrap carrying out a row", () => {
  test.each([
    {
      name: "a missing template source folder",
      path: "generated-repository/application",
      plant: "remove",
      code: "recipe_source_missing",
      message: "recipe folder is missing: generated-repository/application",
    },
    {
      name: "a missing template source file",
      path: "tests/support/test-folder.ts",
      plant: "remove",
      code: "recipe_source_missing",
      message: "recipe file is missing: tests/support/test-folder.ts",
    },
    {
      name: "a folder where a template source file belongs",
      path: "config/payload-rules.mjs",
      plant: "folder",
      code: "recipe_source_wrong_type",
      message: "recipe file is not a regular file: config/payload-rules.mjs",
    },
    {
      name: "a file where a template source folder belongs",
      path: "generated-repository/application",
      plant: "file",
      code: "recipe_source_wrong_type",
      message:
        "recipe folder is not a folder: generated-repository/application",
    },
  ])(
    "refuses $name before any file is copied",
    async ({ path, plant, code, message }) => {
      const template = testFolder("recipe-template-");
      carryOutFolders.push(template);
      for (const path of [
        "src",
        "kernel-pin.json",
        KERNEL_LOCKFILE,
        ...copiesOf(KERNEL_RECIPE).map(({ from }) => from),
      ])
        await cp(join(ROOT, path), join(template, path), { recursive: true });
      const planted = join(template, path);
      await rm(planted, { recursive: true });
      if (plant === "folder")
        await mkdir(join(planted, "planted"), { recursive: true });
      if (plant === "file") await writeFile(planted, "planted\n");
      expect(existsSync(planted)).toBe(plant !== "remove");
      const output = testFolder("recipe-out-");
      carryOutFolders.push(output);
      const parent = join(output, "nested");
      const destination = join(parent, "demo-app");

      const child = await spawnBounded(
        [
          process.execPath,
          "run",
          join(template, "src/bootstrap.ts"),
          "--destination",
          destination,
          "--source-packet",
          "/abs/packets/demo",
          "--json",
        ],
        {
          boundMilliseconds: bootstrapBound,
          processGroup: true,
          env: { ...process.env, KERNEL_REPOSITORY: siblingKernel() },
        },
      );

      expect({
        exitCode: child.exit,
        stdout: child.stdout,
        stderr: JSON.parse(child.stderr) as unknown,
      }).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: {
          schemaVersion: 1,
          status: "refused",
          error: {
            code,
            message,
            repair: `run git restore ${path} in the template repository`,
            retrySafe: false,
          },
        },
      });
      expect(existsSync(parent)).toBe(false);
    },
    bootstrapTestTimeout,
  );
});
