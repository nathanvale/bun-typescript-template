import { relative, resolve } from "node:path";

export type PathItem = {
  readonly path: string;
  readonly isFile: boolean;
};

export type RenamePair = {
  readonly from: string;
  readonly to: string;
};

function recordStatus(
  status: string,
  first: string,
  second: string,
  added: string[],
  renames: RenamePair[],
): void {
  if (status.startsWith("R")) renames.push({ from: first, to: second });
  else if (status.startsWith("A")) added.push(first);
  else if (status.startsWith("C")) added.push(second);
}

export function parseNameStatus(fields: readonly string[]): {
  added: string[];
  renames: RenamePair[];
} {
  const added: string[] = [];
  const renames: RenamePair[] = [];
  let index = 0;
  while (index < fields.length) {
    const status = fields[index] ?? "";
    const hasSecond = status.startsWith("R") || status.startsWith("C");
    const first = fields[index + 1] ?? "";
    const second = fields[index + 2] ?? "";
    recordStatus(status, first, second, added, renames);
    index += hasSecond ? 3 : 2;
  }
  return { added, renames };
}

export function keptByRenames(renames: readonly RenamePair[]): Set<string> {
  const kept = new Set<string>();
  for (const { from, to } of renames) {
    const fromParts = from.split("/");
    const toParts = to.split("/");
    const fromFolders = new Set(fromParts.slice(0, -1));
    if (fromParts.at(-1) === toParts.at(-1)) kept.add(to);
    for (let end = 1; end < toParts.length; end += 1) {
      if (fromFolders.has(toParts[end - 1] ?? ""))
        kept.add(toParts.slice(0, end).join("/"));
    }
  }
  return kept;
}

function itemsFromFiles(files: readonly string[]): PathItem[] {
  const items = new Map<string, boolean>();
  for (const file of files) {
    const parts = file.split("/");
    for (let end = 1; end <= parts.length; end += 1) {
      const path = parts.slice(0, end).join("/");
      const isFile = end === parts.length;
      if (!items.has(path) || !isFile) items.set(path, isFile);
    }
  }
  return [...items].map(([path, isFile]) => ({ path, isFile }));
}

export function newPathItems(
  added: readonly string[],
  renames: readonly RenamePair[],
  earlier: ReadonlySet<string>,
): { allNew: PathItem[]; unkeptNew: PathItem[] } {
  const kept = keptByRenames(renames);
  const allNew = itemsFromFiles([
    ...added,
    ...renames.map(({ to }) => to),
  ]).filter(({ path }) => !earlier.has(path));
  return {
    allNew,
    unkeptNew: allNew.filter(({ path }) => !kept.has(path)),
  };
}

function pathInside(tree: string, absolute: string): string | undefined {
  const path = relative(tree, absolute);
  return /^(?:\.\.(?:\/|$)|\/|$)/.test(path) ? undefined : path;
}

export function keptMoveTargets(
  tool: unknown,
  input: ReadonlyMap<string, unknown>,
  from: string,
  tree: string,
): Set<string> {
  if (tool !== "apply_patch") return new Set();
  const patch = input.get("command");
  if (typeof patch !== "string") return new Set();
  const moves: RenamePair[] = [];
  let updated: string | undefined;
  for (const line of patch.split("\n")) {
    const updateMatch = /^\*\*\* Update File: (.+?)\s*$/.exec(line);
    if (updateMatch !== null) {
      updated = updateMatch[1];
      continue;
    }
    const moveMatch = /^\*\*\* Move to: (.+?)\s*$/.exec(line);
    if (moveMatch !== null && updated !== undefined) {
      const fromPath = pathInside(tree, resolve(from, updated));
      const toPath = pathInside(tree, resolve(from, moveMatch[1] ?? ""));
      if (fromPath !== undefined && toPath !== undefined)
        moves.push({ from: fromPath, to: toPath });
      updated = undefined;
      continue;
    }
    if (line.startsWith("*** ")) updated = undefined;
  }
  return keptByRenames(moves);
}
