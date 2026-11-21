import { describe, expect, test } from "bun:test";
import { readKernel } from "../../../src/kernel-reader.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { reasonJsonRefuses, withField } from "../../support/json-faults.ts";
import { refusalOf, refused, repairs } from "../../support/kernel-refusal.ts";
import {
  declarationFor,
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const path = declarationPathIn(firstLayout);

type Declaration = ReturnType<typeof declarationFor>;

function changed(change: (declaration: Declaration) => unknown): unknown {
  const declaration = declarationFor(firstLayout);
  return change(declaration) ?? declaration;
}

const notJson = "{ schemaVersion: 2 }";

const cases: readonly (readonly [string, unknown, string])[] = [
  [
    "text that is not JSON",
    notJson,
    `it is not JSON (${reasonJsonRefuses(notJson)}).`,
  ],
  ["a list in place of the file's object", [], "the file must be an object."],
  [
    "a schema version the kernel reader does not read",
    changed((declaration) => withField(declaration, "schemaVersion", 3)),
    "schemaVersion is 3, and the kernel reader reads version 2 only.",
  ],
  [
    "no base",
    changed((declaration) => withField(declaration, "base", undefined)),
    "base must be an object.",
  ],
  [
    "kernel roots that are not a list",
    changed(({ base }) => withField(base, "roots", "lib/core")),
    "base.roots must be a list.",
  ],
  [
    "a kernel root that climbs out of its folder",
    changed(({ base }) => withField(base, "roots", ["lib/../core"])),
    'base.roots[0] is "lib/../core", which is not a plain path: it has an empty, "." or ".." part.',
  ],
  [
    "a kernel root that holds a NUL byte",
    changed(({ base }) => withField(base, "roots", ["lib\0core"])),
    'base.roots[0] is "lib\0core", which is not a plain path: it has a NUL byte.',
  ],
  [
    "an add-on kernel root that is not text",
    changed(({ addons }) => withField(addons.alpha, "root", 7)),
    "addons.alpha.root must be a non-empty string.",
  ],
  [
    "a package version that is not text",
    changed(({ addons }) =>
      withField(addons.beta, "packages", { "left-pad": 1 }),
    ),
    "addons.beta.packages.left-pad must be a non-empty string.",
  ],
  [
    "dead-code entries that are not a list",
    changed(({ base }) => withField(base, "deadCodeEntries", {})),
    "base.deadCodeEntries must be a list.",
  ],
  [
    "a dead-code entry that climbs out of its folder",
    changed(({ base }) => withField(base, "deadCodeEntries", ["../index.ts"])),
    'base.deadCodeEntries[0] is "../index.ts", which is not a plain path: it has an empty, "." or ".." part.',
  ],
  [
    "a required add-on that is not declared",
    changed(({ addons }) => withField(addons.alpha, "requires", ["gamma"])),
    'addons.alpha.requires names "gamma", which is not a declared add-on.',
  ],
  [
    "one kernel root declared twice",
    changed(({ addons }) => withField(addons.alpha, "root", "lib/core")),
    'kernel root "lib/core" is declared twice.',
  ],
  [
    "a kernel root inside another",
    changed(({ addons }) => withField(addons.alpha, "root", "lib/core/deep")),
    'kernel root "lib/core/deep" is inside kernel root "lib/core".',
  ],
  [
    "a kernel declaration that sits in none of the kernel's own roots",
    changed(({ base }) => withField(base, "roots", ["lib/core"])),
    'the folder it sits in, "engine/settings", must end with exactly one of the kernel\'s own roots (lib/core), and it ends with 0.',
  ],
  [
    "a kernel declaration that sits in two of the kernel's own roots",
    changed(({ base }) =>
      withField(base, "roots", ["lib/core", "settings", "engine/settings"]),
    ),
    'the folder it sits in, "engine/settings", must end with exactly one of the kernel\'s own roots (lib/core, settings, engine/settings), and it ends with 2.',
  ],
  [
    "a kernel root that holds no file at the commit",
    changed(({ addons }) => withField(addons.alpha, "root", "lib/gone")),
    'it declares kernel root "lib/gone", which holds no file in that commit.',
  ],
];

describe("the kernel reader refuses, with its repair line, a kernel declaration that holds", () => {
  test.each(cases)("%s", (_title, declaration, problem) => {
    const repository = folder("kernel-declaration-");
    const commit = kernelRepository(
      repository,
      kernelEntries(firstLayout, declaration),
    );
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_declaration_invalid",
        `The kernel declaration at ${path} in commit ${commit} is not valid: ${problem}`,
        repairs.declaration,
      ),
    );
  });
});
