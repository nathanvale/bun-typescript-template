import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { RECIPES } from "../../src/recipe.ts";
import { installedPackage } from "../../src/static-admission.ts";

type Ranges = Record<string, string>;
export type PackageJson = {
  name: string;
  packageManager: string;
  workspaces: unknown;
  catalog: Record<string, string>;
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  optionalDependencies: Record<string, string>;
  peerDependencies: Record<string, string>;
  peerDependenciesMeta: Record<string, { optional?: boolean }>;
  overrides: Record<string, string>;
};
export type LockFile = {
  workspaces: Record<string, Partial<PackageJson>>;
  catalog: Record<string, string>;
  overrides: Record<string, Record<string, string>>;
  packages: Record<string, unknown[]>;
};
type Listed = [file: string, packageJson: PackageJson];
type Template = { packageJson: PackageJson; versions: Map<string, string> };
type Entry = {
  place: string;
  name: string;
  given: string;
  range: string | undefined;
};
type VersionedEntry = Entry & { range: string };

const SELF = "tests/support/generated-toolchain.ts";
const EXACT_VERSION =
  /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;
const GROUPS = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
] as const;
const NO_PACKAGE_JSON: PackageJson = {
  name: "",
  packageManager: "",
  workspaces: [],
  catalog: {},
  dependencies: {},
  devDependencies: {},
  optionalDependencies: {},
  peerDependencies: {},
  peerDependenciesMeta: {},
  overrides: {},
};
const NO_LOCK: LockFile = {
  workspaces: {},
  catalog: {},
  overrides: {},
  packages: {},
};

function own<T>(record: Record<string, T>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

async function json(path: string): Promise<object> {
  return Bun.JSONC.parse(await Bun.file(path).text()) as object;
}

async function readPackageJson(path: string): Promise<PackageJson> {
  return { ...NO_PACKAGE_JSON, ...(await json(path)) };
}

function split(target: string): [string, string] {
  const at = target.lastIndexOf("@");
  return at < 0 ? [target, ""] : [target.slice(0, at), target.slice(at + 1)];
}

function overriddenPackage(selector: string): string {
  const at = selector.indexOf("@", 1);
  return at < 0 ? selector : selector.slice(0, at);
}

function relock(folder: string): string {
  return `Repair: run bun install --lockfile-only in a copy of ${folder} and copy its bun.lock back.`;
}

function entries(packageJson: PackageJson, catalog: Ranges): Entry[] {
  return [...GROUPS, "catalog" as const].flatMap((group) =>
    Object.entries(packageJson[group]).map(([name, given]) => ({
      place: `${group}.${name}`,
      name,
      given,
      range: given === "catalog:" ? own(catalog, name) : given,
    })),
  );
}

function comparable(entry: Entry): entry is VersionedEntry {
  const { name, range } = entry;
  if (range === undefined || (range.includes(":") && !range.startsWith("npm:")))
    return false;
  const [, version] = split(installedPackage(name, range));
  return EXACT_VERSION.test(version);
}

function optionalPeer(packageJson: PackageJson, place: string, name: string) {
  return (
    place.startsWith("peerDependencies.") &&
    own(packageJson.peerDependenciesMeta, name)?.optional === true
  );
}

function versioned(packageJson: PackageJson, catalog: Ranges) {
  return entries(packageJson, catalog).filter(comparable);
}

export function recipeFolders(tree: string): string[] {
  const folders = RECIPES.flatMap(({ copies }) =>
    copies.filter(({ into }) => into === ".").map(({ from }) => from),
  );
  return [...new Set(folders)].filter((folder) =>
    existsSync(join(tree, folder, "package.json")),
  );
}

function memberPatterns(workspaces: unknown): string[] | undefined {
  return Array.isArray(workspaces) &&
    workspaces.every(
      (pattern) => typeof pattern === "string" && !pattern.startsWith("!"),
    )
    ? workspaces
    : undefined;
}

async function packagesIn(folder: string, patterns: string[]) {
  const members = await Promise.all(
    patterns.map((pattern) =>
      Array.fromAsync(new Bun.Glob(`${pattern}/package.json`).scan(folder)),
    ),
  );
  return await Promise.all(
    members
      .flat()
      .sort()
      .map(
        async (file): Promise<Listed> => [
          file,
          await readPackageJson(join(folder, file)),
        ],
      ),
  );
}

function versionProblems(
  folder: string,
  [file, packageJson]: Listed,
  catalog: Ranges,
  template: Template,
): string[] {
  const where = `${folder}/${file}`;
  const drift = versioned(packageJson, {}).flatMap(({ place, name, range }) => {
    const [installed, version] = split(installedPackage(name, range));
    const accepted = template.versions.get(installed);
    return accepted === undefined || accepted === version
      ? []
      : [
          `${where} ${place} installs ${installed}@${version}, and the template's package.json has ${installed}@${accepted}. Repair: make it install ${installed}@${accepted}, then regenerate ${folder}/bun.lock.`,
        ];
  });
  const unread = entries(packageJson, catalog)
    .filter(
      (entry) => !comparable(entry) && !entry.given.startsWith("workspace:"),
    )
    .map(
      ({ place, given }) =>
        `${where} ${place} is ${given}, which this test cannot compare with the template's version: it reads an exact version, an npm: alias to one, or an entry of the default catalog. Repair: use one of those, or teach ${SELF} to read it.`,
    );
  return [...drift, ...unread];
}

function overrideProblems(
  folder: string,
  top: PackageJson,
  lock: LockFile,
  template: Template,
): string[] {
  const where = `${folder}/package.json`;
  const wanted = template.packageJson.overrides;
  const declared = Object.entries(top.overrides)
    .filter(([selector, range]) => own(wanted, selector) !== range)
    .map(
      ([selector, range]) =>
        `${where} overrides.${selector} is ${range}, and the template's package.json has ${String(own(wanted, selector))}. Repair: copy the template's override.`,
    );
  const installed = Object.keys(lock.packages);
  const missing = Object.entries(wanted)
    .filter(([selector]) => own(top.overrides, selector) === undefined)
    .map(([selector, range]) => ({
      selector,
      range,
      name: overriddenPackage(selector),
    }))
    .filter(({ name }) =>
      installed.some((key) => key === name || key.endsWith(`/${name}`)),
    )
    .map(
      ({ selector, range, name }) =>
        `${where} has no override ${selector}, and ${folder}/bun.lock installs ${name}. Repair: add "${selector}": "${range}" to its overrides, then regenerate ${folder}/bun.lock.`,
    );
  return [...declared, ...missing];
}

function workspaceLockProblems(
  folder: string,
  lock: LockFile,
  [file, packageJson]: Listed,
  catalog: Ranges,
): string[] {
  const record =
    own(lock.workspaces, file === "package.json" ? "" : dirname(file)) ?? {};
  const records = GROUPS.filter(
    (group) => !Bun.deepEquals(record[group] ?? {}, packageJson[group]),
  ).map(
    (group) =>
      `${folder}/bun.lock records other ${group} for ${file}. ${relock(folder)}`,
  );
  const resolutions = versioned(
    { ...packageJson, catalog: {} },
    catalog,
  ).flatMap(({ place, name, range }) => {
    const wanted = installedPackage(name, range);
    const entry =
      own(lock.packages, `${packageJson.name}/${name}`) ??
      own(lock.packages, name);
    return entry?.[0] === wanted ||
      (entry === undefined && optionalPeer(packageJson, place, name))
      ? []
      : [
          `${folder}/bun.lock resolves ${file} ${place} to ${String(entry?.[0])}, not ${wanted}. ${relock(folder)}`,
        ];
  });
  return [...records, ...resolutions];
}

function lockProblems(
  folder: string,
  lock: LockFile,
  top: PackageJson,
  listed: Listed[],
): string[] {
  const overrides = Object.fromEntries(
    Object.entries(top.overrides).map(([key, range]) => [key, { ".": range }]),
  );
  const overridden = Object.entries(top.overrides).flatMap(
    ([selector, range]) => {
      const name = overriddenPackage(selector);
      const wanted = installedPackage(name, range);
      return Object.entries(lock.packages)
        .filter(([key]) => key === name || key.endsWith(`/${name}`))
        .flatMap(([key, entry]) =>
          entry[0] === wanted
            ? []
            : [
                `${folder}/bun.lock resolves ${key} to ${String(entry[0])}, and overrides.${selector} installs ${wanted}. ${relock(folder)}`,
              ],
        );
    },
  );
  return [
    ...(Bun.deepEquals(lock.catalog, top.catalog)
      ? []
      : [`${folder}/bun.lock records another catalog. ${relock(folder)}`]),
    ...(Bun.deepEquals(lock.overrides, overrides)
      ? []
      : [`${folder}/bun.lock records other overrides. ${relock(folder)}`]),
    ...overridden,
    ...listed.flatMap((entry) =>
      workspaceLockProblems(folder, lock, entry, top.catalog),
    ),
  ];
}

async function folderProblems(
  tree: string,
  folder: string,
  template: Template,
): Promise<string[]> {
  const top = await readPackageJson(join(tree, folder, "package.json"));
  const patterns = memberPatterns(top.workspaces);
  const listed: Listed[] = [
    ["package.json", top],
    ...(await packagesIn(join(tree, folder), patterns ?? [])),
  ];
  const lockPath = join(tree, folder, "bun.lock");
  const lock = existsSync(lockPath)
    ? { ...NO_LOCK, ...(await json(lockPath)) }
    : undefined;
  const bun = template.packageJson.packageManager;
  return [
    ...(top.packageManager === bun
      ? []
      : [
          `${folder}/package.json has packageManager ${top.packageManager}, and the template's package.json has ${bun}. Repair: set it to ${bun}.`,
        ]),
    ...(patterns
      ? []
      : [
          `${folder}/package.json workspaces is not a plain list of member folders (an object, or an exclusion starting with !), the only form this test reads. Repair: list member folders in workspaces, or teach ${SELF} to read it.`,
        ]),
    ...listed.flatMap((entry) =>
      versionProblems(folder, entry, top.catalog, template),
    ),
    ...overrideProblems(folder, top, lock ?? NO_LOCK, template),
    ...(lock
      ? lockProblems(folder, lock, top, listed)
      : [`${folder} has no bun.lock. ${relock(folder)}`]),
  ];
}

export async function toolchainProblems(
  tree: string,
  folders: readonly string[],
): Promise<string[]> {
  const packageJson = await readPackageJson(join(tree, "package.json"));
  const versions = new Map(
    versioned(packageJson, {}).map(({ name, range }) =>
      split(installedPackage(name, range)),
    ),
  );
  const problems = await Promise.all(
    folders.map((folder) =>
      folderProblems(tree, folder, { packageJson, versions }),
    ),
  );
  return problems.flat();
}
