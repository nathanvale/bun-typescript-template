import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  type Kernel,
  kernelDeclarationPath,
  readKernel,
  type StampRoot,
} from "../../../src/kernel-reader.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { git } from "../../support/git-fixture.ts";
import {
  commitObjects,
  listedFiles,
  treeOf,
} from "../../support/git-object-fixture.ts";
import {
  declarationFor,
  declarationPathIn,
  declarationText,
  firstLayout,
  kernelEntries,
  kernelRepository,
  type Layout,
  renamedLayout,
  sources,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const firstPath = declarationPathIn(firstLayout);

type Summary = readonly (readonly [string, string, string])[];

function summary({ files }: StampRoot): Summary {
  return files.map(({ path, mode, bytes }) => [
    path,
    mode,
    new TextDecoder().decode(bytes),
  ]);
}

function everyRoot({ roots, addons }: Kernel): StampRoot[] {
  return [...roots, ...addons.map(({ root }) => root)];
}

const committedCore: Summary = [
  ["lib/core/deep/leaf.ts", "100644", sources.leaf],
  ["lib/core/index.ts", "100644", sources.index],
  ["lib/core/run.sh", "100755", sources.run],
];

function workingTree(root: string, stampRoot: string): Summary {
  const top = join(root, firstLayout.sourceRoot, stampRoot);
  return readdirSync(top, { recursive: true, encoding: "utf8" })
    .filter((name) => statSync(join(top, name)).isFile())
    .sort()
    .map((name) => [
      `${stampRoot}/${name}`,
      (statSync(join(top, name)).mode & 0o100) === 0 ? "100644" : "100755",
      readFileSync(join(top, name), "utf8"),
    ]);
}

describe("the kernel reader, given a local path and one full commit", () => {
  test("returns the kernel's stamp roots and each add-on's, with the paths they will have in a generated repository", () => {
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository);
    const kernel = readKernel({ repository, commit }, firstPath);
    expect({ commit: kernel.commit, sourceRoot: kernel.sourceRoot }).toEqual({
      commit,
      sourceRoot: "engine",
    });
    expect(kernel.roots.map(({ path }) => path)).toEqual([
      "lib/core",
      "settings",
    ]);
    expect(kernel.roots.map(summary)).toEqual([
      committedCore,
      [
        [
          "settings/kernel-declaration.json",
          "100644",
          declarationText(declarationFor(firstLayout)),
        ],
        ["settings/rules.mjs", "100644", sources.rules],
      ],
    ]);
    expect({
      packages: kernel.packages,
      deadCodeEntries: kernel.deadCodeEntries,
    }).toEqual({ packages: {}, deadCodeEntries: ["lib/core/index.ts"] });
    expect(
      kernel.addons.map(({ root, ...addon }) => ({
        ...addon,
        root: root.path,
        files: summary(root),
      })),
    ).toEqual([
      {
        name: "alpha",
        requires: ["beta"],
        packages: {},
        deadCodeEntries: [],
        root: "lib/extras/alpha",
        files: [["lib/extras/alpha/index.ts", "100644", sources.alpha]],
      },
      {
        name: "beta",
        requires: [],
        packages: { "left-pad": "1.3.0" },
        deadCodeEntries: ["lib/extras/beta/index.ts"],
        root: "lib/extras/beta",
        files: [["lib/extras/beta/index.ts", "100644", sources.beta]],
      },
    ]);
  });

  test("gives each stamp root git's tree identity and each file git's blob identity", () => {
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository);
    const kernel = readKernel({ repository, commit }, firstPath);
    const listed = new Map(
      listedFiles(repository, commit).map(({ path, blob }) => [path, blob]),
    );
    const roots = everyRoot(kernel);
    expect(roots).toHaveLength(4);
    for (const root of roots) {
      expect([root.path, root.tree]).toEqual([
        root.path,
        treeOf(repository, commit, `engine/${root.path}`),
      ]);
      for (const { path, blob } of root.files)
        expect([path, blob]).toEqual([
          path,
          listed.get(`engine/${path}`) ?? "git listed no such file",
        ]);
    }
  });

  test("returns exactly the bytes of the commit asked for from a sibling repository on another commit with a dirty working tree, where a working-tree read is wrong", () => {
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository);
    const later = commitObjects(repository, "a later commit", [
      { path: "engine/lib/core/index.ts", bytes: "export const core = 9;\n" },
      { path: "engine/lib/core/added.ts", bytes: "export const added = 5;\n" },
    ]);
    git(repository, "checkout-index", "-a", "-f");
    write(repository, "engine/lib/core/index.ts", "an edit in progress\n");
    write(repository, "engine/lib/core/left-behind/probe.ts", "untracked\n");
    chmodSync(join(repository, "engine/lib/core/deep/leaf.ts"), 0o755);
    rmSync(join(repository, "engine/lib/core/run.sh"));
    expect(git(repository, "rev-parse", "HEAD")).toBe(later);
    expect(later).not.toBe(commit);

    expect(workingTree(repository, "lib/core")).toEqual([
      ["lib/core/added.ts", "100644", "export const added = 5;\n"],
      ["lib/core/deep/leaf.ts", "100755", sources.leaf],
      ["lib/core/index.ts", "100644", "an edit in progress\n"],
      ["lib/core/left-behind/probe.ts", "100644", "untracked\n"],
    ]);
    const [core] = readKernel({ repository, commit }, firstPath).roots;
    expect(core === undefined ? [] : summary(core)).toEqual(committedCore);
  });

  test("returns a file's own bytes where the repository holds a replace ref that swaps them", () => {
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository);
    const blobs = new Map(
      listedFiles(repository, commit).map(({ path, blob }) => [path, blob]),
    );
    const index = blobs.get("engine/lib/core/index.ts") ?? "";
    git(
      repository,
      "replace",
      index,
      blobs.get("engine/lib/core/deep/leaf.ts") ?? "",
    );
    expect(git(repository, "cat-file", "blob", index)).toBe(
      sources.leaf.trim(),
    );
    const [core] = readKernel({ repository, commit }, firstPath).roots;
    expect(core === undefined ? [] : summary(core)).toEqual(committedCore);
  });

  test("reads a kernel whose folders were all renamed, given only the kernel declaration's new path", () => {
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository);
    const renamed = commitObjects(repository, "rename every folder", [
      ...kernelEntries(firstLayout).map(({ path }) => ({
        path,
        removed: true as const,
      })),
      ...kernelEntries(renamedLayout),
    ]);
    const before = readKernel({ repository, commit }, firstPath);
    const after = readKernel(
      { repository, commit: renamed },
      declarationPathIn(renamedLayout),
    );
    expect(after.sourceRoot).toBe("motor");
    expect(everyRoot(after).map(({ path }) => path)).toEqual([
      "source/heart",
      "conf",
      "source/plugins/alpha",
      "source/plugins/beta",
    ]);
    expect(after.roots[0]?.tree).toBe(before.roots[0]?.tree ?? "no tree");
    expect(after.addons.map(({ root }) => root.tree)).toEqual(
      before.addons.map(({ root }) => root.tree),
    );
  });

  test("reads the kernel declaration at the one path the template holds when no path is given", () => {
    const [sourceRoot = "", ...settings] = dirname(kernelDeclarationPath).split(
      "/",
    );
    const layout: Layout = {
      ...firstLayout,
      sourceRoot,
      settings: settings.join("/"),
    };
    expect(declarationPathIn(layout)).toBe(kernelDeclarationPath);
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository, kernelEntries(layout));
    expect(readKernel({ repository, commit }).sourceRoot).toBe(sourceRoot);
  });

  test("reads a kernel whose stamp roots sit at the top of its repository", () => {
    const layout: Layout = { ...firstLayout, sourceRoot: "" };
    const repository = folder("kernel-reader-");
    const commit = kernelRepository(repository, kernelEntries(layout));
    const kernel = readKernel(
      { repository, commit },
      declarationPathIn(layout),
    );
    expect(kernel.sourceRoot).toBe("");
    expect(
      kernel.roots[0] === undefined ? [] : summary(kernel.roots[0]),
    ).toEqual(committedCore);
  });
});
