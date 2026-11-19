import { existsSync, realpathSync } from "node:fs";
import { dirname } from "node:path";
import {
  type FileMode,
  fieldsOf,
  listOf,
  type StampedFile,
  textOf,
  treeIdentity,
} from "./stamp-check.ts";

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
    "Fetch that commit into the clone with `git fetch origin <commit>`, then run this again.",
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
    cause: string,
  ) {
    super(`${cause} Repair: ${repairs[code]}`);
    this.repair = repairs[code];
  }
}

type Entry = {
  readonly path: string;
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

const gitMilliseconds = 10_000;
const fullCommit = /^[0-9a-f]{40}$/;
const linkKinds = new Map([
  ["120000", "a symbolic link"],
  ["160000", "a submodule"],
]);

// Platform: git reads objects only through rev-parse, ls-tree and cat-file
// here, none of which reads the working tree or the network. The environment
// holds nothing of the caller's but PATH: a replace ref cannot swap an object,
// a partial clone cannot fetch one, no prompt can open, no configuration file
// outside the repository applies, and git looks for the repository in the
// given folder alone, never in a folder above it.
function git(
  repository: string,
  command: "rev-parse" | "ls-tree" | "cat-file",
  args: readonly string[],
  stdin?: Uint8Array,
) {
  const result = Bun.spawnSync(["git", command, ...args], {
    cwd: repository,
    env: {
      PATH: process.env.PATH ?? "",
      GIT_CEILING_DIRECTORIES: dirname(repository),
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_NO_LAZY_FETCH: "1",
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
  const repository = realpathSync(path);
  const format = git(repository, "rev-parse", ["--show-object-format"]);
  if (!format.ok) throw missing(`git says "${format.said}".`);
  const name = format.stdout.toString().trim();
  if (name !== "sha1")
    throw new KernelRefusal(
      "kernel_object_format_unsupported",
      `The git repository at ${path} uses the ${name} object format, and the kernel reader reads sha1 only.`,
    );
  return repository;
}

function entriesAt(repository: string, commit: string): Entry[] {
  const listing = git(repository, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    commit,
  ]);
  if (!listing.ok)
    throw new Error(`git could not list commit ${commit}: ${listing.said}`);
  return listing.stdout
    .toString()
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const [mode = "", , id = ""] = line.slice(0, tab).split(" ");
      return { path: line.slice(tab + 1), mode, id };
    });
}

function blobsOf(
  repository: string,
  ids: readonly string[],
): Map<string, Uint8Array> {
  const batch = git(
    repository,
    "cat-file",
    ["--batch"],
    Buffer.from(ids.map((id) => `${id}\n`).join("")),
  );
  const blobs = new Map<string, Uint8Array>();
  let at = 0;
  for (const id of ids) {
    const lineEnd = batch.stdout.indexOf(10, at);
    const [, kind, size] = batch.stdout
      .subarray(at, lineEnd)
      .toString()
      .split(" ");
    if (!batch.ok || lineEnd < 0 || kind !== "blob")
      throw new KernelRefusal(
        "kernel_commit_missing",
        `File object ${id} is not in the git repository at ${repository}.`,
      );
    const end = lineEnd + 1 + Number(size);
    blobs.set(id, new Uint8Array(batch.stdout.subarray(lineEnd + 1, end)));
    at = end + 1;
  }
  return blobs;
}

function plainFile({ path, mode, id }: Entry, commit: string): StampedFile {
  if (mode !== "100644" && mode !== "100755")
    throw new KernelRefusal(
      "kernel_entry_unsupported",
      `${path} in commit ${commit} is ${linkKinds.get(mode) ?? `an entry of git mode ${mode}`}, and a stamp root holds plain files only.`,
    );
  const plain: FileMode = mode;
  return { path, mode: plain, blob: id };
}

function plainPath(value: unknown, where: string): string {
  const path = textOf(value, where);
  if (path.split("/").some((part) => ["", ".", ".."].includes(part)))
    throw new Error(
      `${where} is "${path}", which is not a plain path: it has an empty, "." or ".." part.`,
    );
  return path;
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

function declarationOf(text: string): Declaration {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `it is not JSON (${String(Reflect.get(Object(error), "message"))}).`,
      { cause: error },
    );
  }
  const file = fieldsOf(parsed, "the file");
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
  checkRoots([...roots, ...addons.map(({ root }) => root)]);
  return { roots, addons, ...requirementsOf(base, "base") };
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
  const strip = sourceRoot === "" ? 0 : sourceRoot.length + 1;
  const listed = entries
    .filter((entry) => entry.path.slice(strip).startsWith(`${root}/`))
    .filter((entry) => strip === 0 || entry.path.startsWith(`${sourceRoot}/`))
    .map((entry) => {
      const file = plainFile(entry, commit);
      return { entry, file: { ...file, path: entry.path.slice(strip) } };
    });
  if (listed.length === 0)
    throw new Error(
      `it declares stamp root "${root}", which holds no file in that commit.`,
    );
  return listed;
}

function refuseCollisions(listed: readonly Listed[], commit: string): void {
  const seen = new Map<string, string>();
  for (const { entry } of listed) {
    const folded = entry.path.normalize("NFC").toLowerCase();
    const earlier = seen.get(folded);
    if (earlier !== undefined)
      throw new KernelRefusal(
        "kernel_entry_unsupported",
        `${earlier} and ${entry.path} in commit ${commit} differ only in letter case or Unicode form, so one would replace the other where file names ignore that.`,
      );
    seen.set(folded, entry.path);
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
      `The kernel declaration at ${declarationPath} in commit ${commit} is not valid: ${String(Reflect.get(Object(error), "message"))}`,
    );
  }
}

// Interface: reads the kernel at one full commit from the git objects of the
// repository at a local path, and never from its working tree, so the
// repository may sit on another commit with edits in progress. It reads the
// kernel declaration at `declarationPath` in that commit and takes every
// other path from it. Each file's `path` is the one it will have in a
// generated repository: its path in the kernel repository with `sourceRoot`
// removed. It throws a KernelRefusal, whose message ends with its repair
// line, before returning anything. No network, no cache, no credential.
export function readKernel(
  seam: KernelSeam,
  declarationPath: string = kernelDeclarationPath,
): Kernel {
  const { commit } = seam;
  if (!fullCommit.test(commit))
    throw new KernelRefusal(
      "kernel_commit_abbreviated",
      `"${commit}" is not a full commit identity, which is 40 lowercase hexadecimal characters.`,
    );
  const repository = repositoryAt(seam.repository);
  if (!git(repository, "cat-file", ["-e", `${commit}^{commit}`]).ok)
    throw new KernelRefusal(
      "kernel_commit_missing",
      `Commit ${commit} is not in the git repository at ${seam.repository}.`,
    );
  const entries = entriesAt(repository, commit);
  const held = entries.find(({ path }) => path === declarationPath);
  if (held === undefined)
    throw new KernelRefusal(
      "kernel_declaration_missing",
      `Commit ${commit} holds no kernel declaration at ${declarationPath}.`,
    );
  const text = blobsOf(repository, [plainFile(held, commit).blob]).get(held.id);
  const { declaration, sourceRoot, listed } = declared(
    declarationPath,
    commit,
    () => {
      const declaration = declarationOf(new TextDecoder().decode(text));
      const sourceRoot = sourceRootOf(declarationPath, declaration.roots);
      const paths = [
        ...declaration.roots,
        ...declaration.addons.map(({ root }) => root),
      ];
      const listed = new Map(
        paths.map((root) => [
          root,
          listedUnder(entries, sourceRoot, root, commit),
        ]),
      );
      return { declaration, sourceRoot, listed };
    },
  );
  const every = [...listed.values()].flat();
  refuseCollisions(every, commit);
  const blobs = blobsOf(
    repository,
    every.map(({ file }) => file.blob),
  );
  const stampRoot = (path: string): StampRoot => {
    const files = (listed.get(path) ?? []).map(({ file }) => ({
      ...file,
      bytes: blobs.get(file.blob) ?? new Uint8Array(),
    }));
    return { path, tree: treeIdentity(files, path), files };
  };
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
