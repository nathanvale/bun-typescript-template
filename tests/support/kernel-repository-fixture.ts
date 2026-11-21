import { initRepository } from "./git-fixture.ts";
import { commitObjects, type ObjectEntry } from "./git-object-fixture.ts";

export type Layout = {
  readonly sourceRoot: string;
  readonly core: string;
  readonly settings: string;
  readonly extras: string;
};

export const firstLayout: Layout = {
  sourceRoot: "engine",
  core: "lib/core",
  settings: "settings",
  extras: "lib/extras",
};

export const renamedLayout: Layout = {
  sourceRoot: "motor",
  core: "source/heart",
  settings: "conf",
  extras: "source/plugins",
};

export const sources = {
  index: "export const core = 1;\n",
  leaf: "export const leaf = 2;\n",
  run: "#!/bin/sh\nexit 0\n",
  rules: "export default [];\n",
  alpha: "export const alpha = 3;\n",
  beta: "export const beta = 4;\n",
};

function inSource({ sourceRoot }: Layout, path: string): string {
  return sourceRoot === "" ? path : `${sourceRoot}/${path}`;
}

export function declarationPathIn(layout: Layout): string {
  return inSource(layout, `${layout.settings}/kernel-declaration.json`);
}

export function declarationFor({ core, settings, extras }: Layout) {
  return {
    schemaVersion: 2,
    base: {
      roots: [core, settings],
      packages: {},
      deadCodeEntries: [`${core}/index.ts`],
    },
    addons: {
      alpha: {
        root: `${extras}/alpha`,
        requires: ["beta"],
        packages: {},
        deadCodeEntries: [],
      },
      beta: {
        root: `${extras}/beta`,
        requires: [],
        packages: { "left-pad": "1.3.0" },
        deadCodeEntries: [`${extras}/beta/index.ts`],
      },
    },
  };
}

export function declarationText(declaration: unknown): string {
  return typeof declaration === "string"
    ? declaration
    : `${JSON.stringify(declaration, null, 2)}\n`;
}

export function kernelEntries(
  layout: Layout = firstLayout,
  declaration: unknown = declarationFor(layout),
): ObjectEntry[] {
  const { core, settings, extras } = layout;
  const sourceEntries: ObjectEntry[] = [
    { path: `${core}/index.ts`, bytes: sources.index },
    { path: `${core}/deep/leaf.ts`, bytes: sources.leaf },
    { path: `${core}/run.sh`, bytes: sources.run, mode: "100755" },
    { path: `${settings}/rules.mjs`, bytes: sources.rules },
    {
      path: `${settings}/kernel-declaration.json`,
      bytes:
        declaration instanceof Uint8Array
          ? declaration
          : declarationText(declaration),
    },
    { path: `${extras}/alpha/index.ts`, bytes: sources.alpha },
    { path: `${extras}/beta/index.ts`, bytes: sources.beta },
    {
      path: "notes.md",
      bytes: "Inside the source folder, in no kernel root.\n",
    },
  ];
  return [
    ...sourceEntries.map((entry) => ({
      ...entry,
      path: inSource(layout, entry.path),
    })),
    { path: "README.md", bytes: "A small kernel repository.\n" },
    { path: "tests/core.test.ts", bytes: "export {};\n" },
  ];
}

export function kernelRepository(
  root: string,
  entries: readonly ObjectEntry[] = kernelEntries(),
): string {
  initRepository(root);
  return commitObjects(root, "a small kernel", entries);
}
