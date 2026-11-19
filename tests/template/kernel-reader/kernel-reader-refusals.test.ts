import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  KernelRefusal,
  type KernelRefusalCode,
  readKernel,
} from "../../../src/kernel-reader.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, initRepository } from "../../support/git-fixture.ts";
import {
  commitObjects,
  type ObjectEntry,
} from "../../support/git-object-fixture.ts";
import {
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const path = declarationPathIn(firstLayout);

const repairs = {
  repository:
    "Put a clone of the kernel repository at that path, or give the path of one that is there.",
  abbreviated:
    "Give the commit's full identity, as `git rev-parse <commit>` prints it in the kernel repository.",
  commit:
    "Fetch that commit into the clone with `git fetch origin <commit>`, then run this again.",
  format: "Give a kernel repository that uses git's sha1 object format.",
  declaration:
    "Give a commit that holds the kernel declaration, or the path the kernel declaration has at that commit.",
  entry:
    "Make that entry a plain file with its own name in the kernel repository, then give the commit that holds the change.",
};

function refusalOf(read: () => unknown) {
  try {
    read();
  } catch (error) {
    if (!(error instanceof KernelRefusal)) throw error;
    return { code: error.code, message: error.message, repair: error.repair };
  }
  throw new Error("The read was not refused.");
}

function refused(code: KernelRefusalCode, cause: string, repair: string) {
  return { code, message: `${cause} Repair: ${repair}`, repair };
}

function small() {
  const repository = folder("kernel-reader-refusals-");
  return { repository, commit: kernelRepository(repository) };
}

function withEntries(...extra: ObjectEntry[]) {
  const repository = folder("kernel-reader-refusals-");
  const commit = kernelRepository(repository, [...kernelEntries(), ...extra]);
  return { repository, commit };
}

describe("the kernel reader refuses, with its repair line", () => {
  test("a path that does not exist", () => {
    const { commit } = small();
    const repository = join(folder("kernel-reader-refusals-"), "absent");
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_repository_missing",
        `No git repository is at ${repository}: that path does not exist.`,
        repairs.repository,
      ),
    );
  });

  test("a folder that is not a repository, even inside a repository that holds the commit", () => {
    const outer = small();
    const repository = join(outer.repository, "not-a-repository");
    mkdirSync(repository);
    expect(readKernel(outer, path).commit).toBe(outer.commit);
    const refusal = refusalOf(() =>
      readKernel({ repository, commit: outer.commit }, path),
    );
    expect(refusal.message).toStartWith(
      `No git repository is at ${repository}: git says "fatal: not a git repository`,
    );
    expect(refusal.message).toEndWith(` Repair: ${repairs.repository}`);
    expect({ code: refusal.code, repair: refusal.repair }).toEqual({
      code: "kernel_repository_missing",
      repair: repairs.repository,
    });
  });

  test("an abbreviated commit: 39 characters and git's short form are refused, 40 are read", () => {
    const { repository, commit } = small();
    expect(readKernel({ repository, commit }, path).commit).toBe(commit);
    for (const given of [
      commit.slice(0, 39),
      git(repository, "rev-parse", "--short", commit),
    ])
      expect(
        refusalOf(() => readKernel({ repository, commit: given }, path)),
      ).toEqual(
        refused(
          "kernel_commit_abbreviated",
          `"${given}" is not a full commit identity, which is 40 lowercase hexadecimal characters.`,
          repairs.abbreviated,
        ),
      );
  });

  test("a commit that a clone lacks because no branch or tag reaches it", () => {
    const { repository, commit } = small();
    const unreached = commitObjects(repository, "no ref reaches this", [
      { path: "README.md", bytes: "Changed.\n" },
    ]);
    git(repository, "update-ref", "refs/heads/main", commit);
    const clone = join(folder("kernel-reader-refusals-"), "clone");
    git(repository, "clone", "--quiet", "--no-local", repository, clone);
    expect(readKernel({ repository, commit: unreached }, path).commit).toBe(
      unreached,
    );
    expect(readKernel({ repository: clone, commit }, path).commit).toBe(commit);
    expect(
      refusalOf(() =>
        readKernel({ repository: clone, commit: unreached }, path),
      ),
    ).toEqual(
      refused(
        "kernel_commit_missing",
        `Commit ${unreached} is not in the git repository at ${clone}.`,
        repairs.commit,
      ),
    );
  });

  test("a repository in the sha256 object format, given the first 40 characters of its commit", () => {
    const repository = folder("kernel-reader-refusals-");
    git(repository, "init", "--quiet", "--object-format=sha256");
    const commit = commitObjects(repository, "sha256", kernelEntries());
    expect(commit).toHaveLength(64);
    expect(
      refusalOf(() =>
        readKernel({ repository, commit: commit.slice(0, 40) }, path),
      ),
    ).toEqual(
      refused(
        "kernel_object_format_unsupported",
        `The git repository at ${repository} uses the sha256 object format, and the kernel reader reads sha1 only.`,
        repairs.format,
      ),
    );
  });

  test("a commit that holds no kernel declaration", () => {
    const repository = folder("kernel-reader-refusals-");
    initRepository(repository);
    const before = commitObjects(repository, "before the declaration", [
      { path: "README.md", bytes: "No kernel declaration yet.\n" },
    ]);
    const after = commitObjects(repository, "the kernel", kernelEntries());
    expect(readKernel({ repository, commit: after }, path).commit).toBe(after);
    expect(
      refusalOf(() => readKernel({ repository, commit: before }, path)),
    ).toEqual(
      refused(
        "kernel_declaration_missing",
        `Commit ${before} holds no kernel declaration at ${path}.`,
        repairs.declaration,
      ),
    );
  });
});

describe("the kernel reader refuses a stamp root, with its repair line, that holds", () => {
  test("a symbolic link", () => {
    const { repository, commit } = withEntries({
      path: "engine/lib/core/link.ts",
      bytes: "index.ts",
      mode: "120000",
    });
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_entry_unsupported",
        `engine/lib/core/link.ts in commit ${commit} is a symbolic link, and a stamp root holds plain files only.`,
        repairs.entry,
      ),
    );
  });

  test("a submodule", () => {
    const { repository, commit } = withEntries({
      path: "engine/lib/extras/beta/vendored",
      submodule: "1".repeat(40),
    });
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_entry_unsupported",
        `engine/lib/extras/beta/vendored in commit ${commit} is a submodule, and a stamp root holds plain files only.`,
        repairs.entry,
      ),
    );
  });

  test("two paths that differ only in letter case", () => {
    const { repository, commit } = withEntries({
      path: "engine/lib/core/Index.ts",
      bytes: "export const collides = 1;\n",
    });
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_entry_unsupported",
        `engine/lib/core/Index.ts and engine/lib/core/index.ts in commit ${commit} differ only in letter case or Unicode form, so one would replace the other where file names ignore that.`,
        repairs.entry,
      ),
    );
  });

  test("nothing of the kind when the link, the submodule and the colliding path sit outside every stamp root", () => {
    const { repository, commit } = withEntries(
      { path: "docs/link.md", bytes: "../README.md", mode: "120000" },
      { path: "engine/vendored", submodule: "1".repeat(40) },
      { path: "readme.md", bytes: "Collides with README.md.\n" },
    );
    expect(readKernel({ repository, commit }, path).commit).toBe(commit);
  });
});
