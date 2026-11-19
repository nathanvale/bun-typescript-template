import { createHash } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

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

// Interface: a git identity in full: 40 lowercase hexadecimal characters.
export const fullIdentity = /^[0-9a-f]{40}$/;

// Interface: the git mode of a plain file, or undefined for any other entry.
export function fileModeOf(mode: unknown): FileMode | undefined {
  return mode === "100644" || mode === "100755" ? mode : undefined;
}

// Interface: a path from a folder's top, written with "/" between its parts,
// that cannot leave the folder on any host: no empty, "." or ".." part, and no
// backslash, which Windows reads as a separator.
export function plainPath(value: unknown, where: string): string {
  const path = textOf(value, where);
  if (path.split("/").some((part) => ["", ".", ".."].includes(part)))
    throw new Error(
      `${where} is "${path}", which is not a plain path: it has an empty, "." or ".." part.`,
    );
  if (path.includes("\\"))
    throw new Error(
      `${where} is "${path}", which is not a plain path: it has a backslash.`,
    );
  return path;
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

// Interface: where a generated repository keeps its stamp record, and the two
// files the stamp merges requirements into.
export const stampRecordPath = ".kernel-stamp.json";
const packageFile = "package.json";
const deadCodeFile = ".fallowrc.json";

export type StampFinding = {
  readonly kind:
    | "modified"
    | "missing"
    | "extra"
    | "mode"
    | "not-a-file"
    | "not-a-folder"
    | "unreadable"
    | "requirement"
    | "stamp-checker"
    | "stamp-record";
  readonly path: string;
  readonly detail: string;
};

export type StampVerdict =
  | {
      readonly status: "intact";
      readonly commit: string;
      readonly addons: readonly string[];
      readonly fileCount: number;
    }
  | { readonly status: "broken"; readonly findings: readonly StampFinding[] }
  | { readonly status: "unstamped" };

type StampRecord = {
  readonly commit: string;
  readonly addons: readonly string[];
  readonly roots: readonly string[];
  readonly files: readonly StampedFile[];
  readonly packages: readonly (readonly [string, string])[];
  readonly deadCodeEntries: readonly string[];
  readonly stampChecker: { readonly path: string; readonly blob: string };
};

function identityOf(value: unknown, where: string): string {
  const text = textOf(value, where);
  if (!fullIdentity.test(text))
    throw new Error(`${where} must be 40 lowercase hexadecimal characters.`);
  return text;
}

function only(value: unknown, read: unknown, where: string, what: string) {
  if (value !== read)
    throw new Error(
      `${where} is ${JSON.stringify(value)}, and the stamp check reads ${what} only.`,
    );
}

function recordedFile(value: unknown, where: string): StampedFile {
  const file = fieldsOf(value, where);
  const mode = fileModeOf(file.get("mode"));
  if (mode === undefined)
    throw new Error(
      `${where}.mode is ${JSON.stringify(file.get("mode"))}, and a stamped file is 100644 or 100755.`,
    );
  return {
    path: plainPath(file.get("path"), `${where}.path`),
    mode,
    blob: identityOf(file.get("blob"), `${where}.blob`),
  };
}

function recordedRoots(
  value: unknown,
  files: readonly StampedFile[],
): string[] {
  const roots = listOf(value, "roots").map((item, index) => {
    const root = fieldsOf(item, `roots[${index}]`);
    return {
      path: plainPath(root.get("path"), `roots[${index}].path`),
      tree: identityOf(root.get("tree"), `roots[${index}].tree`),
    };
  });
  for (const [index, { path }] of files.entries())
    if (!roots.some((root) => path.startsWith(`${root.path}/`)))
      throw new Error(
        `files[${index}].path is "${path}", which is in none of the recorded stamp roots.`,
      );
  for (const [index, { path, tree }] of roots.entries())
    if (treeIdentity(files, path) !== tree)
      throw new Error(
        `roots[${index}].tree is not the tree identity of the files recorded under "${path}".`,
      );
  return roots.map(({ path }) => path);
}

function recordOf(text: string): StampRecord {
  const record = fieldsOf(jsonOf(text), "the stamp record");
  only(record.get("schemaVersion"), 1, "schemaVersion", "version 1");
  const kernel = fieldsOf(record.get("kernel"), "kernel");
  only(kernel.get("objectFormat"), "sha1", "kernel.objectFormat", "sha1");
  const requirements = fieldsOf(record.get("requirements"), "requirements");
  const stampChecker = fieldsOf(record.get("stampChecker"), "stampChecker");
  const files = listOf(record.get("files"), "files").map((file, index) =>
    recordedFile(file, `files[${index}]`),
  );
  return {
    commit: identityOf(kernel.get("commit"), "kernel.commit"),
    addons: listOf(record.get("addons"), "addons").map((addon, index) =>
      textOf(addon, `addons[${index}]`),
    ),
    roots: recordedRoots(record.get("roots"), files),
    files,
    packages: [
      ...fieldsOf(requirements.get("packages"), "requirements.packages"),
    ].map(([name, version]) => [
      name,
      textOf(version, `requirements.packages.${name}`),
    ]),
    deadCodeEntries: listOf(
      requirements.get("deadCodeEntries"),
      "requirements.deadCodeEntries",
    ).map((entry, index) =>
      plainPath(entry, `requirements.deadCodeEntries[${index}]`),
    ),
    stampChecker: {
      path: plainPath(stampChecker.get("path"), "stampChecker.path"),
      blob: identityOf(stampChecker.get("blob"), "stampChecker.blob"),
    },
  };
}

function attempt<Result>(read: () => Result, otherwise: Result): Result {
  try {
    return read();
  } catch {
    return otherwise;
  }
}

// Platform: looking an entry up fails with ENOENT when nothing has that
// name, and with ENOTDIR when a name on the way is not a folder. Any other
// failure, such as a folder that may not be searched, says nothing about
// whether the entry is there.
function entryAt(path: string): Stats | "absent" | "unreadable" {
  try {
    return lstatSync(path);
  } catch (error) {
    return ["ENOENT", "ENOTDIR"].includes(
      String(Reflect.get(Object(error), "code")),
    )
      ? "absent"
      : "unreadable";
  }
}

function folderAt(path: string): boolean | undefined {
  const found = entryAt(path);
  return typeof found === "string" ? undefined : found.isDirectory();
}

// Platform: opening a named pipe to read waits for a writer unless the open
// is non-blocking, and the entry at a path can change between a look and an
// open. So the file is opened without waiting, and the open file itself is
// checked before it is read.
function plainBytes(path: string): Buffer {
  const unreadable = () =>
    new Error("it is not a plain file that can be read.");
  const file = attempt(
    () => openSync(path, constants.O_RDONLY | constants.O_NONBLOCK),
    undefined,
  );
  if (file === undefined) throw unreadable();
  try {
    if (!fstatSync(file).isFile()) throw unreadable();
    return readFileSync(file);
  } finally {
    closeSync(file);
  }
}

// Interface: the text of a plain file. Bytes that are not UTF-8 are refused,
// not replaced, so a value read from the file is the one the file holds.
function plainText(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plainBytes(path));
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error("it is not UTF-8 text.", { cause: error });
    throw error;
  }
}

function fileFindings(folder: string, file: StampedFile): StampFinding[] {
  const at = join(folder, file.path);
  const found = entryAt(at);
  if (found === "absent")
    return [
      {
        kind: "missing",
        path: file.path,
        detail: "it is recorded and is not in the folder.",
      },
    ];
  if (found === "unreadable")
    return [
      {
        kind: "unreadable",
        path: file.path,
        detail: "it is recorded and cannot be looked up.",
      },
    ];
  if (!found.isFile())
    return [
      {
        kind: "not-a-file",
        path: file.path,
        detail: "it is recorded as a plain file and is not one.",
      },
    ];
  // Platform: git records one bit of a file's mode, whether its owner may
  // execute it.
  const mode: FileMode = (found.mode & 0o100) === 0 ? "100644" : "100755";
  const findings: StampFinding[] = [];
  if (attempt(() => blobIdentity(readFileSync(at)), "") !== file.blob)
    findings.push({
      kind: "modified",
      path: file.path,
      detail: "its bytes are not the stamped ones.",
    });
  if (mode !== file.mode)
    findings.push({
      kind: "mode",
      path: file.path,
      detail: `its git mode is ${mode}, and the stamp record says ${file.mode}.`,
    });
  return findings;
}

// Interface: every folder on the way from the top of `folder` to each stamp
// root, the stamp root included, must be a folder itself. A link there would
// let the files of another folder pass as the stamped ones.
function folderFindings(folder: string, roots: readonly string[]) {
  const onTheWay = new Set(
    roots.flatMap((root) =>
      root
        .split("/")
        .map((_part, depth, parts) => parts.slice(0, depth + 1).join("/")),
    ),
  );
  return [...onTheWay]
    .filter((path) => folderAt(join(folder, path)) === false)
    .map(
      (path): StampFinding => ({
        kind: "not-a-folder",
        path,
        detail: "it leads to a stamp root and is not a folder itself.",
      }),
    );
}

type Under = { readonly at: string; readonly listed: boolean };

function entriesUnder(folder: string, path: string): Under[] {
  if (folderAt(join(folder, path)) !== true) return [];
  const entries = attempt(
    () => readdirSync(join(folder, path), { withFileTypes: true }),
    undefined,
  );
  if (entries === undefined) return [{ at: path, listed: false }];
  return entries
    .map((entry) => ({ entry, at: `${path}/${entry.name}` }))
    .sort((one, other) => (one.at < other.at ? -1 : 1))
    .flatMap(({ entry, at }) =>
      entry.isDirectory() ? entriesUnder(folder, at) : [{ at, listed: true }],
    );
}

function extraFindings(folder: string, record: StampRecord): StampFinding[] {
  const recorded = new Set(record.files.map(({ path }) => path));
  return record.roots
    .flatMap((root) => entriesUnder(folder, root))
    .filter(({ at, listed }) => !listed || !recorded.has(at))
    .map(
      ({ at, listed }): StampFinding =>
        listed
          ? {
              kind: "extra",
              path: at,
              detail: "it is in a stamp root and is not recorded.",
            }
          : {
              kind: "unreadable",
              path: at,
              detail: "it is a folder in a stamp root and cannot be listed.",
            },
    );
}

// Interface: one file the stamp merged requirements into, read as the field
// that holds them. `unreadable` holds a finding when the file is missing or is
// not a JSON object.
function mergedInto(folder: string, file: string, key: string) {
  const held = attempt(
    () => fieldsOf(jsonOf(plainText(join(folder, file))), file),
    undefined,
  );
  const unreadable: StampFinding[] =
    held === undefined
      ? [
          {
            kind: "requirement",
            path: file,
            detail:
              "it cannot be read as a JSON object, and the stamp merged requirements into it.",
          },
        ]
      : [];
  return { field: held?.get(key), unreadable };
}

function packageFindings(folder: string, record: StampRecord): StampFinding[] {
  if (record.packages.length === 0) return [];
  const { field, unreadable } = mergedInto(folder, packageFile, "dependencies");
  if (unreadable.length > 0) return unreadable;
  const held = attempt(
    () => fieldsOf(field, "dependencies"),
    new Map<string, unknown>(),
  );
  return record.packages
    .filter(([name, version]) => held.get(name) !== version)
    .map(([name, version]) => ({
      kind: "requirement",
      path: packageFile,
      detail: `the stamp merged package "${name}" at "${version}", and it is now ${held.has(name) ? JSON.stringify(held.get(name)) : "absent"}.`,
    }));
}

function deadCodeFindings(folder: string, record: StampRecord): StampFinding[] {
  if (record.deadCodeEntries.length === 0) return [];
  const { field, unreadable } = mergedInto(folder, deadCodeFile, "entry");
  if (unreadable.length > 0) return unreadable;
  const held = attempt(() => listOf(field, "entry"), []);
  return record.deadCodeEntries
    .filter((entry) => !held.includes(entry))
    .map((entry) => ({
      kind: "requirement",
      path: deadCodeFile,
      detail: `the stamp merged dead-code entry "${entry}", and it is now absent.`,
    }));
}

function findingsIn(folder: string, record: StampRecord): StampFinding[] {
  const { path, blob } = record.stampChecker;
  const stampChecker = attempt(
    () => blobIdentity(plainBytes(join(folder, path))),
    "",
  );
  return [
    ...folderFindings(folder, record.roots),
    ...record.files.flatMap((file) => fileFindings(folder, file)),
    ...extraFindings(folder, record),
    ...packageFindings(folder, record),
    ...deadCodeFindings(folder, record),
    ...(stampChecker === blob
      ? []
      : [
          {
            kind: "stamp-checker" as const,
            path,
            detail: "it is not the stamp checker the stamp record names.",
          },
        ]),
  ];
}

// Interface: the stamp check. It compares `folder` with the stamp record it
// holds and returns a verdict: unstamped when the folder holds no stamp
// record; intact when every stamped file, every merged requirement and the
// stamp checker equal the record; broken otherwise, with one finding for each
// fault, naming the file. It reads only, and needs no git, no network and no
// kernel repository. It guards against accidental edits: whoever edits a
// stamped file on purpose can edit the stamp record too.
export function checkStamp(folder: string): StampVerdict {
  const recordAt = join(folder, stampRecordPath);
  if (entryAt(recordAt) === "absent") return { status: "unstamped" };
  let record: StampRecord;
  try {
    record = recordOf(plainText(recordAt));
  } catch (error) {
    return {
      status: "broken",
      findings: [
        {
          kind: "stamp-record",
          path: stampRecordPath,
          detail: messageOf(error),
        },
      ],
    };
  }
  const findings = findingsIn(folder, record);
  return findings.length === 0
    ? {
        status: "intact",
        commit: record.commit,
        addons: record.addons,
        fileCount: record.files.length,
      }
    : { status: "broken", findings };
}
