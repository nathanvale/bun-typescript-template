import { readFileSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Addon,
  Kernel,
  Requirements,
  StampRoot,
} from "./kernel-reader.ts";
import {
  mergeRequirements,
  requirementConflict,
} from "./merged-requirements.ts";
import { blobIdentity, stampRecordPath } from "./stamp-check.ts";
import type { RenderedStaging } from "./token-substitution.ts";

// Interface: where a generated repository keeps its stamp checker and its
// lockfile, and where the template keeps one committed lockfile for each
// package set.
export const stampCheckerPath = "stamp-checker.ts";
export const lockfilePath = "bun.lock";
export const committedLockfiles = "generated-repository/lockfiles";

// Interface: who owns the kernel's own stamp roots in a stamp record, and the
// package set of a selection that merges no add-on's package. An add-on may
// not take the name.
const kernelOwner = "base";
const plainName = /^[a-z][a-z0-9-]*$/;

export type StampRefusalCode =
  | "addon_unknown"
  | "addon_name_unsupported"
  | "addon_requirement_missing"
  | "addon_requirements_disagree"
  | "lockfile_missing"
  | "stamp_conflict";

const repairs: { readonly [Code in StampRefusalCode]: string } = {
  addon_unknown: "Select only add-ons that commit declares.",
  addon_name_unsupported:
    "Rename the add-on in the kernel repository, then give the commit that holds the change.",
  addon_requirement_missing:
    "Add the add-on it requires to the add-on selection.",
  addon_requirements_disagree:
    "Make the kernel declaration require one version of that package, then give the commit that holds the change.",
  lockfile_missing:
    "Put the lockfile for that package set at that path in the template, or supply the lockfile's bytes.",
  stamp_conflict:
    "Remove it from the template's own files for a generated repository. Bootstrap alone supplies stamped source, its requirements, the stamp checker, the stamp record and the lockfile.",
};

export class StampRefusal extends Error {
  readonly repair: string;
  constructor(
    readonly code: StampRefusalCode,
    cause: string,
  ) {
    super(`${cause} Repair: ${repairs[code]}`);
    this.repair = repairs[code];
  }
}

const selected: unique symbol = Symbol("add-on selection");

// Interface: a checked add-on selection. Only `selectAddons` makes one,
// because the key that marks it is not exported. Each add-on in it is
// declared at the kernel's commit, and each add-on one of them requires is in
// it too. `packageSet` names the packages the selection merges: the add-ons
// that declare a package, joined by "+", or "base" when none does.
export type AddonSelection = {
  readonly addons: readonly Addon[];
  readonly packageSet: string;
  readonly [selected]: true;
};

function byName(one: Addon, other: Addon): number {
  return Buffer.compare(Buffer.from(one.name), Buffer.from(other.name));
}

type Owner = Requirements & { readonly name: string };

// Interface: what a kernel and the add-ons selected with it need merged, each
// package and dead-code entry once. It refuses a package two of them require
// at different versions.
function requirementsOf(
  kernel: Kernel,
  addons: readonly Addon[],
): Requirements {
  const owners: readonly Owner[] = [
    { ...kernel, name: "the kernel" },
    ...addons.map((addon) => ({ ...addon, name: `add-on "${addon.name}"` })),
  ];
  const packages = new Map<string, { version: string; owner: string }>();
  for (const { name: owner, packages: required } of owners)
    for (const [name, version] of Object.entries(required)) {
      const first = packages.get(name) ?? { version, owner };
      if (first.version !== version)
        throw new StampRefusal(
          "addon_requirements_disagree",
          `Kernel commit ${kernel.commit} requires package "${name}" at "${first.version}" for ${first.owner} and at "${version}" for ${owner}.`,
        );
      packages.set(name, first);
    }
  return {
    packages: Object.fromEntries(
      [...packages].map(([name, { version }]) => [name, version]),
    ),
    deadCodeEntries: [
      ...new Set(owners.flatMap(({ deadCodeEntries }) => deadCodeEntries)),
    ],
  };
}

// Interface: checks the named add-ons against one kernel commit, in memory.
// It refuses a name the kernel declaration does not hold, listing the names
// it does hold; an add-on whose name a lockfile path or a stamp record cannot
// hold; an add-on whose required add-on is not named; and requirements that
// disagree. It never adds a required add-on itself: the names given are the
// selection the stamp record shows.
export function selectAddons(
  kernel: Kernel,
  names: readonly string[],
): AddonSelection {
  const declared = kernel.addons.toSorted(byName);
  const unknown = names.find(
    (name) => !declared.some((addon) => addon.name === name),
  );
  if (unknown !== undefined)
    throw new StampRefusal(
      "addon_unknown",
      `"${unknown}" is not an add-on at kernel commit ${kernel.commit}. ${
        declared.length === 0
          ? "That commit declares no add-on."
          : `The add-ons there are ${declared.map(({ name }) => name).join(", ")}.`
      }`,
    );
  const addons = declared.filter(({ name }) => names.includes(name));
  const unsupported = addons.find(
    ({ name }) => !plainName.test(name) || name === kernelOwner,
  );
  if (unsupported !== undefined)
    throw new StampRefusal(
      "addon_name_unsupported",
      `Add-on name ${JSON.stringify(unsupported.name)} at kernel commit ${kernel.commit} is not one a stamp record and a lockfile path can hold: a name is lowercase letters, digits and hyphens, starts with a letter, and is not "${kernelOwner}".`,
    );
  for (const { name, requires } of addons) {
    const missing = requires.find((required) => !names.includes(required));
    if (missing !== undefined)
      throw new StampRefusal(
        "addon_requirement_missing",
        `Add-on "${name}" requires "${missing}", which is not selected.`,
      );
  }
  requirementsOf(kernel, addons);
  const withPackages = addons
    .filter(({ packages }) => Object.keys(packages).length > 0)
    .map(({ name }) => name);
  return Object.freeze({
    addons: Object.freeze(addons),
    packageSet:
      withPackages.length === 0 ? kernelOwner : withPackages.join("+"),
    [selected]: true as const,
  });
}

export type LockfileInput =
  | { readonly source: "committed" }
  | { readonly source: "supplied"; readonly bytes: Uint8Array }
  | { readonly source: "none" };

// Interface: the bytes of the lockfile a generated repository gets, or
// undefined when it gets none. Committed is the template's own lockfile for
// the selection's package set, under `templateRoot`, and is refused when the
// template does not hold it. Supplied is the caller's bytes as they are.
export function lockfileFor(
  input: LockfileInput,
  selection: AddonSelection,
  templateRoot: string,
): Uint8Array | undefined {
  if (input.source === "none") return undefined;
  if (input.source === "supplied") return input.bytes;
  const path = `${committedLockfiles}/${selection.packageSet}.lock`;
  try {
    return readFileSync(join(templateRoot, path));
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ENOENT") throw error;
    throw new StampRefusal(
      "lockfile_missing",
      `The template holds no committed lockfile for package set ${selection.packageSet}: ${path} is not there.`,
    );
  }
}

type Owned = { readonly owner: string; readonly root: StampRoot };

function stampedRoots(kernel: Kernel, selection: AddonSelection): Owned[] {
  return [
    ...kernel.roots.map((root) => ({ owner: kernelOwner, root })),
    ...selection.addons.map(({ name, root }) => ({ owner: name, root })),
  ];
}

async function entryAt(folder: string, path: string) {
  try {
    return await lstat(join(folder, path));
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ENOENT") return undefined;
    throw error;
  }
}

const ownFiles = "the generated repository's own files";

// Interface: why a stamp root cannot be written as new, or undefined. Each
// folder on the way to it must be absent or a folder itself, and the stamp
// root must be absent.
async function rootConflict(folder: string, root: string) {
  const parts = root.split("/");
  for (const depth of parts.keys()) {
    const path = parts.slice(0, depth + 1).join("/");
    const found = await entryAt(folder, path);
    if (found === undefined) return undefined;
    if (path === root) return `Stamp root "${root}" is already in ${ownFiles}.`;
    if (!found.isDirectory())
      return `${path} is in ${ownFiles} and is not a folder, and stamp root "${root}" needs it to be one.`;
  }
  return undefined;
}

async function heldConflict(folder: string, path: string) {
  return (await entryAt(folder, path)) === undefined
    ? undefined
    : `${path} is already in ${ownFiles}.`;
}

async function conflictIn(
  folder: string,
  roots: readonly Owned[],
  required: Requirements,
): Promise<string | undefined> {
  for (const { root } of roots) {
    const conflict = await rootConflict(folder, root.path);
    if (conflict !== undefined) return conflict;
  }
  for (const path of [stampCheckerPath, stampRecordPath]) {
    const conflict = await heldConflict(folder, path);
    if (conflict !== undefined) return conflict;
  }
  return requirementConflict(folder, required);
}

// Interface: places the lockfile's bytes as they are, in a staging folder
// that token substitution has already rendered, so nothing rewrites them. It
// refuses a lockfile the folder already holds as a stamp conflict.
export async function placeLockfile(
  staging: RenderedStaging,
  bytes: Uint8Array,
): Promise<void> {
  const conflict = await heldConflict(staging.path, lockfilePath);
  if (conflict !== undefined)
    throw new StampRefusal("stamp_conflict", conflict);
  await writeFile(join(staging.path, lockfilePath), bytes, { flag: "wx" });
}

async function writeNew(
  folder: string,
  path: string,
  bytes: Uint8Array | string,
  mode: string,
): Promise<void> {
  const target = join(folder, path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, bytes, { flag: "wx" });
  if (mode === "100755") await chmod(target, 0o755);
}

export type StampOrigin = {
  readonly kernelRepository: string;
  readonly stampCheckSource: string;
};

// Interface: stamps one kernel commit and a checked add-on selection into a
// staging folder that token substitution has already rendered. It writes
// every file of the kernel's stamp roots and of each selected add-on's stamp
// root byte for byte, then the stamp checker, then the merged requirements,
// and the stamp record last. It runs no git. It refuses a stamp conflict
// before it writes anything: a stamp root, the stamp checker, the stamp
// record, a package or a dead-code entry the folder already holds. Returns
// how many files it created.
export async function stampKernel(
  staging: RenderedStaging,
  kernel: Kernel,
  selection: AddonSelection,
  origin: StampOrigin,
): Promise<number> {
  const folder = staging.path;
  const roots = stampedRoots(kernel, selection);
  const required = requirementsOf(kernel, selection.addons);
  const conflict = await conflictIn(folder, roots, required);
  if (conflict !== undefined)
    throw new StampRefusal("stamp_conflict", conflict);
  const files = roots
    .flatMap(({ root }) => root.files)
    .toSorted((one, other) =>
      Buffer.compare(Buffer.from(one.path), Buffer.from(other.path)),
    );
  for (const { path, bytes, mode } of files)
    await writeNew(folder, path, bytes, mode);
  const stampChecker = await readFile(origin.stampCheckSource);
  await writeNew(folder, stampCheckerPath, stampChecker, "100644");
  const merged = await mergeRequirements(folder, required);
  const record = {
    schemaVersion: 1,
    kernel: {
      repository: origin.kernelRepository,
      commit: kernel.commit,
      objectFormat: "sha1",
      sourceRoot: kernel.sourceRoot,
    },
    addons: selection.addons.map(({ name }) => name),
    roots: roots.map(({ owner, root }) => ({
      owner,
      path: root.path,
      tree: root.tree,
    })),
    files: files.map(({ path, mode, blob }) => ({ path, mode, blob })),
    requirements: merged,
    stampChecker: { path: stampCheckerPath, blob: blobIdentity(stampChecker) },
  };
  await writeNew(
    folder,
    stampRecordPath,
    `${JSON.stringify(record, null, 2)}\n`,
    "100644",
  );
  return files.length + 2;
}
