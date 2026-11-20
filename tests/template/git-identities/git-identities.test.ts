import { describe, expect, test } from "bun:test";
import {
  blobIdentity,
  fileModeOf,
  type StampedFile,
  treeIdentity,
} from "../../../src/git-identities.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { initRepository } from "../../support/git-fixture.ts";
import {
  commitObjects,
  listedFiles,
  type ObjectEntry,
  treeOf,
} from "../../support/git-object-fixture.ts";

const folder = ownedFolders();

const notUtf8 = new Uint8Array([0x63, 0x61, 0x66, 0xe9, 0x0a]);
const byteOrderMark = new Uint8Array([0xef, 0xbb, 0xbf, 0x61, 0x0a]);

const hardCases: readonly ObjectEntry[] = [
  { path: "lib/nested/deeper/leaf.ts", bytes: "export const leaf = 1;\n" },
  { path: "lib/nested/sibling.ts", bytes: "export const sibling = 2;\n" },
  { path: "lib/run.sh", bytes: "#!/bin/sh\nexit 0\n", mode: "100755" },
  { path: "lib/empty", bytes: "" },
  { path: "lib/a tab\there.txt", bytes: "tab\n" },
  { path: "lib/crlf.txt", bytes: "one\r\ntwo\r\n" },
  { path: "lib/latin-1.txt", bytes: notUtf8 },
  { path: "lib/marked.txt", bytes: byteOrderMark },
  { path: "other/top.ts", bytes: "export const top = 3;\n" },
];

const sortsDifferently: readonly ObjectEntry[] = [
  { path: "trap/foo/inner.ts", bytes: "export const inner = 1;\n" },
  { path: "trap/foo-bar", bytes: "bar\n" },
  { path: "trap/foo.ts", bytes: "export const foo = 2;\n" },
  { path: "trap/foo0", bytes: "zero\n" },
];

const sortsByBytes: readonly ObjectEntry[] = [
  { path: "bytes/\u{1F600}.ts", bytes: "export const astral = 1;\n" },
  { path: "bytes/～.ts", bytes: "export const wide = 2;\n" },
];

function committed(entries: readonly ObjectEntry[]) {
  const root = folder("git-identities-");
  initRepository(root);
  const commit = commitObjects(root, "hard cases", entries);
  return { root, commit };
}

function stamped(root: string, commit: string): StampedFile[] {
  return listedFiles(root, commit).map(({ path, mode, blob }) => {
    const plain = fileModeOf(mode);
    if (plain === undefined)
      throw new Error(`${path} has mode ${mode}, which is not a plain file.`);
    return { path, mode: plain, blob };
  });
}

function bytesOf(entry: ObjectEntry): Uint8Array {
  if (!("bytes" in entry)) throw new Error(`${entry.path} holds no bytes.`);
  return typeof entry.bytes === "string"
    ? new TextEncoder().encode(entry.bytes)
    : entry.bytes;
}

describe("a blob identity computed in process", () => {
  test("equals git's for an empty file, an executable file, CRLF line ends, a byte-order mark and bytes that are not UTF-8", () => {
    const { root, commit } = committed(hardCases);
    const listed = new Map(
      listedFiles(root, commit).map(({ path, blob }) => [path, blob]),
    );
    expect(listed.size).toBe(hardCases.length);
    for (const entry of hardCases)
      expect([entry.path, blobIdentity(bytesOf(entry))]).toEqual([
        entry.path,
        listed.get(entry.path) ?? "git listed no such file",
      ]);
  });

  test("changes when one byte changes", () => {
    expect(blobIdentity(new TextEncoder().encode("bar\n"))).not.toBe(
      blobIdentity(new TextEncoder().encode("baz\n")),
    );
  });
});

describe("a tree identity computed in process", () => {
  test("equals git's for the whole commit and for each folder, nested folders included", () => {
    const { root, commit } = committed(hardCases);
    const files = stamped(root, commit);
    for (const tree of ["", "lib", "lib/nested", "lib/nested/deeper", "other"])
      expect([tree, treeIdentity(files, tree)]).toEqual([
        tree,
        treeOf(root, commit, tree),
      ]);
  });

  test("equals git's where a folder sorts differently from a file of the same name", () => {
    const { root, commit } = committed(sortsDifferently);
    expect(treeIdentity(stamped(root, commit), "trap")).toBe(
      treeOf(root, commit, "trap"),
    );
  });

  test("equals git's where names sort differently by UTF-8 byte than by UTF-16 code unit", () => {
    const { root, commit } = committed(sortsByBytes);
    expect(treeIdentity(stamped(root, commit), "bytes")).toBe(
      treeOf(root, commit, "bytes"),
    );
  });

  test("follows git's when a file becomes executable, and no longer equals the commit before", () => {
    const { root, commit } = committed(hardCases);
    const executable = commitObjects(root, "leaf becomes executable", [
      {
        path: "lib/nested/deeper/leaf.ts",
        bytes: "export const leaf = 1;\n",
        mode: "100755",
      },
    ]);
    const identity = treeIdentity(stamped(root, executable), "lib");
    expect(identity).toBe(treeOf(root, executable, "lib"));
    expect(identity).not.toBe(treeOf(root, commit, "lib"));
  });

  test("refuses a path listed twice", () => {
    const file: StampedFile = {
      path: "lib/a.ts",
      mode: "100644",
      blob: blobIdentity(new Uint8Array()),
    };
    expect(() => treeIdentity([file, file], "lib")).toThrow(
      "lib/a.ts is listed twice.",
    );
  });

  test("refuses a file and a folder that share one name", () => {
    const blob = blobIdentity(new Uint8Array());
    expect(() =>
      treeIdentity(
        [
          { path: "lib/a", mode: "100644", blob },
          { path: "lib/a/b.ts", mode: "100644", blob },
        ],
        "lib",
      ),
    ).toThrow("lib/a is both a file and a folder.");
  });

  test("refuses a folder that holds no listed file", () => {
    const blob = blobIdentity(new Uint8Array());
    expect(() =>
      treeIdentity([{ path: "library/a.ts", mode: "100644", blob }], "lib"),
    ).toThrow('No listed file is under "lib".');
  });
});
