import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  checkStamp,
  type StampFinding,
  stampRecordPath,
} from "../../../src/stamp-check.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  stampCheckerPath,
  stampedFolder,
  stampRecordName,
  writeStampRecord,
} from "../../support/stamped-folder-fixture.ts";

const owned = ownedFolders();

function stamped(): string {
  const folder = owned("stamp-check-");
  writeStampRecord(folder, stampedFolder(folder));
  return folder;
}

function rewriteJson(
  folder: string,
  file: string,
  change: (fields: Map<string, unknown>) => void,
): void {
  const parsed: unknown = JSON.parse(readFileSync(join(folder, file), "utf8"));
  if (typeof parsed !== "object" || parsed === null)
    throw new Error(`${file} is not an object.`);
  const fields = new Map(Object.entries(parsed));
  change(fields);
  writeFileSync(join(folder, file), JSON.stringify(Object.fromEntries(fields)));
}

type Breakage = readonly [
  string,
  (folder: string) => void,
  readonly StampFinding[],
];

const breakages: readonly Breakage[] = [
  [
    "one changed byte, naming the file",
    (folder) => write(folder, "lib/core/index.ts", "export const core = 2;\n"),
    [
      {
        kind: "modified",
        path: "lib/core/index.ts",
        detail: "its bytes are not the stamped ones.",
      },
    ],
  ],
  [
    "an extra file in a stamp root, naming the file",
    (folder) => write(folder, "lib/extras/beta/deep/extra.ts", "extra\n"),
    [
      {
        kind: "extra",
        path: "lib/extras/beta/deep/extra.ts",
        detail: "it is in a stamp root and is not recorded.",
      },
    ],
  ],
  [
    "a deleted file, naming the file",
    (folder) => rmSync(join(folder, "settings/rules.mjs")),
    [
      {
        kind: "missing",
        path: "settings/rules.mjs",
        detail: "it is recorded and is not in the folder.",
      },
    ],
  ],
  [
    "an executable bit cleared, naming the file",
    (folder) => chmodSync(join(folder, "lib/core/run.sh"), 0o644),
    [
      {
        kind: "mode",
        path: "lib/core/run.sh",
        detail: "its git mode is 100644, and the stamp record says 100755.",
      },
    ],
  ],
  [
    "an executable bit set, naming the file",
    (folder) => chmodSync(join(folder, "lib/core/deep/leaf.ts"), 0o755),
    [
      {
        kind: "mode",
        path: "lib/core/deep/leaf.ts",
        detail: "its git mode is 100755, and the stamp record says 100644.",
      },
    ],
  ],
  [
    "a changed merged package version, naming the file and the package",
    (folder) =>
      rewriteJson(folder, "package.json", (fields) =>
        fields.set("dependencies", { "left-pad": "1.3.1", own: "1.0.0" }),
      ),
    [
      {
        kind: "requirement",
        path: "package.json",
        detail:
          'the stamp merged package "left-pad" at "1.3.0", and it is now "1.3.1".',
      },
    ],
  ],
  [
    "a removed merged package, naming the file and the package",
    (folder) =>
      rewriteJson(folder, "package.json", (fields) =>
        fields.set("dependencies", { own: "1.0.0" }),
      ),
    [
      {
        kind: "requirement",
        path: "package.json",
        detail:
          'the stamp merged package "left-pad" at "1.3.0", and it is now absent.',
      },
    ],
  ],
  [
    "a removed merged dead-code entry, naming the file and the entry",
    (folder) =>
      rewriteJson(folder, ".fallowrc.json", (fields) =>
        fields.set("entry", ["src/cli.ts", "lib/core/index.ts"]),
      ),
    [
      {
        kind: "requirement",
        path: ".fallowrc.json",
        detail:
          'the stamp merged dead-code entry "lib/extras/beta/index.ts", and it is now absent.',
      },
    ],
  ],
  [
    "a package file that is no longer JSON, naming the file and not its packages",
    (folder) => write(folder, "package.json", "{ dependencies: {} }"),
    [
      {
        kind: "requirement",
        path: "package.json",
        detail:
          "it cannot be read as a JSON object, and the stamp merged requirements into it.",
      },
    ],
  ],
  [
    "a deleted dead-code settings file, naming the file and not its entries",
    (folder) => rmSync(join(folder, ".fallowrc.json")),
    [
      {
        kind: "requirement",
        path: ".fallowrc.json",
        detail:
          "it cannot be read as a JSON object, and the stamp merged requirements into it.",
      },
    ],
  ],
  [
    "two extra files in a stamp root, in path order",
    (folder) => {
      write(folder, "settings/zebra.mjs", "extra\n");
      write(folder, "settings/apple.mjs", "extra\n");
    },
    [
      {
        kind: "extra",
        path: "settings/apple.mjs",
        detail: "it is in a stamp root and is not recorded.",
      },
      {
        kind: "extra",
        path: "settings/zebra.mjs",
        detail: "it is in a stamp root and is not recorded.",
      },
    ],
  ],
  [
    "an edited stamp checker, naming the file",
    (folder) => write(folder, stampCheckerPath, "export const edited = 1;\n"),
    [
      {
        kind: "stamp-checker",
        path: stampCheckerPath,
        detail: "it is not the stamp checker the stamp record names.",
      },
    ],
  ],
  [
    "a symbolic link where a stamped file was, naming the file",
    (folder) => {
      rmSync(join(folder, "lib/core/index.ts"));
      symlinkSync("deep/leaf.ts", join(folder, "lib/core/index.ts"));
    },
    [
      {
        kind: "not-a-file",
        path: "lib/core/index.ts",
        detail: "it is recorded as a plain file and is not one.",
      },
    ],
  ],
  [
    "two faults, one finding for each",
    (folder) => {
      rmSync(join(folder, "lib/core/deep"), { recursive: true });
      write(folder, "lib/core/deep", "a file where a folder was\n");
    },
    [
      {
        kind: "missing",
        path: "lib/core/deep/leaf.ts",
        detail: "it is recorded and is not in the folder.",
      },
      {
        kind: "extra",
        path: "lib/core/deep",
        detail: "it is in a stamp root and is not recorded.",
      },
    ],
  ],
];

describe("the stamp check", () => {
  test("returns intact on an untouched folder, with the kernel commit, the add-on selection and the file count", () => {
    expect(checkStamp(stamped())).toEqual({
      status: "intact",
      commit: "c".repeat(40),
      addons: ["beta"],
      fileCount: 5,
    });
  });

  test("returns unstamped on a folder with no stamp record, and reads the stamp record from the one name it holds", () => {
    const folder = stamped();
    expect(stampRecordPath).toBe(stampRecordName);
    rmSync(join(folder, stampRecordName));
    expect(checkStamp(folder)).toEqual({ status: "unstamped" });
  });

  test("stays intact when a file outside every stamp root changes", () => {
    const folder = stamped();
    write(folder, "src/cli.ts", "export const cli = false;\n");
    write(folder, "lib/other/new.ts", "export const other = 1;\n");
    expect(checkStamp(folder).status).toBe("intact");
  });

  test.each(breakages)("returns broken for %s", (_title, damage, findings) => {
    const folder = stamped();
    expect(checkStamp(folder).status).toBe("intact");
    damage(folder);
    expect(checkStamp(folder)).toEqual({ status: "broken", findings });
  });
});
