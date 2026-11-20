import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { readKernelPin, siblingKernelPath } from "../../src/kernel-pin.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { git, gitOutput } from "./git-fixture.ts";
import { gitWithInput } from "./git-object-fixture.ts";

const pinnedCommit = readKernelPin(ROOT).commit;

// Interface: the kernel commit the kernel trial and pin move tests build on,
// the first a generated repository can install. It stays put when the pin
// moves, so a pin move changes no test.
export const trialBase = "0b64b0e480a77ae6abbd3e671497354309182b42";

// Interface: the real kernel repository the tests read, for a template
// checkout at `root`: KERNEL_REPOSITORY when set, else the kernel repository
// beside the checkout, else the one beside the checkout that git shares its
// objects with, which a worktree, fault replay's among them, has. It throws
// naming KERNEL_REPOSITORY when it finds none.
export function findSiblingKernel(
  root: string,
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const named = environment.KERNEL_REPOSITORY;
  if (named !== undefined && named !== "") return named;
  const pin = readKernelPin(root);
  const shared = git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const places = [
    siblingKernelPath(root, pin),
    siblingKernelPath(dirname(shared), pin),
  ];
  const found = places.find((place) => existsSync(place));
  if (found !== undefined) return found;
  throw new Error(
    `No kernel repository is at ${[...new Set(places)].join(" or ")}. Repair: clone ${pin.remote} beside the template, or name its path in KERNEL_REPOSITORY.`,
  );
}

export function siblingKernel(): string {
  return findSiblingKernel(ROOT, process.env);
}

// Interface: a clone of the sibling kernel repository in `folder`, with no
// remote and no working tree, whose main branch ends at `mainAt`.
export function kernelClone(folder: string, mainAt = pinnedCommit): string {
  mkdirSync(folder, { recursive: true });
  git(folder, "clone", "--quiet", "--no-checkout", siblingKernel(), "kernel");
  const root = join(folder, "kernel");
  git(root, "remote", "remove", "origin");
  git(root, "update-ref", "refs/heads/main", mainAt);
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  return root;
}

export type TopLevelEdit = {
  readonly files?: Readonly<Record<string, string>>;
  readonly rename?: readonly [from: string, to: string];
};

// Interface: a new commit whose tree is the first parent's with top-level
// entries replaced or renamed, made with git's plumbing so the clone needs
// no working tree. It moves no branch.
export function commitOn(
  root: string,
  parents: readonly [string, ...string[]],
  subject: string,
  { files = {}, rename }: TopLevelEdit = {},
): string {
  const entries = new Map(
    git(root, "ls-tree", parents[0])
      .split("\n")
      .map((line) => {
        const tab = line.indexOf("\t");
        return [line.slice(tab + 1), line.slice(0, tab)] as const;
      }),
  );
  if (rename !== undefined) {
    const [from, to] = rename;
    entries.set(to, entries.get(from) ?? "");
    entries.delete(from);
  }
  for (const [name, text] of Object.entries(files))
    entries.set(
      name,
      `100644 blob ${gitWithInput(root, text, "hash-object", "-w", "--stdin")}`,
    );
  const tree = gitWithInput(
    root,
    [...entries].map(([name, facts]) => `${facts}\t${name}\n`).join(""),
    "mktree",
  );
  return git(
    root,
    "commit-tree",
    tree,
    ...parents.flatMap((parent) => ["-p", parent]),
    "-m",
    subject,
  );
}

export function moveBranch(root: string, branch: string, commit: string) {
  git(root, "update-ref", `refs/heads/${branch}`, commit);
}

export function fileAt(root: string, commit: string, path: string): string {
  return gitOutput(root, "show", `${commit}:${path}`);
}
