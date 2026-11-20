import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../src/kernel-pin.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { git } from "./git-fixture.ts";

const pinnedCommit = readKernelPin(ROOT).commit;

// Interface: the kernel commit tests build on, the first a generated
// repository can install. It stays put when the pin moves, so a pin move
// changes no test.
export const trialBase = "0b64b0e480a77ae6abbd3e671497354309182b42";

// Interface: the real kernel repository the tests read. The hosted check
// places it beside the template; a checkout elsewhere, such as a worktree,
// names it in KERNEL_REPOSITORY.
function siblingKernel(): string {
  return (
    process.env.KERNEL_REPOSITORY ??
    join(ROOT, "..", readKernelPin(ROOT).repository)
  );
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
