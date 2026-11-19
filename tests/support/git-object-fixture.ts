import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitOutput } from "./git-fixture.ts";

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
      const [facts = "", path = ""] = line.split("\t");
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
