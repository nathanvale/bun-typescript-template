import { expect, test } from "bun:test";
import { mkdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { inventoryApplicationClis } from "../../../src/cli-inventory.ts";
import { grown, type Tree } from "../../support/cli-inventory-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const MAIN = 'if (import.meta.main) process.stdout.write("run");\n';

function manifest(value: Record<string, unknown>): string {
  return JSON.stringify(value);
}

async function inventoryOf(tree: Tree): Promise<string[]> {
  const root = testFolder("cli-inventory-application-");
  try {
    grown(root, tree);
    return await inventoryApplicationClis(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

async function failureOf(tree: Tree): Promise<string> {
  const root = testFolder("cli-inventory-failure-");
  try {
    grown(root, tree);
    await inventoryApplicationClis(root);
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("a repository with no files has no application CLI", async () => {
  expect(await inventoryOf({})).toEqual([]);
});

test("a root that does not exist is refused", async () => {
  const root = testFolder("cli-inventory-missing-");
  rmSync(root, { recursive: true, force: true });
  let code: unknown;
  try {
    await inventoryApplicationClis(root);
  } catch (error) {
    code = (error as NodeJS.ErrnoException).code;
  }
  expect(code).toBe("ENOENT");
});

test("a source that runs when started directly is an application CLI", async () => {
  expect(await inventoryOf({ "src/cli.ts": MAIN })).toEqual(["src/cli.ts"]);
});

test("a source that reads the process arguments is an application CLI", async () => {
  expect(
    await inventoryOf({ "src/cli.ts": "export const args = process.argv;\n" }),
  ).toEqual(["src/cli.ts"]);
});

test("a source that does neither is a library, not a CLI", async () => {
  expect(
    await inventoryOf({ "src/lib.ts": "export const value = 1;\n" }),
  ).toEqual([]);
});

test.each(["__cliInventoryMain", "__cliInventoryArgv"])(
  "a library that spells the %s marker with an escape the transpiler decodes is not a CLI",
  async (marker) => {
    const escaped = `\\u005f${marker.slice(1)}`;
    expect(
      await inventoryOf({ "src/lib.ts": `export const s = "${escaped}";\n` }),
    ).toEqual([]);
  },
);

test.each([
  ["a tests folder", "tests/cli.ts"],
  ["a test folder", "test/cli.ts"],
  ["a nested tests folder", "packages/app/tests/cli.ts"],
  ["a fixtures folder", "src/fixtures/cli.ts"],
  ["a proofs folder", "proofs/cli.ts"],
  ["a .test file", "src/cli.test.ts"],
  ["a .spec file", "src/cli.spec.ts"],
  ["a dot-test file", "src/cli.test.mjs"],
])("a source in %s is not an application CLI", async (_where, path) => {
  expect(await inventoryOf({ [path]: MAIN })).toEqual([]);
});

test("a folder that only ends like a test folder still holds application sources", async () => {
  expect(
    await inventoryOf({
      "src/mytests/cli.ts": MAIN,
      "src/latest/main.ts": MAIN,
    }),
  ).toEqual(["src/latest/main.ts", "src/mytests/cli.ts"]);
});

test.each([".ts", ".tsx", ".js", ".mjs", ".mts", ".cts", ".cjs"])(
  "a %s source that runs directly is an application CLI",
  async (extension) => {
    const name = `src/cli${extension}`;
    expect(await inventoryOf({ [name]: MAIN })).toEqual([name]);
  },
);

test.each([".json", ".txt", ".jsx", ".py"])(
  "a %s file is not read as an application source",
  async (extension) => {
    expect(await inventoryOf({ [`src/cli${extension}`]: MAIN })).toEqual([]);
  },
);

test.each([
  "node_modules",
  "dist",
  "coverage",
  ".git",
  ".worktrees",
  ".fallow",
])("a source under %s is not inventoried", async (folder) => {
  expect(await inventoryOf({ [`${folder}/cli.ts`]: MAIN })).toEqual([]);
});

test("a source under any dot folder is not inventoried", async () => {
  expect(
    await inventoryOf({ ".hidden/cli.ts": MAIN, "src/.cache/cli.ts": MAIN }),
  ).toEqual([]);
});

test("a dot file at the top is not inventoried", async () => {
  expect(await inventoryOf({ ".cli.ts": MAIN })).toEqual([]);
});

test("a symbolic link inside a skipped folder is never inspected", async () => {
  const root = testFolder("cli-inventory-skipped-link-");
  try {
    grown(root, { "src/cli.ts": MAIN, "target.ts": "export {};\n" });
    mkdirSync(join(root, "node_modules"));
    symlinkSync(join(root, "target.ts"), join(root, "node_modules/link.ts"));
    expect(await inventoryApplicationClis(root)).toEqual(["src/cli.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a symbolic link in the repository is refused by name", async () => {
  const root = testFolder("cli-inventory-link-");
  try {
    grown(root, { "src/cli.ts": MAIN });
    symlinkSync(join(root, "src/cli.ts"), join(root, "src/alias.ts"));
    expect(
      await inventoryApplicationClis(root).then(
        () => "",
        (error: Error) => error.message,
      ),
    ).toBe("CLI inventory cannot inspect symbolic link: src/alias.ts");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a root reached through a symbolic link lists entries relative to the real root", async () => {
  const root = testFolder("cli-inventory-real-");
  const via = testFolder("cli-inventory-via-");
  try {
    grown(root, {
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
    });
    const link = join(via, "linked");
    symlinkSync(root, link);
    expect(await inventoryApplicationClis(link)).toEqual(["src/cli.ts"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(via, { recursive: true, force: true });
  }
});

test("a manifest bin string names an application CLI", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
    }),
  ).toEqual(["src/cli.ts"]);
});

test("each manifest bin in an object names an application CLI", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        bin: { one: "src/one.ts", two: "src/two.ts", bad: 3 },
      }),
      "src/one.ts": "export {};\n",
      "src/two.ts": "export {};\n",
    }),
  ).toEqual(["src/one.ts", "src/two.ts"]);
});

test("a manifest script that runs a file names an application CLI", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ scripts: { start: "bun run src/app.ts" } }),
      "src/app.ts": "export {};\n",
    }),
  ).toEqual(["src/app.ts"]);
});

test("a manifest script that runs no file names nothing", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        scripts: { start: "bun run serve", other: 3 },
      }),
    }),
  ).toEqual([]);
});

test("a manifest with no bin and no scripts names nothing", async () => {
  expect(await inventoryOf({ "package.json": "{}" })).toEqual([]);
});

test("a package.json that is not an object names nothing", async () => {
  expect(await inventoryOf({ "package.json": "[1]" })).toEqual([]);
});

test("a tooling script is not an application CLI even when it reads its arguments", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        scripts: { build: "bun scripts/build.ts", start: "bun src/cli.ts" },
      }),
      "scripts/build.ts": "export const args = process.argv;\n",
      "src/cli.ts": "export {};\n",
    }),
  ).toEqual(["src/cli.ts"]);
});

test("a tooling script from a nested package excludes its own file", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
      "packages/lib/package.json": manifest({
        scripts: { "build:docs": "bun tools/docs.ts" },
      }),
      "packages/lib/tools/docs.ts": MAIN,
    }),
  ).toEqual(["src/cli.ts"]);
});

test("a nested package bin is listed relative to the repository root", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/cli.ts" }),
      "src/cli.ts": "export {};\n",
      "packages/lib/package.json": manifest({ bin: { lib: "bin/lib.ts" } }),
      "packages/lib/bin/lib.ts": "export {};\n",
    }),
  ).toEqual(["packages/lib/bin/lib.ts", "src/cli.ts"]);
});

test("a manifest bin that leaves the repository is refused by name", async () => {
  expect(
    await failureOf({
      "package.json": manifest({ bin: "../outside.ts" }),
    }),
  ).toBe("CLI entry leaves the repository: ../outside.ts");
});

test("a manifest bin that names a folder is refused by name", async () => {
  expect(
    await failureOf({
      "package.json": manifest({ bin: "src" }),
      "src/cli.ts": "export {};\n",
    }),
  ).toBe("CLI entry is not an ordinary file: src");
});

test("a manifest bin that names a file that does not exist is refused", async () => {
  expect(
    await failureOf({ "package.json": manifest({ bin: "src/gone.ts" }) }),
  ).toContain("ENOENT");
});

test("a package.json that is not valid JSON is refused", async () => {
  expect(await failureOf({ "package.json": "{" })).toContain(
    "JSON Parse error",
  );
});

test("documentation naming a command that runs a file names an application CLI", async () => {
  expect(
    await inventoryOf({
      "README.md": "Run `bun run src/tool.ts`.\n",
      "src/tool.ts": "export {};\n",
    }),
  ).toEqual(["src/tool.ts"]);
});

test("documentation in a nested package resolves from that package", async () => {
  expect(
    await inventoryOf({
      "package.json": "{}",
      "packages/app/package.json": "{}",
      "packages/app/docs/guide.md": "bun run src/tool.ts\n",
      "packages/app/src/tool.ts": "export {};\n",
    }),
  ).toEqual(["packages/app/src/tool.ts"]);
});

test("documentation naming a tooling script does not list it", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ scripts: { check: "bun scripts/check.ts" } }),
      "README.md": "bun run scripts/check.ts\n",
      "scripts/check.ts": "export {};\n",
    }),
  ).toEqual([]);
});

test("only Markdown files are read as documentation", async () => {
  expect(
    await inventoryOf({
      "NOTES.txt": "bun run src/tool.ts\n",
      "src/tool.ts": "export {};\n",
    }),
  ).toEqual([]);
});

test("a file that several routes name is listed once", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({
        bin: "src/cli.ts",
        scripts: { start: "bun src/cli.ts" },
      }),
      "README.md": "bun run src/cli.ts\n",
      "src/cli.ts": MAIN,
    }),
  ).toEqual(["src/cli.ts"]);
});

test("entries from every route come back in sorted order", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ bin: "src/b.ts" }),
      "README.md": "bun run src/c.ts\n",
      "src/a.ts": MAIN,
      "src/b.ts": "export {};\n",
      "src/c.ts": "export {};\n",
      "src/d.ts": MAIN,
    }),
  ).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/d.ts"]);
});

test("an executable source that another source imports is still listed", async () => {
  expect(
    await inventoryOf({
      "src/cli.ts": 'import "./second.ts";\n',
      "src/second.ts": MAIN,
    }),
  ).toEqual(["src/second.ts"]);
});

test("a helper that only reads the process arguments for an imported tool is not listed", async () => {
  expect(
    await inventoryOf({
      "package.json": manifest({ scripts: { build: "bun scripts/build.ts" } }),
      "scripts/build.ts": 'import "./options.ts";\n',
      "scripts/options.ts": "export const args = process.argv;\n",
    }),
  ).toEqual([]);
});

test("a repository with two application CLIs lists both", async () => {
  expect(await inventoryOf({ "src/one.ts": MAIN, "src/two.ts": MAIN })).toEqual(
    ["src/one.ts", "src/two.ts"],
  );
});

test(
  "an entry that is neither a file nor a folder is not inventoried",
  async () => {
    const root = testFolder("cli-inventory-pipe-");
    try {
      grown(root, { "src/cli.ts": MAIN });
      const made = await spawnBounded(["mkfifo", join(root, "src/pipe.ts")]);
      expect(made.exit).toBe(0);
      expect(await inventoryApplicationClis(root)).toEqual(["src/cli.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
  processWatchdog(1),
);
