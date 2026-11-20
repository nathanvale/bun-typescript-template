import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import {
  findSiblingKernel,
  kernelPinFile,
  readKernelPin,
} from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";

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

function refusalOf(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (error instanceof CliError)
      return { code: error.code, message: error.message, repair: error.repair };
    throw error;
  }
  return "no refusal";
}

describe("Bootstrap and the tests find the kernel repository", () => {
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

  test("refuses, naming git's words, a checkout git cannot read", () => {
    const root = join(folder("kernel-sibling-"), "template");
    mkdirSync(root);
    writeFileSync(
      join(root, kernelPinFile),
      readFileSync(join(ROOT, kernelPinFile), "utf8"),
    );
    const refusal = refusalOf(() => findSiblingKernel(root, {}));
    expect(refusal).toMatchObject({
      code: "template_git_unreadable",
      repair:
        "run this from a git clone of the template, or name the kernel repository's path in KERNEL_REPOSITORY",
    });
    expect(String(Reflect.get(Object(refusal), "message"))).toStartWith(
      `git cannot say where the checkout at ${root} keeps its objects: git says "fatal: not a git repository`,
    );
  });

  test("nowhere, and refuses naming KERNEL_REPOSITORY", () => {
    const parent = folder("kernel-sibling-");
    const root = templateIn(parent);
    expect(refusalOf(() => findSiblingKernel(root, {}))).toEqual({
      code: "kernel_repository_missing",
      message: `No kernel repository is at ${join(parent, repository)}.`,
      repair: `clone ${remote} beside the template, or name its path in KERNEL_REPOSITORY`,
    });
  });
});
