import { chmodSync } from "node:fs";
import { join } from "node:path";
import { write } from "./fixture-files.ts";
import { git, initRepository } from "./git-fixture.ts";
import { listedFiles, treeOf } from "./git-object-fixture.ts";

export const stampRecordName = ".kernel-stamp.json";
export const stampCheckerPath = "scripts/check-stamp.ts";

const stampRoots = [
  { owner: "base", path: "lib/core" },
  { owner: "base", path: "settings" },
  { owner: "beta", path: "lib/extras/beta" },
];

const stamped = {
  "lib/core/index.ts": "export const core = 1;\n",
  "lib/core/deep/leaf.ts": "export const leaf = 2;\n",
  "lib/core/run.sh": "#!/bin/sh\nexit 0\n",
  "settings/rules.mjs": "export default [];\n",
  "lib/extras/beta/index.ts": "export const beta = 4;\n",
};

const ownFiles = {
  [stampCheckerPath]: "export const stampChecker = true;\n",
  "src/cli.ts": "export const cli = true;\n",
  "package.json": `${JSON.stringify(
    { name: "generated", dependencies: { "left-pad": "1.3.0", own: "1.0.0" } },
    null,
    2,
  )}\n`,
  ".fallowrc.json": `${JSON.stringify(
    { entry: ["src/cli.ts", "lib/core/index.ts", "lib/extras/beta/index.ts"] },
    null,
    2,
  )}\n`,
};

// Interface: fills `folder` with a small generated repository: three stamp
// roots, the two files the stamp merged requirements into, a stamp checker and
// one file of its own. The stamp record it returns takes every identity from
// git, which committed the same files, and is not yet written to the folder.
export function stampedFolder(
  folder: string,
  more: Readonly<Record<string, string>> = {},
) {
  const stamping = { ...stamped, ...more };
  initRepository(folder);
  for (const [path, text] of Object.entries({ ...stamping, ...ownFiles }))
    write(folder, path, text);
  chmodSync(join(folder, "lib/core/run.sh"), 0o755);
  git(folder, "add", "--all");
  git(folder, "commit", "--quiet", "-m", "a generated repository");
  const commit = git(folder, "rev-parse", "HEAD");
  const listed = listedFiles(folder, commit);
  return {
    schemaVersion: 1,
    kernel: {
      repository: "small-kernel",
      commit: "c".repeat(40),
      objectFormat: "sha1",
      sourceRoot: "engine",
    },
    addons: ["beta"],
    roots: stampRoots.map((root) => ({
      ...root,
      tree: treeOf(folder, commit, root.path),
    })),
    files: listed.filter(({ path }) => Object.hasOwn(stamping, path)),
    requirements: {
      packages: { "left-pad": "1.3.0" },
      deadCodeEntries: ["lib/core/index.ts", "lib/extras/beta/index.ts"],
    },
    stampChecker: {
      path: stampCheckerPath,
      blob: listed.find(({ path }) => path === stampCheckerPath)?.blob ?? "",
    },
  };
}

export function writeStampRecord(folder: string, record: unknown): void {
  write(
    folder,
    stampRecordName,
    typeof record === "string"
      ? record
      : `${JSON.stringify(record, null, 2)}\n`,
  );
}
