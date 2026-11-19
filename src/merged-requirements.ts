import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Requirements } from "./kernel-reader.ts";
import {
  deadCodeFile,
  fieldsOf,
  jsonOf,
  listOf,
  messageOf,
  packageFile,
} from "./stamp-check.ts";

const packageFields = [
  "dependencies",
  "devDependencies",
  "optionalDependencies",
  "peerDependencies",
];
const strictText = new TextDecoder("utf-8", { fatal: true });
const indent = (depth: number) => "  ".repeat(depth);

// Interface: how wide a line may be for a list to go on it. The formatter
// fits a list on a line of 80 columns, except in package.json, where it
// always gives a list one item a line.
const fittedLists = 80;
export const packageFileLists = 0;

type Place = {
  readonly depth: number;
  readonly before: number;
  readonly after: number;
};

function listText(
  items: readonly unknown[],
  { depth, before, after }: Place,
  width: number,
): string {
  if (items.length === 0) return "[]";
  const inner = items.map((item, index) =>
    valueText(
      item,
      {
        depth: depth + 1,
        before: 2 * (depth + 1),
        after: index + 1 < items.length ? 1 : 0,
      },
      width,
    ),
  );
  const flat = `[${inner.join(", ")}]`;
  if (!flat.includes("\n") && before + flat.length + after <= width)
    return flat;
  const lines = inner.map((item) => `${indent(depth + 1)}${item}`);
  return `[\n${lines.join(",\n")}\n${indent(depth)}]`;
}

function objectText(
  fields: Map<string, unknown>,
  depth: number,
  width: number,
): string {
  if (fields.size === 0) return "{}";
  const lines = [...fields].map(([key, value], index) => {
    const lead = `${indent(depth + 1)}${JSON.stringify(key)}: `;
    const after = index + 1 < fields.size ? 1 : 0;
    const place = { depth: depth + 1, before: lead.length, after };
    return `${lead}${valueText(value, place, width)}`;
  });
  return `{\n${lines.join(",\n")}\n${indent(depth)}}`;
}

function valueText(value: unknown, place: Place, width: number): string {
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return listText(items, place, width);
  }
  return typeof value === "object" && value !== null
    ? objectText(new Map(Object.entries(value)), place.depth, width)
    : JSON.stringify(value);
}

// Interface: JSON text in the form the generated repository's formatter
// leaves unchanged: two spaces a level, every object with one field a line,
// and a list on one line when that line fits in `listWidth` columns.
export function settingsText(
  value: unknown,
  listWidth: number = fittedLists,
): string {
  return `${valueText(value, { depth: 0, before: 0, after: 0 }, listWidth)}\n`;
}

async function fieldsIn(folder: string, file: string) {
  try {
    const text = strictText.decode(await readFile(join(folder, file)));
    return fieldsOf(jsonOf(text), file);
  } catch (error) {
    throw new Error(
      `The stamp merges requirements into ${file}, and it cannot be read as a JSON object in the staging folder: ${messageOf(error)} Repair: restore ${file} in the template's own files for a generated repository.`,
      { cause: error },
    );
  }
}

function declaredPackages(settings: Map<string, unknown>): string[] {
  return packageFields.flatMap((field) =>
    settings.has(field) ? [...fieldsOf(settings.get(field), field).keys()] : [],
  );
}

function heldEntries(settings: Map<string, unknown>): readonly unknown[] {
  return settings.has("entry") ? listOf(settings.get("entry"), "entry") : [];
}

async function packageConflict(folder: string, names: readonly string[]) {
  if (names.length === 0) return undefined;
  const declared = declaredPackages(await fieldsIn(folder, packageFile));
  const name = names.find((each) => declared.includes(each));
  return name === undefined
    ? undefined
    : `${packageFile} already declares package "${name}", which the kernel requires.`;
}

async function deadCodeConflict(folder: string, entries: readonly string[]) {
  if (entries.length === 0) return undefined;
  const held = heldEntries(await fieldsIn(folder, deadCodeFile));
  const entry = entries.find((each) => held.includes(each));
  return entry === undefined
    ? undefined
    : `${deadCodeFile} already holds dead-code entry "${entry}", which the kernel requires.`;
}

// Interface: why the requirements cannot be merged into the settings in
// `folder` without replacing something those settings already hold, or
// undefined. It writes nothing, and reads a settings file only when there is
// something to merge into it.
export async function requirementConflict(
  folder: string,
  { packages, deadCodeEntries }: Requirements,
): Promise<string | undefined> {
  return (
    (await packageConflict(folder, Object.keys(packages))) ??
    (await deadCodeConflict(folder, deadCodeEntries))
  );
}

async function rewrite(
  folder: string,
  file: string,
  change: (settings: Map<string, unknown>) => void,
): Promise<void> {
  const settings = await fieldsIn(folder, file);
  change(settings);
  const listWidth = file === packageFile ? packageFileLists : fittedLists;
  await writeFile(
    join(folder, file),
    settingsText(Object.fromEntries(settings), listWidth),
  );
}

// Interface: adds each required package to `dependencies` in package.json and
// each dead-code entry to `entry` in .fallowrc.json, in `folder`, and leaves
// a file it has nothing to add to as it is. It adds only; ask
// `requirementConflict` first. Returns what it merged, for the stamp record.
export async function mergeRequirements(
  folder: string,
  { packages, deadCodeEntries }: Requirements,
): Promise<Requirements> {
  if (Object.keys(packages).length > 0)
    await rewrite(folder, packageFile, (settings) => {
      const held = settings.has("dependencies")
        ? fieldsOf(settings.get("dependencies"), "dependencies")
        : new Map<string, unknown>();
      settings.set(
        "dependencies",
        Object.fromEntries([...held, ...Object.entries(packages)]),
      );
    });
  if (deadCodeEntries.length > 0)
    await rewrite(folder, deadCodeFile, (settings) => {
      settings.set("entry", [...heldEntries(settings), ...deadCodeEntries]);
    });
  return { packages, deadCodeEntries };
}
