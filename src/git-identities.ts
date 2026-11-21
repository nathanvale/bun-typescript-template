import { createHash } from "node:crypto";

export type FileMode = "100644" | "100755";

export type GitFile = {
  readonly path: string;
  readonly mode: FileMode;
  readonly blob: string;
};

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

export function messageOf(error: unknown): string {
  return String(Reflect.get(Object(error), "message"));
}

export function jsonOf(text: string): unknown {
  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch (error) {
    throw new Error(`it is not JSON (${messageOf(error)}).`, { cause: error });
  }
}

export const fullIdentity = /^[0-9a-f]{40}$/;

export function fileModeOf(mode: unknown): FileMode | undefined {
  return mode === "100644" || mode === "100755" ? mode : undefined;
}

// Platform: a decoder drops a leading byte-order mark unless told to keep it,
// and in a name it is a character.
const strictName = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

export function nameText(bytes: Uint8Array): string | undefined {
  try {
    return strictName.decode(bytes);
  } catch {
    return undefined;
  }
}

export function plainPathFault(path: string): string | undefined {
  if (path.split("/").some((part) => ["", ".", ".."].includes(part)))
    return 'it has an empty, "." or ".." part.';
  if (path.includes("\\")) return "it has a backslash.";
  if (path.includes("\0")) return "it has a NUL byte.";
  return undefined;
}

export function plainPath(value: unknown, where: string): string {
  const path = textOf(value, where);
  const fault = plainPathFault(path);
  if (fault !== undefined)
    throw new Error(
      `${where} is "${path}", which is not a plain path: ${fault}`,
    );
  return path;
}

type Tree = Map<string, GitFile | Tree>;

const encoder = new TextEncoder();

function identity(kind: "blob" | "tree", body: Uint8Array): string {
  return createHash("sha1")
    .update(encoder.encode(`${kind} ${body.byteLength}\0`))
    .update(body)
    .digest("hex");
}

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
  const held = tree.get(name) ?? new Map<string, GitFile | Tree>();
  if (!(held instanceof Map))
    throw new Error(`${path} is both a file and a folder.`);
  tree.set(name, held);
  return held;
}

function place(top: Tree, names: readonly string[], file: GitFile): void {
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

export function treeIdentity(files: readonly GitFile[], root: string): string {
  const prefix = root === "" ? "" : `${root}/`;
  const top: Tree = new Map();
  for (const file of files)
    if (file.path.startsWith(prefix))
      place(top, file.path.slice(prefix.length).split("/"), file);
  if (top.size === 0) throw new Error(`No listed file is under "${root}".`);
  return identityOfTree(top);
}
