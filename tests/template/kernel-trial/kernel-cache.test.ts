import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import {
  findSiblingKernel,
  kernelCachePath,
  kernelPinFile,
  readKernelPin,
} from "../../../src/kernel-pin.ts";
import { readKernel } from "../../../src/kernel-reader.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";
import { commitObjects } from "../../support/git-object-fixture.ts";
import {
  bareRemote,
  commitBytes,
  holds,
  kernelCacheEnv,
  replaceObject,
  unpackObjects,
} from "../../support/kernel-cache-fixture.ts";
import { refusalOf, refused, repairs } from "../../support/kernel-refusal.ts";
import {
  declarationPathIn,
  firstLayout,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const { repository: kernelName, remote } = readKernelPin(ROOT);
const declarationPath = declarationPathIn(firstLayout);

function templatePinnedAt(commit: string): string {
  const root = join(folder("kernel-cache-template-"), "template");
  initRepository(root);
  commitIn(root, "the kernel pin", {
    [kernelPinFile]: `${JSON.stringify({ ...readKernelPin(ROOT), commit }, null, 2)}\n`,
  });
  return root;
}

function smallRemote() {
  const source = folder("kernel-cache-source-");
  const commit = kernelRepository(source);
  const bare = bareRemote(folder("kernel-cache-remote-"), source, commit);
  const env = kernelCacheEnv(bare, folder("kernel-cache-home-"));
  return { source, bare, commit, env, cache: kernelCachePath(env) };
}

function cliRefusalOf(work: () => unknown) {
  try {
    work();
  } catch (error) {
    if (error instanceof CliError)
      return { code: error.code, message: error.message, repair: error.repair };
    throw error;
  }
  return "no refusal";
}

function missingRepair(cache: string): string {
  return `clone ${remote} beside the template, or name a clone's path in KERNEL_REPOSITORY, or rerun once git can reach ${remote} to fill the kernel cache at ${cache}`;
}

describe("with neither KERNEL_REPOSITORY nor a sibling repository, Bootstrap and a Template upgrade find the kernel in the kernel cache", () => {
  test("the cache sits at my-agent-dojo/bun-typescript-template/agent-cli-kernel.git under XDG_CACHE_HOME when it is set, and under ~/.cache otherwise", () => {
    expect(
      kernelCachePath({ XDG_CACHE_HOME: "/x/cache", HOME: "/x/home" }),
    ).toBe(
      "/x/cache/my-agent-dojo/bun-typescript-template/agent-cli-kernel.git",
    );
    expect(kernelCachePath({ HOME: "/x/home" })).toBe(
      "/x/home/.cache/my-agent-dojo/bun-typescript-template/agent-cli-kernel.git",
    );
    expect(kernelCachePath({ XDG_CACHE_HOME: "", HOME: "/x/home" })).toBe(
      "/x/home/.cache/my-agent-dojo/bun-typescript-template/agent-cli-kernel.git",
    );
  });

  test("an empty cache is filled with a bare clone of the pin's remote that holds the pinned commit", () => {
    const { commit, env, cache } = smallRemote();
    const root = templatePinnedAt(commit);
    expect(existsSync(join(dirname(root), kernelName))).toBe(false);
    expect(findSiblingKernel(root, env)).toBe(cache);
    expect(git(cache, "rev-parse", "--is-bare-repository")).toBe("true");
    expect(holds(cache, commit)).toBe(true);
    expect(readdirSync(dirname(cache))).toEqual(["agent-cli-kernel.git"]);
  });

  test("a pinned commit the cache lacks is fetched from a branch of the remote, then found", () => {
    const { source, bare, env, cache } = smallRemote();
    const first = git(source, "rev-parse", "HEAD");
    findSiblingKernel(templatePinnedAt(first), env);
    const later = commitObjects(source, "a later kernel", [
      { path: "later.md", bytes: "A later commit.\n" },
    ]);
    git(bare, "fetch", "--quiet", source, `${later}:refs/heads/later`);
    expect(holds(cache, later)).toBe(false);
    expect(findSiblingKernel(templatePinnedAt(later), env)).toBe(cache);
    expect(holds(cache, later)).toBe(true);
  });

  test("a pinned commit that no branch of the remote reaches is refused, naming the commit", () => {
    const { source, bare, commit, env, cache } = smallRemote();
    findSiblingKernel(templatePinnedAt(commit), env);
    const loose = commitObjects(source, "reached by no branch", [
      { path: "loose.md", bytes: "No branch reaches this.\n" },
    ]);
    git(bare, "fetch", "--quiet", source, `${loose}:refs/heads/scratch`);
    git(bare, "update-ref", "-d", "refs/heads/scratch");
    expect(holds(bare, loose)).toBe(true);
    const root = templatePinnedAt(loose);
    expect(cliRefusalOf(() => findSiblingKernel(root, env))).toEqual({
      code: "kernel_repository_missing",
      message: `No kernel repository is at ${join(dirname(root), kernelName)}, and commit ${loose} is in no branch of ${remote}, so the kernel cache at ${cache} does not hold it.`,
      repair: missingRepair(cache),
    });
  });

  test("KERNEL_REPOSITORY wins over the kernel cache, which stays empty", () => {
    const { commit, env, cache } = smallRemote();
    const root = templatePinnedAt(commit);
    expect(
      findSiblingKernel(root, { ...env, KERNEL_REPOSITORY: "/some/kernel" }),
    ).toBe("/some/kernel");
    expect(existsSync(dirname(cache))).toBe(false);
  });

  test("a sibling repository wins over the kernel cache, which stays empty", () => {
    const { commit, env, cache } = smallRemote();
    const root = templatePinnedAt(commit);
    mkdirSync(join(dirname(root), kernelName));
    expect(findSiblingKernel(root, env)).toBe(join(dirname(root), kernelName));
    expect(existsSync(dirname(cache))).toBe(false);
  });
});

test("the kernel reader refuses a kernel cache whose pinned commit is replaced by another commit's bytes, as git finds the hash mismatch", () => {
  const { source, commit, env, cache } = smallRemote();
  const other = commitObjects(source, "another commit", [
    { path: "other.md", bytes: "Another commit.\n" },
  ]);
  const root = templatePinnedAt(commit);
  expect(findSiblingKernel(root, env)).toBe(cache);
  unpackObjects(cache);
  replaceObject(cache, commit, "commit", commitBytes(source, other));
  expect(findSiblingKernel(root, env)).toBe(cache);
  expect(
    refusalOf(() => readKernel({ repository: cache, commit }, declarationPath)),
  ).toEqual(
    refused(
      "kernel_commit_missing",
      `Commit ${commit} is in the git repository at ${cache}, and its list of files is not: git says "error: hash mismatch ${commit}".`,
      repairs.commit,
    ),
  );
});
