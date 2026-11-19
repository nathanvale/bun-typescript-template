import { describe, expect, test } from "bun:test";
import { checkStamp } from "../../../src/stamp-check.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { reasonJsonRefuses, withField } from "../../support/json-faults.ts";
import {
  stampedFolder,
  stampRecordName,
  writeStampRecord,
} from "../../support/stamped-folder-fixture.ts";

const owned = ownedFolders();

type StampRecord = ReturnType<typeof stampedFolder>;

const notJson = "{ schemaVersion: 1 }";
const otherBlob = "b".repeat(40);

const faults: readonly (readonly [
  string,
  (record: StampRecord) => unknown,
  string,
])[] = [
  [
    "text that is not JSON",
    () => notJson,
    `it is not JSON (${reasonJsonRefuses(notJson)}).`,
  ],
  [
    "a list in place of its object",
    () => [],
    "the stamp record must be an object.",
  ],
  [
    "a schema version the stamp check does not read",
    (record) => withField(record, "schemaVersion", 2),
    "schemaVersion is 2, and the stamp check reads version 1 only.",
  ],
  [
    "the sha256 object format",
    ({ kernel }) => withField(kernel, "objectFormat", "sha256"),
    'kernel.objectFormat is "sha256", and the stamp check reads sha1 only.',
  ],
  [
    "an abbreviated kernel commit",
    ({ kernel }) => withField(kernel, "commit", "c".repeat(39)),
    "kernel.commit must be 40 lowercase hexadecimal characters.",
  ],
  [
    "add-ons that are not a list",
    (record) => withField(record, "addons", "beta"),
    "addons must be a list.",
  ],
  [
    "a file path that climbs out of the folder",
    ({ files }) => withField(files[0] ?? {}, "path", "lib/core/../../out.ts"),
    'files[0].path is "lib/core/../../out.ts", which is not a plain path: it has an empty, "." or ".." part.',
  ],
  [
    "a file mode that is not a plain file's",
    ({ files }) => withField(files[0] ?? {}, "mode", "120000"),
    'files[0].mode is "120000", and a stamped file is 100644 or 100755.',
  ],
  [
    "a file in none of its stamp roots",
    ({ files }) => withField(files[0] ?? {}, "path", "lib/elsewhere/leaf.ts"),
    'files[0].path is "lib/elsewhere/leaf.ts", which is in none of the recorded stamp roots.',
  ],
  [
    "a file identity that its stamp root's tree identity does not cover",
    ({ files }) => withField(files[0] ?? {}, "blob", otherBlob),
    'roots[0].tree is not the tree identity of the files recorded under "lib/core".',
  ],
  [
    "one file listed twice",
    ({ files }) => {
      files.push(...files.slice(0, 1));
    },
    "lib/core/deep/leaf.ts is listed twice.",
  ],
  [
    "a merged package version that is not text",
    ({ requirements }) => withField(requirements, "packages", { pad: 1 }),
    "requirements.packages.pad must be a non-empty string.",
  ],
  [
    "a merged dead-code entry that climbs out of the folder",
    ({ requirements }) =>
      withField(requirements, "deadCodeEntries", ["../index.ts"]),
    'requirements.deadCodeEntries[0] is "../index.ts", which is not a plain path: it has an empty, "." or ".." part.',
  ],
  [
    "a stamp checker path that climbs out of the folder",
    ({ stampChecker }) => withField(stampChecker, "path", "../check-stamp.ts"),
    'stampChecker.path is "../check-stamp.ts", which is not a plain path: it has an empty, "." or ".." part.',
  ],
  [
    "no stamp checker",
    (record) => withField(record, "stampChecker", undefined),
    "stampChecker must be an object.",
  ],
];

describe("the stamp check returns broken, naming the stamp record and the fault, for a stamp record that holds", () => {
  test.each(faults)("%s", (_title, damage, detail) => {
    const folder = owned("stamp-record-");
    const record = stampedFolder(folder);
    writeStampRecord(folder, record);
    expect(checkStamp(folder).status).toBe("intact");
    writeStampRecord(folder, damage(record) ?? record);
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [{ kind: "stamp-record", path: stampRecordName, detail }],
    });
  });
});
