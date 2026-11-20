import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname } from "node:path";
import {
  fieldsOf,
  fileModeOf,
  fullIdentity,
  jsonOf,
  listOf,
  messageOf,
  nameText,
  plainPath,
  plainPathFault,
  type StampedFile,
  textOf,
  treeIdentity,
} from "./git-identities.ts";

// Interface: the one kernel path the template knows. Every other path comes
// from the kernel declaration read at the commit.
export const kernelDeclarationPath =
  "kernel/config/kernel/kernel-declaration.json";

export type KernelSeam = {
  readonly repository: string;
  readonly commit: string;
};

export type KernelFile = StampedFile & { readonly bytes: Uint8Array };

export type StampRoot = {
  readonly path: string;
  readonly tree: string;
  readonly files: readonly KernelFile[];
};

export type Requirements = {
  readonly packages: Readonly<Record<string, string>>;
  readonly deadCodeEntries: readonly string[];
};

export type Addon = Requirements & {
  readonly name: string;
  readonly requires: readonly string[];
  readonly root: StampRoot;
};

export type Kernel = Requirements & {
  readonly commit: string;
  readonly sourceRoot: string;
  readonly roots: readonly StampRoot[];
  readonly addons: readonly Addon[];
};

export type KernelRefusalCode =
  | "kernel_repository_missing"
  | "kernel_commit_abbreviated"
  | "kernel_commit_missing"
  | "kernel_object_format_unsupported"
  | "kernel_declaration_missing"
  | "kernel_declaration_invalid"
  | "kernel_entry_unsupported";

const repairs: { readonly [Code in KernelRefusalCode]: string } = {
  kernel_repository_missing:
    "Put a clone of the kernel repository at that path, or give the path of one that is there.",
  kernel_commit_abbreviated:
    "Give the commit's full identity, as `git rev-parse <commit>` prints it in the kernel repository.",
  kernel_commit_missing:
    "Give a commit that clone holds with all its files. Fetch one with `git fetch origin <commit>`, and in a partial clone also run `git fetch --refetch --no-filter origin`. Then run this again.",
  kernel_object_format_unsupported:
    "Give a kernel repository that uses git's sha1 object format.",
  kernel_declaration_missing:
    "Give a commit that holds the kernel declaration, or the path the kernel declaration has at that commit.",
  kernel_declaration_invalid:
    "Correct the kernel declaration in the kernel repository, then give the commit that holds the correction.",
  kernel_entry_unsupported:
    "Make that entry a plain file with its own name in the kernel repository, then give the commit that holds the change.",
};

export class KernelRefusal extends Error {
  readonly repair: string;
  constructor(
    readonly code: KernelRefusalCode,
    readonly reason: string,
  ) {
    super(`${reason} Repair: ${repairs[code]}`);
    this.repair = repairs[code];
  }
}

type Entry = {
  readonly name: Buffer;
  readonly path: string;
  readonly utf8: boolean;
  readonly mode: string;
  readonly id: string;
};

type Listed = { readonly entry: Entry; readonly file: StampedFile };

type Declaration = Requirements & {
  readonly roots: readonly string[];
  readonly addons: readonly (Requirements & {
    readonly name: string;
    readonly requires: readonly string[];
    readonly root: string;
  })[];
};

const gitMilliseconds = 4_000;
const strictText = new TextDecoder("utf-8", { fatal: true });
const linkKinds = new Map([
  ["120000", "a symbolic link"],
  ["160000", "a submodule"],
]);

// Platform: git reads objects only through rev-parse, ls-tree, cat-file,
// merge-base and log here, none of which reads the working tree or the
// network. The environment
// holds nothing of the caller's but PATH: a replace ref cannot swap an object,
// no prompt can open, no configuration file outside the repository applies,
// and git looks for the repository in the given folder alone. A partial clone
// cannot fetch an object: an empty GIT_ALLOW_PROTOCOL allows no transport,
// not a local path and not a remote helper found on PATH.
export function git(
  repository: string,
  command: "rev-parse" | "ls-tree" | "cat-file" | "merge-base" | "log",
  args: readonly string[],
  stdin?: Uint8Array,
) {
  const result = Bun.spawnSync(["git", command, ...args], {
    cwd: repository,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CEILING_DIRECTORIES: dirname(repository),
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_ALLOW_PROTOCOL: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${command} did not finish within ${gitMilliseconds} ms in ${repository}. Repair: run it by hand there to see where it waits, then run this again.`,
    );
  return {
    ok: result.exitCode === 0,
    code: result.exitCode,
    stdout: result.stdout,
    said: result.stderr.toString().trim().split("\n")[0] ?? "",
  };
}

function repositoryAt(path: string): string {
  const missing = (why: string) =>
    new KernelRefusal(
      "kernel_repository_missing",
      `No git repository is at ${path}: ${why}`,
    );
  if (!existsSync(path)) throw missing("that path does not exist.");
  if (!statSync(path).isDirectory())
    throw missing("that path is not a folder.");
  const repository = realpathSync(path);
  const found = git(repository, "rev-parse", [
    "--show-object-format",
    "--is-inside-work-tree",
  ]);
  if (!found.ok) throw missing(`git says "${found.said}".`);
  const [name = "", inWorkTree] = found.stdout.toString().split("\n");
  // Platform: at the top of a working tree git prints an empty prefix. In a
  // bare repository, or in a .git folder, there is no working tree, and the
  // folder is the repository only when it is git's own folder. Git prints a
  // path as it is stored, line feeds included, so each path is asked for in a
  // call of its own and only the one line feed git adds is removed.
  const onePath = (option: string) =>
    git(repository, "rev-parse", [option]).stdout.toString().slice(0, -1);
  const atTop =
    inWorkTree === "true"
      ? onePath("--show-prefix") === ""
      : onePath("--absolute-git-dir") === repository;
  if (!atTop) throw missing("that folder is inside the repository above it.");
  if (name !== "sha1")
    throw new KernelRefusal(
      "kernel_object_format_unsupported",
      `The git repository at ${path} uses the ${name} object format, and the kernel reader reads sha1 only.`,
    );
  return repository;
}

function requireCommit(repository: string, seam: KernelSeam): void {
  const kind = git(repository, "cat-file", ["-t", seam.commit]);
  const named = kind.stdout.toString().trim();
  if (!kind.ok)
    throw new KernelRefusal(
      "kernel_commit_missing",
      `Commit ${seam.commit} is not in the git repository at ${seam.repository}.`,
    );
  if (named !== "commit")
    throw new KernelRefusal(
      "kernel_commit_missing",
      `${seam.commit} names a ${named}, not a commit, in the git repository at ${seam.repository}.`,
    );
}

function entriesAt(repository: string, seam: KernelSeam): Entry[] {
  const listing = git(repository, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    seam.commit,
  ]);
  if (!listing.ok)
    throw new KernelRefusal(
      "kernel_commit_missing",
      `Commit ${seam.commit} is in the git repository at ${seam.repository}, and its list of files is not: git says "${listing.said}".`,
    );
  return recordsOf(listing.stdout).map((record) => {
    const tab = record.indexOf(9);
    const [mode = "", , id = ""] = record
      .subarray(0, tab)
      .toString()
      .split(" ");
    const name = record.subarray(tab + 1);
    const path = nameText(name);
    return {
      name,
      path: path ?? name.toString(),
      utf8: path !== undefined,
      mode,
      id,
    };
  });
}

function utf8Of(bytes: Uint8Array, strict: TextDecoder): string | undefined {
  try {
    return strict.decode(bytes);
  } catch {
    return undefined;
  }
}

// Platform: `git ls-tree -z` ends each entry with a NUL byte and prints its
// path as the bytes git stores, which need not be UTF-8 text.
function recordsOf(listing: Buffer): Buffer[] {
  const records: Buffer[] = [];
  let offset = 0;
  for (
    let end = listing.indexOf(0);
    end >= 0;
    end = listing.indexOf(0, offset)
  ) {
    records.push(listing.subarray(offset, end));
    offset = end + 1;
  }
  return records;
}

// Platform: for each identity it is given, `git cat-file --batch` prints a
// line of the identity, the object's kind and its size, then that many bytes
// and a line feed. An object the repository lacks gets a line that ends in
// "missing" and no bytes.
function blobsOf(
  repository: string,
  seam: KernelSeam,
  ids: readonly string[],
): Map<string, Uint8Array> {
  const { stdout } = git(
    repository,
    "cat-file",
    ["--batch"],
    Buffer.from(ids.map((id) => `${id}\n`).join("")),
  );
  const blobs = new Map<string, Uint8Array>();
  let offset = 0;
  for (const id of ids) {
    const lineEnd = stdout.indexOf(10, offset);
    const [named, kind, size] = stdout
      .subarray(offset, Math.max(lineEnd, offset))
      .toString()
      .split(" ");
    const end = lineEnd + 1 + Number(size);
    if (named !== id || kind !== "blob" || stdout[end] !== 10)
      throw new KernelRefusal(
        "kernel_commit_missing",
        `Commit ${seam.commit} is in the git repository at ${seam.repository}, and its file object ${id} is not.`,
      );
    blobs.set(id, new Uint8Array(stdout.subarray(lineEnd + 1, end)));
    offset = end + 1;
  }
  return blobs;
}

function plainFile(
  { path, utf8, mode, id }: Entry,
  commit: string,
): StampedFile {
  if (!utf8)
    throw new KernelRefusal(
      "kernel_entry_unsupported",
      `${path} in commit ${commit} has a name that is not UTF-8 text, and a stamp root holds files with UTF-8 names only.`,
    );
  const plain = fileModeOf(mode);
  if (plain === undefined)
    throw new KernelRefusal(
      "kernel_entry_unsupported",
      `${path} in commit ${commit} is ${linkKinds.get(mode) ?? `an entry of git mode ${mode}`}, and a stamp root holds plain files only.`,
    );
  return { path, mode: plain, blob: id };
}

function requirementsOf(
  owner: Map<string, unknown>,
  where: string,
): Requirements {
  return {
    packages: Object.fromEntries(
      [...fieldsOf(owner.get("packages"), `${where}.packages`)].map(
        ([name, version]) => [
          name,
          textOf(version, `${where}.packages.${name}`),
        ],
      ),
    ),
    deadCodeEntries: listOf(
      owner.get("deadCodeEntries"),
      `${where}.deadCodeEntries`,
    ).map((entry, index) =>
      plainPath(entry, `${where}.deadCodeEntries[${index}]`),
    ),
  };
}

function checkRoots(roots: readonly string[]): void {
  for (const [index, root] of roots.entries()) {
    if (roots.indexOf(root) !== index)
      throw new Error(`stamp root "${root}" is declared twice.`);
    const outer = roots.find((other) => root.startsWith(`${other}/`));
    if (outer !== undefined)
      throw new Error(`stamp root "${root}" is inside stamp root "${outer}".`);
  }
}

function everyRoot({ roots, addons }: Declaration): string[] {
  return [...roots, ...addons.map(({ root }) => root)];
}

function declarationOf(text: string): Declaration {
  const file = fieldsOf(jsonOf(text), "the file");
  if (file.get("schemaVersion") !== 2)
    throw new Error(
      `schemaVersion is ${JSON.stringify(file.get("schemaVersion"))}, and the kernel reader reads version 2 only.`,
    );
  const base = fieldsOf(file.get("base"), "base");
  const roots = listOf(base.get("roots"), "base.roots").map((root, index) =>
    plainPath(root, `base.roots[${index}]`),
  );
  const addons = [...fieldsOf(file.get("addons"), "addons")].map(
    ([name, value]) => {
      const where = `addons.${name}`;
      const addon = fieldsOf(value, where);
      return {
        name,
        root: plainPath(addon.get("root"), `${where}.root`),
        requires: listOf(addon.get("requires"), `${where}.requires`).map(
          (required, index) => textOf(required, `${where}.requires[${index}]`),
        ),
        ...requirementsOf(addon, where),
      };
    },
  );
  for (const { name, requires } of addons)
    for (const required of requires)
      if (!addons.some((addon) => addon.name === required))
        throw new Error(
          `addons.${name}.requires names "${required}", which is not a declared add-on.`,
        );
  const declaration = { roots, addons, ...requirementsOf(base, "base") };
  checkRoots(everyRoot(declaration));
  return declaration;
}

function sourceRootOf(declarationPath: string, roots: readonly string[]) {
  const folder = dirname(declarationPath);
  const holders = roots.filter(
    (root) => folder === root || folder.endsWith(`/${root}`),
  );
  const [holder] = holders;
  if (holder === undefined || holders.length !== 1)
    throw new Error(
      `the folder it sits in, "${folder}", must end with exactly one of the kernel's own stamp roots (${roots.join(", ")}), and it ends with ${holders.length}.`,
    );
  return folder.slice(0, -holder.length).replace(/\/$/, "");
}

function listedUnder(
  entries: readonly Entry[],
  sourceRoot: string,
  root: string,
  commit: string,
): Listed[] {
  const source = sourceRoot === "" ? "" : `${sourceRoot}/`;
  const under = Buffer.from(`${source}${root}/`);
  const listed = entries
    .filter(({ name }) => name.subarray(0, under.length).equals(under))
    .map((entry) => {
      const file = plainFile(entry, commit);
      const path = entry.path.slice(source.length);
      const fault = plainPathFault(path);
      if (fault !== undefined)
        throw new KernelRefusal(
          "kernel_entry_unsupported",
          `${entry.path} in commit ${commit} has a name a stamp record cannot hold: ${fault}`,
        );
      return { entry, file: { ...file, path } };
    });
  if (listed.length === 0)
    throw new Error(
      `it declares stamp root "${root}", which holds no file in that commit.`,
    );
  return listed;
}

// Platform: a file system that ignores letter case or Unicode form (the
// defaults on macOS and Windows) holds one entry where git holds two whose
// names differ only in that, whether they are two files, two folders, or a
// file and a folder.
function refuseCollisions(listed: readonly Listed[], commit: string): void {
  const spelled = new Map<string, string>();
  for (const { entry } of listed) {
    const parts = entry.path.split("/");
    for (const depth of parts.keys()) {
      const path = parts.slice(0, depth + 1).join("/");
      const folded = path.normalize("NFC").toLowerCase();
      const earlier = spelled.get(folded) ?? path;
      if (earlier !== path)
        throw new KernelRefusal(
          "kernel_entry_unsupported",
          `${earlier} and ${path} in commit ${commit} differ only in letter case or Unicode form, so one would replace the other where file names ignore that.`,
        );
      spelled.set(folded, path);
    }
  }
}

function declared<Result>(
  declarationPath: string,
  commit: string,
  read: () => Result,
): Result {
  try {
    return read();
  } catch (error) {
    if (error instanceof KernelRefusal) throw error;
    throw new KernelRefusal(
      "kernel_declaration_invalid",
      `The kernel declaration at ${declarationPath} in commit ${commit} is not valid: ${messageOf(error)}`,
    );
  }
}

// Platform: git names a folder by the tree of everything in it. A tree can
// hold an entry that a list of files does not show, such as an empty folder
// made with git's plumbing, and its identity then differs from the one the
// listed files give.
function requireWholeRoots(
  repository: string,
  seam: KernelSeam,
  sourceRoot: string,
  roots: readonly StampRoot[],
): void {
  const source = sourceRoot === "" ? "" : `${sourceRoot}/`;
  const named = git(
    repository,
    "rev-parse",
    roots.map(({ path }) => `${seam.commit}:${source}${path}`),
  )
    .stdout.toString()
    .split("\n");
  for (const [index, { path, tree }] of roots.entries())
    if (named[index] !== tree)
      throw new KernelRefusal(
        "kernel_entry_unsupported",
        `${source}${path} in commit ${seam.commit} holds an entry that is not a file, such as an empty folder, and a stamp root holds plain files only.`,
      );
}

function stampRootsOf(
  repository: string,
  seam: KernelSeam,
  sourceRoot: string,
  listed: ReadonlyMap<string, readonly Listed[]>,
): Map<string, StampRoot> {
  const every = [...listed.values()].flat();
  refuseCollisions(every, seam.commit);
  const blobs = blobsOf(
    repository,
    seam,
    every.map(({ file }) => file.blob),
  );
  const roots = new Map(
    [...listed].map(([path, files]): [string, StampRoot] => {
      const held = files.map(({ file }) => ({
        ...file,
        bytes: blobs.get(file.blob) ?? new Uint8Array(),
      }));
      return [path, { path, tree: treeIdentity(held, path), files: held }];
    }),
  );
  requireWholeRoots(repository, seam, sourceRoot, [...roots.values()]);
  return roots;
}

function utf8TextOf(bytes: Uint8Array | undefined): string {
  const text = utf8Of(bytes ?? new Uint8Array(), strictText);
  if (text === undefined) throw new Error("it is not UTF-8 text.");
  return text;
}

// Interface: the kernel reader's first refusals, for a caller that reads
// history, not files. Returns the repository's real path.
export function openCommit(seam: KernelSeam): string {
  const { commit } = seam;
  if (!fullIdentity.test(commit))
    throw new KernelRefusal(
      "kernel_commit_abbreviated",
      `"${commit}" is not a full commit identity, which is 40 lowercase hexadecimal characters.`,
    );
  const repository = repositoryAt(seam.repository);
  requireCommit(repository, seam);
  return repository;
}

// Interface: reads the kernel at one full commit from the git objects of the
// repository at a local path, and never from its working tree, so the
// repository may sit on another commit with edits in progress. It reads the
// kernel declaration at `declarationPath` in that commit and takes every
// other path from it. Each file's `path` is the one it will have in a
// generated repository: its path in the kernel repository with `sourceRoot`
// removed. It refuses by throwing a KernelRefusal, whose message ends with
// its repair line, before it returns anything. A git call that does not
// finish within its bound throws an Error with its own repair line. No
// network, no cache, no credential.
export function readKernel(
  seam: KernelSeam,
  declarationPath: string = kernelDeclarationPath,
): Kernel {
  const { commit } = seam;
  const repository = openCommit(seam);
  const entries = entriesAt(repository, seam);
  const held = entries.find(
    ({ path, utf8 }) => utf8 && path === declarationPath,
  );
  if (held === undefined)
    throw new KernelRefusal(
      "kernel_declaration_missing",
      `Commit ${commit} holds no kernel declaration at ${declarationPath}.`,
    );
  const text = blobsOf(repository, seam, [plainFile(held, commit).blob]).get(
    held.id,
  );
  const { declaration, sourceRoot, listed } = declared(
    declarationPath,
    commit,
    () => {
      const declaration = declarationOf(utf8TextOf(text));
      const sourceRoot = sourceRootOf(declarationPath, declaration.roots);
      const listed = new Map(
        everyRoot(declaration).map((root) => [
          root,
          listedUnder(entries, sourceRoot, root, commit),
        ]),
      );
      return { declaration, sourceRoot, listed };
    },
  );
  const roots = stampRootsOf(repository, seam, sourceRoot, listed);
  const stampRoot = (path: string): StampRoot =>
    roots.get(path) ?? { path, tree: "", files: [] };
  return {
    commit,
    sourceRoot,
    roots: declaration.roots.map(stampRoot),
    addons: declaration.addons.map((addon) => ({
      ...addon,
      root: stampRoot(addon.root),
    })),
    packages: declaration.packages,
    deadCodeEntries: declaration.deadCodeEntries,
  };
}
