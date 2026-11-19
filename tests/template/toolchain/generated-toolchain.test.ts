import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { RECIPES } from "../../../src/recipe.ts";
import { installedPackage } from "../../../src/static-admission.ts";
import { testFolder } from "../../support/test-folder.ts";

const root = join(import.meta.dir, "../../..");
const fixtures: string[] = [];

afterAll(() => {
  for (const fixture of fixtures) rmSync(fixture, { recursive: true });
});

type Ranges = Record<string, string>;
type Manifest = {
  name: string;
  packageManager: string;
  workspaces: string[];
  catalog: Ranges;
  dependencies: Ranges;
  devDependencies: Ranges;
  overrides: Ranges;
};
type Lock = {
  workspaces: Record<string, Partial<Manifest>>;
  catalog: Ranges;
  overrides: Record<string, Ranges>;
  packages: Record<string, unknown[]>;
};
type Listed = [file: string, manifest: Manifest];
type Toolchain = { manifest: Manifest; versions: Map<string, string> };
type Declaration = { place: string; name: string; range: string };

const GROUPS = ["dependencies", "devDependencies"] as const;
const NO_MANIFEST: Manifest = {
  name: "",
  packageManager: "",
  workspaces: [],
  catalog: {},
  dependencies: {},
  devDependencies: {},
  overrides: {},
};
const NO_LOCK: Lock = {
  workspaces: {},
  catalog: {},
  overrides: {},
  packages: {},
};

async function json(path: string): Promise<object> {
  return Bun.JSONC.parse(await Bun.file(path).text()) as object;
}

async function readManifest(path: string): Promise<Manifest> {
  return { ...NO_MANIFEST, ...(await json(path)) };
}

function split(target: string): [string, string] {
  const at = target.lastIndexOf("@");
  return [target.slice(0, at), target.slice(at + 1)];
}

function versioned(range: string | undefined): range is string {
  return (
    range !== undefined && (!range.includes(":") || range.startsWith("npm:"))
  );
}

function declared(manifest: Manifest, catalog: Ranges): Declaration[] {
  return [...GROUPS, "catalog" as const].flatMap((group) =>
    Object.entries(manifest[group]).flatMap(([name, given]) => {
      const range = given === "catalog:" ? catalog[name] : given;
      return versioned(range)
        ? [{ place: `${group}.${name}`, name, range }]
        : [];
    }),
  );
}

function relock(folder: string): string {
  return `Repair: run bun install --lockfile-only in a copy of ${folder} and copy its bun.lock back.`;
}

function recipeFolders(tree: string): string[] {
  const folders = RECIPES.flatMap(({ copies }) =>
    copies.filter(({ into }) => into === ".").map(({ from }) => from),
  );
  return [...new Set(folders)].filter((folder) =>
    existsSync(join(tree, folder, "package.json")),
  );
}

async function manifestsIn(folder: string): Promise<[Manifest, Listed[]]> {
  const top = await readManifest(join(folder, "package.json"));
  const members = await Promise.all(
    top.workspaces.map((pattern) =>
      Array.fromAsync(new Bun.Glob(`${pattern}/package.json`).scan(folder)),
    ),
  );
  const listed = await Promise.all(
    members
      .flat()
      .sort()
      .map(
        async (file): Promise<Listed> => [
          file,
          await readManifest(join(folder, file)),
        ],
      ),
  );
  return [top, [["package.json", top], ...listed]];
}

function versionProblems(
  where: string,
  manifest: Manifest,
  toolchain: Toolchain,
  folder: string,
): string[] {
  const drift = declared(manifest, {}).flatMap(({ place, name, range }) => {
    const [installed, version] = split(installedPackage(name, range));
    const accepted = toolchain.versions.get(installed);
    return accepted === undefined || accepted === version
      ? []
      : [
          `${where} ${place} installs ${installed}@${version}, and the template's package.json has ${installed}@${accepted}. Repair: make it install ${installed}@${accepted}, then regenerate ${folder}/bun.lock.`,
        ];
  });
  const overrides = Object.entries(manifest.overrides)
    .filter(
      ([selector, range]) => toolchain.manifest.overrides[selector] !== range,
    )
    .map(
      ([selector, range]) =>
        `${where} overrides.${selector} is ${range}, and the template's package.json has ${String(toolchain.manifest.overrides[selector])}. Repair: copy the template's override.`,
    );
  return [...drift, ...overrides];
}

function workspaceLockProblems(
  folder: string,
  lock: Lock,
  [file, manifest]: Listed,
  catalog: Ranges,
): string[] {
  const record =
    lock.workspaces[file === "package.json" ? "" : dirname(file)] ?? {};
  const records = GROUPS.filter(
    (group) => !Bun.deepEquals(record[group] ?? {}, manifest[group]),
  ).map(
    (group) =>
      `${folder}/bun.lock records other ${group} for ${file}. ${relock(folder)}`,
  );
  const resolutions = declared({ ...manifest, catalog: {} }, catalog).flatMap(
    ({ place, name, range }) => {
      const wanted = installedPackage(name, range);
      const entry =
        lock.packages[`${manifest.name}/${name}`] ?? lock.packages[name];
      return entry?.[0] === wanted
        ? []
        : [
            `${folder}/bun.lock resolves ${file} ${place} to ${String(entry?.[0])}, not ${wanted}. ${relock(folder)}`,
          ];
    },
  );
  return [...records, ...resolutions];
}

function lockProblems(
  folder: string,
  lock: Lock,
  top: Manifest,
  listed: Listed[],
): string[] {
  const overrides = Object.fromEntries(
    Object.entries(top.overrides).map(([key, range]) => [key, { ".": range }]),
  );
  return [
    ...(Bun.deepEquals(lock.catalog, top.catalog)
      ? []
      : [`${folder}/bun.lock records another catalog. ${relock(folder)}`]),
    ...(Bun.deepEquals(lock.overrides, overrides)
      ? []
      : [`${folder}/bun.lock records other overrides. ${relock(folder)}`]),
    ...listed.flatMap((entry) =>
      workspaceLockProblems(folder, lock, entry, top.catalog),
    ),
  ];
}

async function folderProblems(
  tree: string,
  folder: string,
  toolchain: Toolchain,
): Promise<string[]> {
  const [top, listed] = await manifestsIn(join(tree, folder));
  const expected = toolchain.manifest.packageManager;
  const lock = join(tree, folder, "bun.lock");
  return [
    ...(top.packageManager === expected
      ? []
      : [
          `${folder}/package.json has packageManager ${top.packageManager}, and the template's package.json has ${expected}. Repair: set it to ${expected}.`,
        ]),
    ...listed.flatMap(([file, manifest]) =>
      versionProblems(`${folder}/${file}`, manifest, toolchain, folder),
    ),
    ...(existsSync(lock)
      ? lockProblems(folder, { ...NO_LOCK, ...(await json(lock)) }, top, listed)
      : [`${folder} has no bun.lock. ${relock(folder)}`]),
  ];
}

async function toolchainProblems(
  tree: string,
  folders: readonly string[],
): Promise<string[]> {
  const manifest = await readManifest(join(tree, "package.json"));
  const versions = new Map(
    declared(manifest, {}).map(({ name, range }) =>
      split(installedPackage(name, range)),
    ),
  );
  const problems = await Promise.all(
    folders.map((folder) =>
      folderProblems(tree, folder, { manifest, versions }),
    ),
  );
  return problems.flat();
}

const TEMPLATE: Partial<Manifest> = {
  packageManager: "bun@1.4.4",
  devDependencies: {
    "@types/bun": "1.4.4",
    typescript: "npm:@typescript/typescript6@6.0.2",
    "@typescript/native": "npm:typescript@7.1.0-beta",
  },
  overrides: { "@typescript/old@npm:typescript@^6": "npm:typescript@6.0.2" },
};

function lockOf(manifest: Partial<Manifest>, packages: Ranges): Partial<Lock> {
  return {
    workspaces: { "": manifest },
    ...(manifest.catalog ? { catalog: manifest.catalog } : {}),
    overrides: Object.fromEntries(
      Object.entries(manifest.overrides ?? {}).map(([key, range]) => [
        key,
        { ".": range },
      ]),
    ),
    packages: Object.fromEntries(
      Object.entries(packages).map(([name, target]) => [name, [target]]),
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

const LATEST: Partial<Manifest> = {
  packageManager: "bun@1.4.4",
  devDependencies: { "@types/bun": "1.4.4", typescript: "7.1.0-beta" },
};
const LATEST_PACKAGES = {
  "@types/bun": "@types/bun@1.4.4",
  typescript: "typescript@7.1.0-beta",
};

test("every recipe folder that ships a package.json installs the template's toolchain, and its bun.lock agrees", async () => {
  expect(await toolchainProblems(root, recipeFolders(root))).toEqual([]);
});

test("every recipe copies a package.json from a folder the check reads", () => {
  const checked = new Set(recipeFolders(root));
  for (const { request, copies } of RECIPES)
    expect({
      request,
      checked: copies.some(({ from }) => checked.has(from)),
    }).toEqual({ request, checked: true });
});

test("a recipe folder on the template's toolchain, with a package the template lacks, passes", async () => {
  const manifest = { ...LATEST, dependencies: { zod: "4.4.3" } };
  const tree = treeWith({
    "recipe/package.json": manifest,
    "recipe/bun.lock": lockOf(manifest, {
      ...LATEST_PACKAGES,
      zod: "zod@4.4.3",
    }),
  });
  expect(await toolchainProblems(tree, ["recipe"])).toEqual([]);
});

test.each<[string, Partial<Manifest>, string]>([
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
    {
      ...LATEST,
      catalog: { typescript: "npm:typescript@7.0.2" },
      devDependencies: { "@types/bun": "1.4.4" },
    },
    "recipe/package.json catalog.typescript installs typescript@7.0.2, and the template's package.json has typescript@7.1.0-beta. Repair: make it install typescript@7.1.0-beta, then regenerate recipe/bun.lock.",
  ],
  [
    "another override",
    {
      ...LATEST,
      overrides: {
        "@typescript/old@npm:typescript@^6": "npm:typescript@6.0.1",
      },
    },
    "recipe/package.json overrides.@typescript/old@npm:typescript@^6 is npm:typescript@6.0.1, and the template's package.json has npm:typescript@6.0.2. Repair: copy the template's override.",
  ],
  [
    "another Bun",
    { ...LATEST, packageManager: "bun@1.4.3" },
    "recipe/package.json has packageManager bun@1.4.3, and the template's package.json has bun@1.4.4. Repair: set it to bun@1.4.4.",
  ],
])(
  "%s fails, naming the file and the template's version",
  async (_fault, manifest, message) => {
    const tree = treeWith({
      "recipe/package.json": manifest,
      "recipe/bun.lock": lockOf(manifest, {
        "@types/bun": "@types/bun@1.4.4",
        typescript: installedPackage(
          "typescript",
          manifest.devDependencies?.typescript ?? "7.1.0-beta",
        ),
      }),
    });
    expect(await toolchainProblems(tree, ["recipe"])).toEqual([message]);
  },
);

test("a bun.lock that was not regenerated after a package.json change fails, naming the lock", async () => {
  const older = {
    ...LATEST,
    devDependencies: { "@types/bun": "1.4.0", typescript: "7.1.0-beta" },
  };
  const tree = treeWith({
    "recipe/package.json": LATEST,
    "recipe/bun.lock": lockOf(older, {
      "@types/bun": "@types/bun@1.4.0",
      typescript: "typescript@7.1.0-beta",
    }),
  });
  const repair =
    "Repair: run bun install --lockfile-only in a copy of recipe and copy its bun.lock back.";
  expect(await toolchainProblems(tree, ["recipe"])).toEqual([
    `recipe/bun.lock records other devDependencies for package.json. ${repair}`,
    `recipe/bun.lock resolves package.json devDependencies.@types/bun to @types/bun@1.4.0, not @types/bun@1.4.4. ${repair}`,
  ]);
});
