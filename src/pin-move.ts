import type { KernelPin } from "./kernel-pin.ts";
import { git, type KernelSeam, openCommit } from "./kernel-reader.ts";

export type PinRefusalCode =
  | "kernel_commit_unreachable"
  | "kernel_commit_before_carry_out";

const repairs: { readonly [Code in PinRefusalCode]: string } = {
  kernel_commit_unreachable:
    "Give a commit that branch reaches. If the clone is behind, run git fetch origin <branch> there first.",
  kernel_commit_before_carry_out:
    "Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.",
};

export class PinRefusal extends Error {
  readonly repair: string;
  constructor(
    readonly code: PinRefusalCode,
    cause: string,
    branch = "",
  ) {
    const repair = repairs[code].replace("<branch>", branch);
    super(`${cause} Repair: ${repair}`);
    this.repair = repair;
  }
}

// Platform: a clone made by git clone, or by a hosted checkout, holds the
// remote's branch under refs/remotes/origin, and its own copy of the branch
// can lag behind it or be missing. A repository with no remote holds only
// its own branch.
function branchTip(repository: string, branch: string): string | undefined {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const found = git(repository, "rev-parse", [
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (found.ok) return found.stdout.toString().trim();
  }
  return undefined;
}

function isAncestor(repository: string, older: string, newer: string) {
  return git(repository, "merge-base", ["--is-ancestor", older, newer]).ok;
}

// Interface: pin verification. The commit must be reachable from the pin's
// named branch, and the carry-out commit must be that commit or an ancestor
// of it: the kernel repository carries the template's history, so commits
// from before the carry-out are reachable too. It reads git history only,
// never a kernel declaration, so it judges any commit on the branch. It
// refuses by throwing a KernelRefusal for a repository or commit the kernel
// reader cannot open, and a PinRefusal otherwise.
export function verifyPin(
  seam: KernelSeam,
  { branch, carryOutIdentity }: Pick<KernelPin, "branch" | "carryOutIdentity">,
): void {
  const repository = openCommit(seam);
  const { commit } = seam;
  const tip = branchTip(repository, branch);
  if (tip === undefined)
    throw new PinRefusal(
      "kernel_commit_unreachable",
      `The git repository at ${seam.repository} has no branch ${branch}, so commit ${commit} cannot be shown reachable from it.`,
      branch,
    );
  if (!isAncestor(repository, commit, tip))
    throw new PinRefusal(
      "kernel_commit_unreachable",
      `Commit ${commit} is not reachable from branch ${branch} in the git repository at ${seam.repository}.`,
      branch,
    );
  if (!isAncestor(repository, carryOutIdentity, commit))
    throw new PinRefusal(
      "kernel_commit_before_carry_out",
      `Commit ${commit} does not have the carry-out commit ${carryOutIdentity} as an ancestor in the git repository at ${seam.repository}.`,
    );
}
