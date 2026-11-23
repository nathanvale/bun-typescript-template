import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import {
  findSiblingKernel,
  kernelCachePath,
  kernelPinFile,
  readKernelPin,
} from "../../../src/kernel-pin.ts";
import { invokeIn, ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";
import { kernelCacheEnv } from "../../support/kernel-cache-fixture.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { cloneTemplateAtHead } from "../../support/template-upgrade-fixture.ts";

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

describe("Bootstrap and a Template upgrade find the kernel repository", () => {
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

  test("nowhere, the kernel cache included, when the remote is unreachable, and refuses naming both manual routes and the cache it tried", () => {
    const parent = folder("kernel-sibling-");
    const root = templateIn(parent);
    const env = kernelCacheEnv(
      join(folder("kernel-sibling-remote-"), "absent.git"),
      folder("kernel-sibling-cache-"),
    );
    const cache = kernelCachePath(env);
    const refusal = refusalOf(() => findSiblingKernel(root, env));
    expect(refusal).toMatchObject({
      code: "kernel_repository_missing",
      repair: `clone ${remote} beside the template, or name a clone's path in KERNEL_REPOSITORY, or rerun once git can reach ${remote} to fill the kernel cache at ${cache}`,
    });
    expect(String(Reflect.get(Object(refusal), "message"))).toStartWith(
      `No kernel repository is at ${join(parent, repository)}, and git could not clone ${remote} into the kernel cache at ${cache}: git says "fatal: `,
    );
    expect(existsSync(dirname(cache))).toBe(true);
    expect(readdirSync(dirname(cache))).toEqual([]);
  });
});

function emptyHomeEnv(home: string) {
  return {
    ...kernelCacheEnv(
      join(folder("kernel-sibling-remote-"), "absent.git"),
      home,
    ),
    HOME: home,
  };
}

describe("The tests' kernel lookup", () => {
  test("stops before the kernel cache, refusing as before and writing nothing under HOME or XDG_CACHE_HOME", () => {
    const parent = folder("kernel-sibling-");
    const root = templateIn(parent);
    const home = folder("kernel-sibling-home-");
    const env = emptyHomeEnv(home);
    expect(refusalOf(() => siblingKernel(root, env))).toEqual({
      code: "kernel_repository_missing",
      message: `No kernel repository is at ${join(parent, repository)}.`,
      repair: `clone ${remote} beside the template, or name its path in KERNEL_REPOSITORY`,
    });
    expect(readdirSync(home)).toEqual([]);
  });

  test("keeps a Bootstrap started through invoke off the kernel cache, refusing before it starts and writing nothing under HOME or XDG_CACHE_HOME", async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const home = folder("kernel-sibling-home-");
    const destination = join(folder("kernel-sibling-made-"), "made");
    const refusal = await invokeIn(templateClone, emptyHomeEnv(home), [
      "--destination",
      destination,
      "--source-packet",
      "/abs/packets/demo",
      "--json",
    ]).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(CliError);
    expect(refusal).toMatchObject({
      code: "kernel_repository_missing",
      message: `No kernel repository is at ${join(dirname(templateClone), repository)}.`,
      repair: `clone ${remote} beside the template, or name its path in KERNEL_REPOSITORY`,
    });
    expect(readdirSync(home)).toEqual([]);
    expect(existsSync(destination)).toBe(false);
  });
});
