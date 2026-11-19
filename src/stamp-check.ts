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

// Interface: these readers return a parsed JSON value's own data, or throw an
// Error starting with `where`, the field's name.
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

// Platform: a decoder drops a leading byte-order mark unless told to keep it,
// and in a name it is a character.
const strictName = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

// Interface: a name's text from its stored bytes, or undefined if not UTF-8.
export function nameText(bytes: Uint8Array): string | undefined {
  try {
    return strictName.decode(bytes);
  } catch {
    return undefined;
  }
}

// Interface: why a "/" path cannot stay inside its folder on every host, or
// undefined. Windows reads a backslash as a separator.
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

// Interface: git's SHA-1 identity of the tree of the listed files under
// `root` (a folder path, or "" for all), computed without git. It does not
// depend on where the tree sits.
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

// Interface: a generated repository's stamp record and the two files the
// stamp merges requirements into.
export const stampRecordPath = ".kernel-stamp.json";
export const packageFile = "package.json";
export const deadCodeFile = ".fallowrc.json";

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

type Opened =
  | { readonly mode: FileMode; readonly bytes: Buffer }
  | "absent"
  | "unreadable"
  | "not-a-file";

// Platform: opening a named pipe waits for a writer unless non-blocking, and
// an entry can change between a look and a read. So a file is opened once,
// waiting for nothing and failing on a link (ELOOP), and its kind, mode and
// bytes all come from that open. Git records one bit of a mode: whether the
// owner may execute the file.
function openedFile(path: string): Opened {
  let file: number;
  try {
    file = openSync(
      path,
      constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW,
    );
  } catch (error) {
    const code = String(Reflect.get(Object(error), "code"));
    if (["ENOENT", "ENOTDIR"].includes(code)) return "absent";
    return code === "ELOOP" ? "not-a-file" : "unreadable";
  }
  try {
    const found = fstatSync(file);
    if (!found.isFile()) return "not-a-file";
    const mode = (found.mode & 0o100) === 0 ? "100644" : "100755";
    return { mode, bytes: readFileSync(file) };
  } finally {
    closeSync(file);
  }
}

function plainBytes(path: string): Buffer {
  const opened = openedFile(path);
  if (typeof opened === "string")
    throw new Error("it is not a plain file that can be read.");
  return opened.bytes;
}

// Interface: a plain file's text. Bytes that are not UTF-8 are refused, not
// replaced.
function plainText(path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(plainBytes(path));
  } catch (error) {
    if (error instanceof TypeError)
      throw new Error("it is not UTF-8 text.", { cause: error });
    throw error;
  }
}

const unopened = {
  absent: ["missing", "it is recorded and is not in the folder."],
  unreadable: ["unreadable", "it is recorded and cannot be looked up."],
  "not-a-file": [
    "not-a-file",
    "it is recorded as a plain file and is not one.",
  ],
} as const;

function fileFindings(folder: string, file: StampedFile): StampFinding[] {
  const opened = openedFile(join(folder, file.path));
  if (typeof opened === "string") {
    const [kind, detail] = unopened[opened];
    return [{ kind, path: file.path, detail }];
  }
  const findings: StampFinding[] = [];
  if (blobIdentity(opened.bytes) !== file.blob)
    findings.push({
      kind: "modified",
      path: file.path,
      detail: "its bytes are not the stamped ones.",
    });
  if (opened.mode !== file.mode)
    findings.push({
      kind: "mode",
      path: file.path,
      detail: `its git mode is ${opened.mode}, and the stamp record says ${file.mode}.`,
    });
  return findings;
}

// Interface: each folder on the way to a stamp root (itself included) and to
// the stamp checker must be a folder, not a link to another folder's files.
function folderFindings(folder: string, record: StampRecord) {
  const checkerFolder = record.stampChecker.path.split("/").slice(0, -1);
  const onTheWay = new Set(
    [...record.roots, checkerFolder.join("/")].flatMap((root) =>
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
        detail:
          "it leads to a stamp root or the stamp checker and is not a folder itself.",
      }),
    );
}

type Under = {
  readonly at: string;
  readonly listed: boolean;
  readonly utf8: boolean;
};

function entriesUnder(folder: string, path: string): Under[] {
  if (folderAt(join(folder, path)) !== true) return [];
  const names = attempt(
    () => readdirSync(join(folder, path), { encoding: "buffer" }),
    undefined,
  );
  if (names === undefined) return [{ at: path, listed: false, utf8: true }];
  return names
    .map((bytes) => {
      const name = nameText(bytes);
      return {
        utf8: name !== undefined,
        at: `${path}/${name ?? bytes.toString()}`,
      };
    })
    .sort((one, other) => (one.at < other.at ? -1 : 1))
    .flatMap(({ at, utf8 }) => {
      const inside =
        utf8 && folderAt(join(folder, at)) === true
          ? entriesUnder(folder, at)
          : [];
      return inside.length > 0 ? inside : [{ at, listed: true, utf8 }];
    });
}

function extraFinding({ at, listed, utf8 }: Under): StampFinding {
  if (!listed)
    return {
      kind: "unreadable",
      path: at,
      detail: "it is a folder in a stamp root and cannot be listed.",
    };
  return {
    kind: "extra",
    path: at,
    detail: utf8
      ? "it is in a stamp root and is not recorded."
      : "it is in a stamp root, and its name is not UTF-8 text, so no stamp record can hold it.",
  };
}

function extraFindings(folder: string, record: StampRecord): StampFinding[] {
  const recorded = new Set(record.files.map(({ path }) => path));
  return record.roots
    .flatMap((root) => entriesUnder(folder, root))
    .filter(({ at, listed, utf8 }) => !listed || !utf8 || !recorded.has(at))
    .map(extraFinding);
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
    ...folderFindings(folder, record),
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

// Interface: the stamp check. Unstamped when `folder` holds no stamp record;
// intact when every stamped file, merged requirement and the stamp checker
// equal it; broken otherwise, with one finding per fault naming the file. It
// only reads, with no git, network or kernel repository. It guards against
// accidental edits, not deliberate ones.
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

if (import.meta.main) {
  const verdict = checkStamp(".");
  process.stdout.write(`${JSON.stringify(verdict, null, 2)}\n`);
  process.exitCode = Number(verdict.status !== "intact");
}
