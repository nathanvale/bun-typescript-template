import { describe, expect, test } from "bun:test";
import { KernelRefusal, readKernel } from "../../../src/kernel-reader.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  declarationFor,
  declarationPathIn,
  firstLayout,
  kernelEntries,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";

const folder = ownedFolders();
const path = declarationPathIn(firstLayout);
const repair =
  "Correct the kernel declaration in the kernel repository, then give the commit that holds the correction.";

type Declaration = ReturnType<typeof declarationFor>;

function changed(change: (declaration: Declaration) => unknown): unknown {
  const declaration = declarationFor(firstLayout);
  return change(declaration) ?? declaration;
}

function withField(owner: object, key: string, value: unknown): undefined {
  Reflect.set(owner, key, value);
  return undefined;
}

function reasonJsonRefuses(text: string): string {
  try {
    JSON.parse(text);
  } catch (error) {
    if (error instanceof Error) return error.message;
  }
  throw new Error(`JSON.parse read ${text}.`);
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
    "kernel stamp roots that are not a list",
    changed(({ base }) => withField(base, "roots", "lib/core")),
    "base.roots must be a list.",
  ],
  [
    "a stamp root that climbs out of its folder",
    changed(({ base }) => withField(base, "roots", ["lib/../core"])),
    'base.roots[0] is "lib/../core", which is not a plain path: it has an empty, "." or ".." part.',
  ],
  [
    "an add-on stamp root that is not text",
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
    "a required add-on that is not declared",
    changed(({ addons }) => withField(addons.alpha, "requires", ["gamma"])),
    'addons.alpha.requires names "gamma", which is not a declared add-on.',
  ],
  [
    "one stamp root declared twice",
    changed(({ addons }) => withField(addons.alpha, "root", "lib/core")),
    'stamp root "lib/core" is declared twice.',
  ],
  [
    "a stamp root inside another",
    changed(({ addons }) => withField(addons.alpha, "root", "lib/core/deep")),
    'stamp root "lib/core/deep" is inside stamp root "lib/core".',
  ],
  [
    "a kernel declaration that sits in none of the kernel's own stamp roots",
    changed(({ base }) => withField(base, "roots", ["lib/core"])),
    'the folder it sits in, "engine/settings", must end with exactly one of the kernel\'s own stamp roots (lib/core), and it ends with 0.',
  ],
  [
    "a kernel declaration that sits in two of the kernel's own stamp roots",
    changed(({ base }) =>
      withField(base, "roots", ["lib/core", "settings", "engine/settings"]),
    ),
    'the folder it sits in, "engine/settings", must end with exactly one of the kernel\'s own stamp roots (lib/core, settings, engine/settings), and it ends with 2.',
  ],
  [
    "a stamp root that holds no file at the commit",
    changed(({ addons }) => withField(addons.alpha, "root", "lib/gone")),
    'it declares stamp root "lib/gone", which holds no file in that commit.',
  ],
];

describe("the kernel reader refuses, with its repair line, a kernel declaration that holds", () => {
  test.each(cases)("%s", (_title, declaration, problem) => {
    const repository = folder("kernel-declaration-");
    const commit = kernelRepository(
      repository,
      kernelEntries(firstLayout, declaration),
    );
    let refusal: unknown;
    try {
      readKernel({ repository, commit }, path);
    } catch (error) {
      refusal = error;
    }
    if (!(refusal instanceof KernelRefusal))
      throw new Error("The read was not refused.", { cause: refusal });
    expect({
      code: refusal.code,
      message: refusal.message,
      repair: refusal.repair,
    }).toEqual({
      code: "kernel_declaration_invalid",
      message: `The kernel declaration at ${path} in commit ${commit} is not valid: ${problem} Repair: ${repair}`,
      repair,
    });
  });
});
