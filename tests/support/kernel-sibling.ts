import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../../src/cli-error.ts";
import { readKernelPin, siblingKernelPath } from "../../src/kernel-pin.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { git, gitOutput } from "./git-fixture.ts";
import { gitWithInput } from "./git-object-fixture.ts";

const pinnedCommit = readKernelPin(ROOT).commit;

export const trialBase = "426e5dbdb09fada8950f3aaea3b5204f1da40907";

export const templateCommitHoldingS5 =
  "77ebdeafb1f49d0b32307b3ead7273d265ad4918";

export const absentCommit = "0123456789abcdef0123456789abcdef01234567";

export function siblingKernel(
  root = ROOT,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const named = environment.KERNEL_REPOSITORY;
  if (named !== undefined && named !== "") return named;
  const pin = readKernelPin(root);
  const objects = git(
    root,
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  );
  const places = [
    ...new Set(
      [root, dirname(objects)].map((at) => siblingKernelPath(at, pin)),
    ),
  ];
  const found = places.find((place) => existsSync(place));
  if (found !== undefined) return found;
  throw new CliError(
    "kernel_repository_missing",
    `No kernel repository is at ${places.join(" or ")}.`,
    `clone ${pin.remote} beside the template, or name its path in KERNEL_REPOSITORY`,
    1,
    false,
  );
}

export function kernelClone(folder: string, mainAt = pinnedCommit): string {
  mkdirSync(folder, { recursive: true });
  git(folder, "clone", "--quiet", "--no-checkout", siblingKernel(), "kernel");
  const root = join(folder, "kernel");
  git(root, "remote", "remove", "origin");
  git(root, "update-ref", "refs/heads/main", mainAt);
  git(root, "symbolic-ref", "HEAD", "refs/heads/main");
  return root;
}

export function kernelCheckout(folder: string, commit = pinnedCommit): void {
  git(
    dirname(folder),
    "clone",
    "--quiet",
    "--shared",
    "--no-checkout",
    siblingKernel(),
    folder,
  );
  git(folder, "checkout", "--quiet", "--detach", commit);
}

export type TopLevelEdit = {
  readonly files?: Readonly<Record<string, string>>;
  readonly rename?: readonly [from: string, to: string];
  readonly remove?: readonly string[];
};

export function commitOn(
  root: string,
  parents: readonly [string, ...string[]],
  subject: string,
  { files = {}, rename, remove = [] }: TopLevelEdit = {},
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
  for (const name of remove) {
    if (!entries.delete(name))
      throw new Error(`${parents[0]} has no top-level entry ${name}.`);
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
