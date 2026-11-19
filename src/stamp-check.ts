import { createHash } from "node:crypto";

export type FileMode = "100644" | "100755";

export type StampedFile = {
  readonly path: string;
  readonly mode: FileMode;
  readonly blob: string;
};

// Interface: the three readers below take a value parsed from JSON and return
// its own data, or throw an Error that starts with `where`, the name of the
// field.
export function fieldsOf(value: unknown, where: string): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(`${where} must be an object.`);
  return new Map(Object.entries(value));
}

export function listOf(value: unknown, where: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${where} must be a list.`);
  const items: readonly unknown[] = value;
  return items;
}

export function textOf(value: unknown, where: string): string {
  if (typeof value !== "string" || value === "")
    throw new Error(`${where} must be a non-empty string.`);
  return value;
}

type Tree = Map<string, StampedFile | Tree>;

const encoder = new TextEncoder();

function identity(kind: "blob" | "tree", body: Uint8Array): string {
  return createHash("sha1")
    .update(encoder.encode(`${kind} ${body.byteLength}\0`))
    .update(body)
    .digest("hex");
}

// Interface: git's SHA-1 identity of a file's bytes as they are, with no
// line-end or filter conversion, computed without git.
export function blobIdentity(bytes: Uint8Array): string {
  return identity("blob", bytes);
}

// Platform: git orders a tree's entries by the UTF-8 bytes of their names, and
// compares a folder as if its name ended in "/".
function identityOfTree(tree: Tree): string {
  const entries = [...tree]
    .map(([name, held]) => {
      const folder = held instanceof Map;
      return {
        order: Buffer.from(folder ? `${name}/` : name),
        head: encoder.encode(`${folder ? "40000" : held.mode} ${name}\0`),
        id: Buffer.from(folder ? identityOfTree(held) : held.blob, "hex"),
      };
    })
    .sort((one, other) => Buffer.compare(one.order, other.order));
  return identity(
    "tree",
    Buffer.concat(entries.flatMap(({ head, id }) => [head, id])),
  );
}

function folderIn(tree: Tree, name: string, path: string): Tree {
  const held = tree.get(name) ?? new Map<string, StampedFile | Tree>();
  if (!(held instanceof Map))
    throw new Error(`${path} is both a file and a folder.`);
  tree.set(name, held);
  return held;
}

function place(top: Tree, names: readonly string[], file: StampedFile): void {
  const leaf = names.at(-1) ?? "";
  const folders = file.path.split("/").slice(0, -names.length);
  let tree = top;
  for (const name of names.slice(0, -1)) {
    folders.push(name);
    tree = folderIn(tree, name, folders.join("/"));
  }
  const held = tree.get(leaf);
  if (held instanceof Map)
    throw new Error(`${file.path} is both a file and a folder.`);
  if (held !== undefined) throw new Error(`${file.path} is listed twice.`);
  tree.set(leaf, file);
}

// Interface: git's SHA-1 identity of the tree that holds the listed files
// under `root`, computed without git. `root` is a folder path with no trailing
// slash, or "" for every listed file. A tree identity does not depend on where
// the tree sits, so one folder has the same identity in any repository.
export function treeIdentity(
  files: readonly StampedFile[],
  root: string,
): string {
  const prefix = root === "" ? "" : `${root}/`;
  const top: Tree = new Map();
  for (const file of files)
    if (file.path.startsWith(prefix))
      place(top, file.path.slice(prefix.length).split("/"), file);
  if (top.size === 0) throw new Error(`No listed file is under "${root}".`);
  return identityOfTree(top);
}
