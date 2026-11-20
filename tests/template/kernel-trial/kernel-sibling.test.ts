import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";
import { findSiblingKernel } from "../../support/kernel-sibling.ts";

const folder = ownedFolders();
const { repository, remote } = readKernelPin(ROOT);

function templateIn(parent: string): string {
  const root = join(parent, "template");
  initRepository(root);
  commitIn(root, "the kernel pin", {
    [kernelPinFile]: readFileSync(join(ROOT, kernelPinFile), "utf8"),
  });
  return root;
}

describe("the tests find the kernel repository", () => {
  test("at KERNEL_REPOSITORY when it is set", () => {
    const root = templateIn(folder("kernel-sibling-"));
    expect(findSiblingKernel(root, { KERNEL_REPOSITORY: "/some/kernel" })).toBe(
      "/some/kernel",
    );
  });

  test("beside the template checkout", () => {
    const parent = folder("kernel-sibling-");
    const root = templateIn(parent);
    mkdirSync(join(parent, repository));
    expect(findSiblingKernel(root, {})).toBe(join(parent, repository));
  });

  test("from a worktree elsewhere, beside the checkout git shares its objects with", () => {
    const parent = folder("kernel-sibling-");
    const root = templateIn(parent);
    mkdirSync(join(parent, repository));
    const worktree = join(folder("kernel-sibling-worktree-"), "replay");
    git(root, "worktree", "add", "--quiet", "--detach", worktree);
    expect(findSiblingKernel(worktree, {})).toBe(join(parent, repository));
  });

  test("nowhere, and refuses naming KERNEL_REPOSITORY", () => {
    const parent = folder("kernel-sibling-");
    const root = templateIn(parent);
    expect(() => findSiblingKernel(root, {})).toThrow(
      `No kernel repository is at ${join(parent, repository)}. Repair: clone ${remote} beside the template, or name its path in KERNEL_REPOSITORY.`,
    );
  });
});
