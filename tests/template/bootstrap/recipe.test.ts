import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
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
  return (["scratch", "durable"] as const).flatMap((profile) =>
    [false, true].flatMap((monorepo) =>
      ([undefined, "simple", "complex"] as const).map((starter) =>
        starter === undefined
          ? { profile, monorepo }
          : { profile, monorepo, starter },
      ),
    ),
  );
}

function selectionKey(selection: Selection): string {
  return [
    selection.profile,
    selection.monorepo ? "--monorepo" : undefined,
    selection.starter,
  ]
    .filter((word) => word !== undefined)
    .join(" ");
}

function rowKey(recipe: ProjectRecipe): string {
  const { profile, layout, starter } = recipe.request;
  return [profile, layout, starter]
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

async function copiedFiles(recipe: ProjectRecipe): Promise<string[]> {
  const files: string[] = [];
  for (const copy of recipe.copies) {
    const source = join(ROOT, copy.from);
    for (const entry of await readdir(source, { withFileTypes: true })) {
      if (UNCOPIED_NAMES.includes(entry.name)) continue;
      if (copy.only !== undefined && !copy.only.includes(entry.name)) continue;
      const targets = entry.isDirectory()
        ? (await filesUnder(source, entry.name)).map((path) =>
            join(copy.into, path),
          )
        : [join(copy.into, entry.name)];
      files.push(...targets);
    }
  }
  return files;
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
    const rows = RECIPES.map(rowKey);
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
    const ruleFiles = [
      "config/anti-slop-bindings.mjs",
      "config/anti-slop-rules.mjs",
      "config/anti-slop-type-rules.mjs",
      "config/payload-rules.mjs",
      "config/platform-rules.mjs",
      "config/template-rules.mjs",
    ];
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
    ["folder", "starters/shared/src", "starters/shared/src"],
    ["file", "tests/support/test-folder.ts", "tests/support"],
  ])(
    "refuses a missing template source %s before any file is copied",
    async (kind, missing, folder) => {
      const template = testFolder("recipe-template-");
      carryOutFolders.push(template);
      await mkdir(join(template, "src"));
      for (const file of ["bootstrap.ts", "recipe.ts"]) {
        await cp(join(ROOT, "src", file), join(template, "src", file));
      }
      const durable = selectRecipe({ profile: "durable", monorepo: false });
      if (durable.status !== "selected") throw new Error(durable.message);
      for (const copy of durable.recipe.copies) {
        if (copy.from === missing) continue;
        await cp(join(ROOT, copy.from), join(template, copy.from), {
          recursive: true,
        });
      }
      expect(existsSync(join(template, folder))).toBe(kind === "file");
      if (kind === "file") await rm(join(template, missing));
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
            code: "profile_source_missing",
            message: `recipe ${kind} is missing: ${missing}`,
            repair: `run git restore ${missing} in the template repository`,
            retrySafe: false,
          },
        },
      });
      expect(existsSync(parent)).toBe(false);
    },
    bootstrapTestTimeout,
  );
});
