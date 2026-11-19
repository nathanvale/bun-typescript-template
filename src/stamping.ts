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

// Interface: where a generated repository keeps its stamp checker, and where
// the template keeps one committed lockfile for each package set.
export const stampCheckerPath = "stamp-checker.ts";
export const committedLockfiles = "generated-repository/lockfiles";

export type StampRefusalCode =
  | "addon_unknown"
  | "addon_requirement_missing"
  | "lockfile_missing"
  | "stamp_conflict";

const repairs: { readonly [Code in StampRefusalCode]: string } = {
  addon_unknown: "Select only add-ons that commit declares.",
  addon_requirement_missing:
    "Add the add-on it requires to the add-on selection.",
  lockfile_missing:
    "Put the lockfile for that package set at that path in the template, or supply the lockfile's bytes.",
  stamp_conflict:
    "Remove it from the template's own files for a generated repository. Stamped source, its requirements, the stamp checker and the stamp record come from the stamp alone.",
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

// Interface: checks the named add-ons against one kernel commit, in memory.
// It refuses a name the kernel declaration does not hold, listing the names
// it does hold, and an add-on whose required add-on is not named. It never
// adds a required add-on itself: the names given are the selection the stamp
// record shows.
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
  for (const { name, requires } of addons) {
    const missing = requires.find((required) => !names.includes(required));
    if (missing !== undefined)
      throw new StampRefusal(
        "addon_requirement_missing",
        `Add-on "${name}" requires "${missing}", which is not selected.`,
      );
  }
  const withPackages = addons
    .filter(({ packages }) => Object.keys(packages).length > 0)
    .map(({ name }) => name);
  return {
    addons,
    packageSet: withPackages.length === 0 ? "base" : withPackages.join("+"),
    [selected]: true,
  };
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
    ...kernel.roots.map((root) => ({ owner: "base", root })),
    ...selection.addons.map(({ name, root }) => ({ owner: name, root })),
  ];
}

function requirementsOf(
  kernel: Kernel,
  selection: AddonSelection,
): Requirements {
  const owners: readonly Requirements[] = [kernel, ...selection.addons];
  return {
    packages: Object.fromEntries(
      owners.flatMap(({ packages }) => Object.entries(packages)),
    ),
    deadCodeEntries: owners.flatMap(({ deadCodeEntries }) => deadCodeEntries),
  };
}

async function held(folder: string, path: string): Promise<boolean> {
  try {
    await lstat(join(folder, path));
    return true;
  } catch (error) {
    if (
      ["ENOENT", "ENOTDIR"].includes(String(Reflect.get(Object(error), "code")))
    )
      return false;
    throw error;
  }
}

async function conflictIn(
  folder: string,
  roots: readonly Owned[],
  required: Requirements,
): Promise<string | undefined> {
  for (const { root } of roots)
    if (await held(folder, root.path))
      return `Stamp root "${root.path}" is already in the generated repository's own files.`;
  for (const path of [stampCheckerPath, stampRecordPath])
    if (await held(folder, path))
      return `${path} is already in the generated repository's own files.`;
  return requirementConflict(folder, required);
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
  const required = requirementsOf(kernel, selection);
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
