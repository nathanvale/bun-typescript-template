import { describe, expect, test } from "bun:test";
import { readKernel } from "../../../src/kernel-reader.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { initRepository } from "../../support/git-fixture.ts";
import {
  commitObjects,
  type ObjectEntry,
  stageRawPath,
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

function withEntries(...extra: ObjectEntry[]) {
  const repository = folder("kernel-reader-entries-");
  const commit = kernelRepository(repository, [...kernelEntries(), ...extra]);
  return { repository, commit };
}

function collision(earlier: string, later: string, commit: string) {
  return refused(
    "kernel_entry_unsupported",
    `${earlier} and ${later} in commit ${commit} differ only in letter case or Unicode form, so one would replace the other where file names ignore that.`,
    repairs.entry,
  );
}

describe("the kernel reader refuses a kernel root, with its repair line, that holds", () => {
  test("two folders that differ only in letter case", () => {
    const { repository, commit } = withEntries({
      path: "engine/lib/core/Deep/other.ts",
      bytes: "export const other = 1;\n",
    });
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      collision("engine/lib/core/Deep", "engine/lib/core/deep", commit),
    );
  });

  test("a file and a folder that differ only in letter case", () => {
    const { repository, commit } = withEntries({
      path: "engine/lib/core/DEEP",
      bytes: "a file named as the folder is\n",
    });
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      collision("engine/lib/core/DEEP", "engine/lib/core/deep", commit),
    );
  });

  test("two names that differ only in Unicode form", () => {
    const composed = "engine/lib/core/caf\u00e9.ts";
    const decomposed = "engine/lib/core/cafe\u0301.ts";
    expect(composed).not.toBe(decomposed);
    const repository = folder("kernel-reader-entries-");
    initRepository(repository);
    stageRawPath(
      repository,
      Buffer.from(decomposed),
      "export const two = 2;\n",
    );
    const commit = commitObjects(repository, "two Unicode forms", [
      ...kernelEntries(),
      { path: composed, bytes: "export const one = 1;\n" },
    ]);
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      collision(decomposed, composed, commit),
    );
  });

  test("a file whose name is not UTF-8 text", () => {
    const repository = folder("kernel-reader-entries-");
    initRepository(repository);
    stageRawPath(
      repository,
      Buffer.concat([
        Buffer.from("engine/lib/core/caf"),
        Buffer.from([0xe9]),
        Buffer.from(".ts"),
      ]),
      "export const latin = 1;\n",
    );
    const commit = commitObjects(repository, "a latin-1 name", kernelEntries());
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_entry_unsupported",
        `engine/lib/core/caf�.ts in commit ${commit} has a name that is not UTF-8 text, and a kernel root holds files with UTF-8 names only.`,
        repairs.entry,
      ),
    );
  });
});

describe("the kernel reader takes a kernel root's files", () => {
  test("from the kernel's source folder alone, not from a folder whose name is as long", () => {
    const { repository, commit } = withEntries({
      path: "vendor/lib/core/stray.ts",
      bytes: "export const stray = 1;\n",
    });
    expect("vendor").toHaveLength(firstLayout.sourceRoot.length);
    const [core] = readKernel({ repository, commit }, path).roots;
    expect(core?.files.map((file) => file.path)).toEqual([
      "lib/core/deep/leaf.ts",
      "lib/core/index.ts",
      "lib/core/run.sh",
    ]);
  });
});
