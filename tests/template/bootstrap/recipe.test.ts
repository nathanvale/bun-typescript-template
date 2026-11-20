import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import {
  KERNEL_RECIPE,
  LINT_RULE_FILES,
  lintsCode,
  PROFILES,
  type ProjectRecipe,
  RECIPES,
  type Selection,
  STARTERS,
  selectRecipe,
  UNCOPIED_NAMES,
} from "../../../src/recipe.ts";
import { rowKey } from "../../support/bootstrap-cli-fixture.ts";
import { EXPECTED_RULE_FILES } from "../../support/lint-rule-files.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const bootstrapBound = 20_000;
const bootstrapTestTimeout = 30_000;

const MONOREPO_NEEDS_DURABLE = {
  status: "refused",
  message: "--monorepo is available only with --profile durable",
  repair: "remove --monorepo or choose --profile durable",
};
const STARTER_NEEDS_DURABLE = {
  status: "refused",
  message: "--starter is available only with --profile durable",
  repair: "remove --starter or choose --profile durable",
};
const STARTER_WITH_MONOREPO = {
  status: "refused",
  message: "--starter and --monorepo cannot be combined",
  repair: "choose one CLI starter or the explicit monorepo example",
};

const KERNEL_NEEDS_DURABLE = {
  status: "refused",
  message: "--kernel is available only with --profile durable",
  repair: "remove --kernel or choose --profile durable",
};
const KERNEL_WITH_STARTER = {
  status: "refused",
  message: "--kernel and --starter cannot be combined",
  repair: "choose --kernel or one CLI starter",
};
const KERNEL_WITH_MONOREPO = {
  status: "refused",
  message: "--kernel and --monorepo cannot be combined",
  repair: "choose --kernel or the explicit monorepo example",
};

const OUTCOMES: Record<string, unknown> = {
  scratch: { status: "selected", row: "scratch single-package" },
  "scratch simple": STARTER_NEEDS_DURABLE,
  "scratch complex": STARTER_NEEDS_DURABLE,
  "scratch --monorepo": MONOREPO_NEEDS_DURABLE,
  "scratch --monorepo simple": MONOREPO_NEEDS_DURABLE,
  "scratch --monorepo complex": MONOREPO_NEEDS_DURABLE,
  durable: { status: "selected", row: "durable single-package" },
  "durable simple": {
    status: "selected",
    row: "durable single-package simple",
  },
  "durable complex": {
    status: "selected",
    row: "durable single-package complex",
  },
  "durable --monorepo": { status: "selected", row: "durable monorepo" },
  "durable --monorepo simple": STARTER_WITH_MONOREPO,
  "durable --monorepo complex": STARTER_WITH_MONOREPO,
  "scratch --kernel": KERNEL_NEEDS_DURABLE,
  "scratch simple --kernel": KERNEL_NEEDS_DURABLE,
  "scratch complex --kernel": KERNEL_NEEDS_DURABLE,
  "scratch --monorepo --kernel": KERNEL_NEEDS_DURABLE,
  "scratch --monorepo simple --kernel": KERNEL_NEEDS_DURABLE,
  "scratch --monorepo complex --kernel": KERNEL_NEEDS_DURABLE,
  "durable --kernel": {
    status: "selected",
    row: "durable single-package kernel",
  },
  "durable simple --kernel": KERNEL_WITH_STARTER,
  "durable complex --kernel": KERNEL_WITH_STARTER,
  "durable --monorepo --kernel": KERNEL_WITH_MONOREPO,
  "durable --monorepo simple --kernel": KERNEL_WITH_STARTER,
  "durable --monorepo complex --kernel": KERNEL_WITH_STARTER,
};

const PROVENANCE: Record<string, unknown> = {
  "scratch single-package": {
    profile: "scratch",
    starter: "simple",
    checkCommand: "bun run typecheck && bun run test",
  },
  "durable single-package": {
    profile: "durable",
    starter: "simple",
    checkCommand: "bun run check",
  },
  "durable monorepo": {
    profile: "durable",
    starter: "simple",
    checkCommand: "bun run check",
  },
  "durable single-package simple": {
    profile: "durable",
    starter: "simple",
    checkCommand: "bun run check",
  },
  "durable single-package complex": {
    profile: "durable",
    starter: "complex",
    checkCommand: "bun run check",
  },
};

function selections(): Selection[] {
  return [false, true].flatMap((kernel) =>
    (["scratch", "durable"] as const).flatMap((profile) =>
      [false, true].flatMap((monorepo) =>
        ([undefined, "simple", "complex"] as const).map((starter) => ({
          profile,
          monorepo,
          ...(starter === undefined ? {} : { starter }),
          ...(kernel ? { kernel } : {}),
        })),
      ),
    ),
  );
}

function selectionKey(selection: Selection): string {
  return [
    selection.profile,
    selection.monorepo ? "--monorepo" : undefined,
    selection.starter,
    selection.kernel === true ? "--kernel" : undefined,
  ]
    .filter((word) => word !== undefined)
    .join(" ");
}

function outcome(selection: Selection): unknown {
  const choice = selectRecipe(selection);
  return choice.status === "selected"
    ? { status: "selected", row: rowKey(choice.recipe) }
    : choice;
}

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
  recipe: ProjectRecipe,
): Promise<{ from: string; to: string }[]> {
  const pairs: { from: string; to: string }[] = [];
  for (const copy of recipe.copies) {
    const source = join(ROOT, copy.from);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (UNCOPIED_NAMES.includes(entry.name)) continue;
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

async function copiedFiles(recipe: ProjectRecipe): Promise<string[]> {
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

describe("project recipe", () => {
  test("every flag combination maps to exactly one row or one refusal", () => {
    const outcomes = Object.fromEntries(
      selections().map((selection) => [
        selectionKey(selection),
        outcome(selection),
      ]),
    );
    expect(outcomes).toEqual(OUTCOMES);
    const rows = [...RECIPES, KERNEL_RECIPE].map(rowKey);
    expect(duplicates(rows)).toEqual([]);
    expect(rows.toSorted()).toEqual(
      Object.values(OUTCOMES)
        .flatMap((value) =>
          typeof value === "object" && value !== null && "row" in value
            ? [String(value.row)]
            : [],
        )
        .toSorted(),
    );
  });

  test("each row's source folders exist and copy disjoint files", async () => {
    for (const recipe of RECIPES) {
      for (const copy of recipe.copies) {
        const source = join(ROOT, copy.from);
        expect({ source, exists: existsSync(source) }).toEqual({
          source,
          exists: true,
        });
        expect(statSync(source).isDirectory()).toBe(true);
      }
      const files = await copiedFiles(recipe);
      expect({ row: rowKey(recipe), collisions: duplicates(files) }).toEqual({
        row: rowKey(recipe),
        collisions: [],
      });
    }
  });

  test("every file a row copies is UTF-8 text, because token substitution rewrites each copied file as text", async () => {
    const notText: string[] = [];
    for (const recipe of [...RECIPES, KERNEL_RECIPE])
      for (const { from } of await copiedPairs(recipe))
        if (!isUtf8Text(await readFile(from)))
          notText.push(relative(ROOT, from));
    expect(notText).toEqual([]);
  });

  test("each row's Template provenance values match what Bootstrap writes today", () => {
    const provenance: Record<string, unknown> = Object.fromEntries(
      RECIPES.map((recipe) => [
        rowKey(recipe),
        {
          profile: recipe.request.profile,
          starter: recipe.cli,
          checkCommand: recipe.checkCommand,
        },
      ]),
    );
    expect(provenance).toEqual(PROVENANCE);
  });

  test("the profile and starter words Bootstrap accepts are the ones the rows use", () => {
    expect({ profiles: PROFILES, starters: STARTERS }).toEqual({
      profiles: ["scratch", "durable"],
      starters: ["simple", "complex"],
    });
  });

  test("the four durable rows copy every lint rule file into config, and the scratch row copies none", async () => {
    const ruleFiles = [...EXPECTED_RULE_FILES];
    expect(LINT_RULE_FILES.map((file) => `config/${file}`)).toEqual(ruleFiles);
    const copied: Record<string, unknown> = {};
    for (const recipe of RECIPES)
      copied[rowKey(recipe)] = {
        lintsCode: lintsCode(recipe),
        ruleFiles: (await copiedFiles(recipe))
          .filter((file) => file.startsWith("config/"))
          .toSorted(),
      };
    const linted = { lintsCode: true, ruleFiles };
    expect(copied).toEqual({
      "scratch single-package": { lintsCode: false, ruleFiles: [] },
      "durable single-package": linted,
      "durable monorepo": linted,
      "durable single-package simple": linted,
      "durable single-package complex": linted,
    });
  });

  test("a selection that no row and no refusal matches throws, naming the selection", () => {
    const withGap = RECIPES.filter(
      ({ request }) => request.profile !== "scratch",
    );

    expect(() =>
      selectRecipe({ profile: "scratch", monorepo: false }, withGap),
    ).toThrow(
      "No recipe and no refusal matches profile scratch, monorepo false, starter none. Repair: add a recipe to RECIPES or a case to refusal().",
    );
  });
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
      path: "starters/shared/src",
      plant: "remove",
      code: "profile_source_missing",
      message: "recipe folder is missing: starters/shared/src",
    },
    {
      name: "a missing template source file",
      path: "tests/support/test-folder.ts",
      plant: "remove",
      code: "profile_source_missing",
      message: "recipe file is missing: tests/support/test-folder.ts",
    },
    {
      name: "a folder where a template source file belongs",
      path: "config/payload-rules.mjs",
      plant: "folder",
      code: "profile_source_wrong_type",
      message: "recipe file is not a regular file: config/payload-rules.mjs",
    },
    {
      name: "a file where a template source folder belongs",
      path: "starters/shared/src",
      plant: "file",
      code: "profile_source_wrong_type",
      message: "recipe folder is not a folder: starters/shared/src",
    },
  ])(
    "refuses $name before any file is copied",
    async ({ path, plant, code, message }) => {
      const template = testFolder("recipe-template-");
      carryOutFolders.push(template);
      await cp(join(ROOT, "src"), join(template, "src"), { recursive: true });
      const durable = selectRecipe({ profile: "durable", monorepo: false });
      if (durable.status !== "selected") throw new Error(durable.message);
      for (const copy of durable.recipe.copies) {
        await cp(join(ROOT, copy.from), join(template, copy.from), {
          recursive: true,
        });
      }
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
          "--profile",
          "durable",
          "--destination",
          destination,
          "--source-packet",
          "/abs/packets/demo",
          "--json",
        ],
        { boundMilliseconds: bootstrapBound, processGroup: true },
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
