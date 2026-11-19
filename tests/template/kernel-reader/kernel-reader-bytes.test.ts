import { describe, expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { readKernel } from "../../../src/kernel-reader.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitEmptyFolder,
  listedFiles,
  treeOf,
} from "../../support/git-object-fixture.ts";
import { refusalOf, refused, repairs } from "../../support/kernel-refusal.ts";
import {
  declarationFor,
  declarationPathIn,
  declarationText,
  firstLayout,
  kernelEntries,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const path = declarationPathIn(firstLayout);

describe("the kernel reader reads names and text as the bytes git stores", () => {
  test("a file whose name holds the replacement character itself is read, not refused as a name that is not UTF-8", () => {
    const named = "lib/core/caf�.ts";
    const repository = folder("kernel-reader-bytes-");
    const commit = kernelRepository(repository, [
      ...kernelEntries(),
      { path: `engine/${named}`, bytes: "export const odd = 1;\n" },
    ]);
    const [core] = readKernel({ repository, commit }, path).roots;
    expect(core?.files.map((file) => file.path)).toContain(named);
    expect(core?.tree).toBe(treeOf(repository, commit, "engine/lib/core"));
  });

  test("a kernel declaration with a byte that is not UTF-8 is refused, with its repair line", () => {
    const text = declarationText(declarationFor(firstLayout));
    const cut = text.indexOf("1.3.0");
    const bytes = Buffer.concat([
      Buffer.from(text.slice(0, cut)),
      Buffer.from([0xff]),
      Buffer.from(text.slice(cut)),
    ]);
    const repository = folder("kernel-reader-bytes-");
    const commit = kernelRepository(
      repository,
      kernelEntries(firstLayout, bytes),
    );
    expect(cut).toBeGreaterThan(0);
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_declaration_invalid",
        `The kernel declaration at ${path} in commit ${commit} is not valid: it is not UTF-8 text.`,
        repairs.declaration,
      ),
    );
  });

  test("a stamp root that holds an empty folder, which no list of files shows, is refused with its repair line", () => {
    const repository = folder("kernel-reader-bytes-");
    const whole = kernelRepository(repository);
    const hollow = commitEmptyFolder(
      repository,
      whole,
      "engine/lib/extras/beta/hollow",
    );
    expect(listedFiles(repository, hollow)).toEqual(
      listedFiles(repository, whole),
    );
    expect(treeOf(repository, hollow, "engine/lib/extras/beta")).not.toBe(
      treeOf(repository, whole, "engine/lib/extras/beta"),
    );
    expect(readKernel({ repository, commit: whole }, path).commit).toBe(whole);
    expect(
      refusalOf(() => readKernel({ repository, commit: hollow }, path)),
    ).toEqual(
      refused(
        "kernel_entry_unsupported",
        `engine/lib/extras/beta in commit ${hollow} holds an entry that is not a file, such as an empty folder, and a stamp root holds plain files only.`,
        repairs.entry,
      ),
    );
  });

  test("a folder inside a repository is refused where a colon in the path above it defeats git's own limit on looking upward", () => {
    const repository = join(folder("kernel-reader-bytes-"), "kernel:fixture");
    mkdirSync(repository);
    const commit = kernelRepository(repository);
    const inside = join(repository, "engine");
    mkdirSync(inside);
    expect(readKernel({ repository, commit }, path).commit).toBe(commit);
    expect(
      refusalOf(() => readKernel({ repository: inside, commit }, path)),
    ).toEqual(
      refused(
        "kernel_repository_missing",
        `No git repository is at ${inside}: that folder is inside the repository above it.`,
        repairs.repository,
      ),
    );
  });
});
