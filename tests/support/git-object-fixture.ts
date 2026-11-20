import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitEnv, gitOutput, inherited } from "./git-fixture.ts";

export type ObjectEntry =
  | {
      readonly path: string;
      readonly bytes: string | Uint8Array;
      readonly mode?: "100644" | "100755" | "120000";
    }
  | { readonly path: string; readonly submodule: string }
  | { readonly path: string; readonly removed: true };

export type ListedFile = {
  readonly path: string;
  readonly mode: string;
  readonly blob: string;
};

function cacheInfo(root: string, entry: ObjectEntry): string {
  if ("submodule" in entry) return `160000,${entry.submodule},${entry.path}`;
  if (!("bytes" in entry)) throw new Error(`${entry.path} holds no bytes.`);
  writeFileSync(join(root, ".git/fixture-blob"), entry.bytes);
  const blob = git(
    root,
    "hash-object",
    "-w",
    "--no-filters",
    ".git/fixture-blob",
  );
  return `${entry.mode ?? "100644"},${blob},${entry.path}`;
}

// Interface: commits the entries as git objects through the index alone, so a
// path the host's file system could not hold (two names that differ only in
// case, a symbolic link, a submodule) still reaches the commit. The working
// tree is left as it was. Returns the full commit.
export function commitObjects(
  root: string,
  subject: string,
  entries: readonly ObjectEntry[],
): string {
  for (const entry of entries)
    if ("removed" in entry)
      git(root, "update-index", "--force-remove", "--", entry.path);
    else
      git(root, "update-index", "--add", "--cacheinfo", cacheInfo(root, entry));
  git(root, "commit", "--quiet", "--allow-empty", "-m", subject);
  return git(root, "rev-parse", "HEAD");
}

export function listedFiles(root: string, commit: string): ListedFile[] {
  return gitOutput(root, "ls-tree", "-r", "-z", "--full-tree", commit)
    .split("\0")
    .filter((line) => line !== "")
    .map((line) => {
      const tab = line.indexOf("\t");
      const facts = line.slice(0, tab);
      const path = line.slice(tab + 1);
      const [mode = "", , blob = ""] = facts.split(" ");
      return { path, mode, blob };
    });
}

export function treeOf(root: string, commit: string, folder: string): string {
  return git(
    root,
    "rev-parse",
    folder === "" ? `${commit}^{tree}` : `${commit}:${folder}`,
  );
}

export function gitWithInput(
  root: string,
  input: string | Uint8Array,
  ...args: string[]
): string {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...inherited(), ...gitEnv },
    stdin: Buffer.from(input),
    stdout: "pipe",
    stderr: "pipe",
    timeout: 4_000,
    killSignal: "SIGKILL",
  });
  if (run.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${run.stderr.toString()}`);
  return run.stdout.toString().trim();
}

// Interface: stages one file whose path is given as raw bytes, so a name that
// is not UTF-8 text, or that holds a line feed, reaches the next commit. Only
// git's own index reader takes such a path: a process argument is always text.
export function stageRawPath(
  root: string,
  rawPath: Uint8Array,
  bytes: string,
): void {
  const [mode = "", blob = ""] = cacheInfo(root, { path: "", bytes }).split(
    ",",
  );
  gitWithInput(
    root,
    Buffer.concat([
      Buffer.from(`${mode} ${blob}\t`),
      rawPath,
      Buffer.from([0]),
    ]),
    "update-index",
    "-z",
    "--index-info",
  );
}

function treeWith(
  root: string,
  tree: string,
  [name = "", ...deeper]: readonly string[],
  added: string,
): string {
  const kept = gitOutput(root, "ls-tree", tree)
    .split("\n")
    .filter((line) => line !== "" && !line.endsWith(`\t${name}`));
  const child =
    deeper.length === 0
      ? added
      : treeWith(
          root,
          git(root, "rev-parse", `${tree}:${name}`),
          deeper,
          added,
        );
  return gitWithInput(
    root,
    `${[...kept, `040000 tree ${child}\t${name}`].join("\n")}\n`,
    "mktree",
  );
}

// Interface: a new commit on top of `commit` whose tree holds one more entry,
// an empty folder at `folder`. Only git's plumbing can make one: the index
// and a working tree hold files, never an empty folder.
export function commitEmptyFolder(
  root: string,
  commit: string,
  folder: string,
): string {
  const tree = treeWith(
    root,
    git(root, "rev-parse", `${commit}^{tree}`),
    folder.split("/"),
    gitWithInput(root, "", "mktree"),
  );
  return git(root, "commit-tree", tree, "-p", commit, "-m", "an empty folder");
}
