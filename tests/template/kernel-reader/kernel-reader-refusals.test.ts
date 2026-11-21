import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readKernel } from "../../../src/kernel-reader.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { git, initRepository } from "../../support/git-fixture.ts";
import {
  commitObjects,
  type ObjectEntry,
} from "../../support/git-object-fixture.ts";
import { refusalOf, refused, repairs } from "../../support/kernel-refusal.ts";
import {
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const path = declarationPathIn(firstLayout);

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

  test("a path that is a file", () => {
    const { commit } = small();
    const repository = join(folder("kernel-reader-refusals-"), "a-file");
    write(repository, "", "not a folder\n");
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_repository_missing",
        `No git repository is at ${repository}: that path is not a folder.`,
        repairs.repository,
      ),
    );
  });

  test("the identity of a tag, which is not a commit", () => {
    const { repository, commit } = small();
    git(repository, "tag", "-a", "v1", "-m", "a tag", commit);
    const tag = git(repository, "rev-parse", "v1");
    expect(tag).not.toBe(commit);
    expect(
      refusalOf(() => readKernel({ repository, commit: tag }, path)),
    ).toEqual(
      refused(
        "kernel_commit_missing",
        `${tag} names a tag, not a commit, in the git repository at ${repository}.`,
        repairs.commit,
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

  test("an identity that is not 40 characters: 39, 41 and git's short form are refused, 40 are read", () => {
    const { repository, commit } = small();
    expect(readKernel({ repository, commit }, path).commit).toBe(commit);
    for (const given of [
      commit.slice(0, 39),
      `${commit}0`,
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
        repairs.declarationMissing,
      ),
    );
  });
});

describe("the kernel reader refuses a kernel root, with its repair line, that holds", () => {
  test("a symbolic link", () => {
    const { repository, commit } = withEntries({
      path: "engine/lib/core/link.ts",
      bytes: "index.ts",
      mode: "120000",
    });
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_entry_unsupported",
        `engine/lib/core/link.ts in commit ${commit} is a symbolic link, and a kernel root holds plain files only.`,
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
        `engine/lib/extras/beta/vendored in commit ${commit} is a submodule, and a kernel root holds plain files only.`,
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

  test("nothing of the kind when the link, the submodule and the colliding path sit outside every kernel root", () => {
    const { repository, commit } = withEntries(
      { path: "docs/link.md", bytes: "../README.md", mode: "120000" },
      { path: "engine/vendored", submodule: "1".repeat(40) },
      { path: "readme.md", bytes: "Collides with README.md.\n" },
    );
    expect(readKernel({ repository, commit }, path).commit).toBe(commit);
  });
});
