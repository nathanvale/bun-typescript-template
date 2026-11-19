import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { checkStamp } from "../../../src/stamp-check.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  stampCheckerPath,
  stampedFolder,
  stampRecordName,
  writeStampRecord,
} from "../../support/stamped-folder-fixture.ts";

const owned = ownedFolders();

function stamped(): string {
  const folder = owned("stamp-check-entries-");
  writeStampRecord(folder, stampedFolder(folder));
  expect(checkStamp(folder).status).toBe("intact");
  return folder;
}

function linkAway(folder: string, path: string): void {
  const elsewhere = join(owned("stamp-check-elsewhere-"), "copy");
  cpSync(join(folder, path), elsewhere, { recursive: true });
  renameSync(join(folder, path), join(folder, `${path}.moved`));
  symlinkSync(elsewhere, join(folder, path));
  rmSync(join(folder, `${path}.moved`), { recursive: true });
}

describe("the stamp check returns broken", () => {
  test("for a stamp root replaced by a link to a folder that holds the same files, naming the stamp root", () => {
    const folder = stamped();
    linkAway(folder, "settings");
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "not-a-folder",
          path: "settings",
          detail: "it leads to a stamp root and is not a folder itself.",
        },
      ],
    });
  });

  test("for a folder above two stamp roots replaced by a link, naming that folder once", () => {
    const folder = stamped();
    linkAway(folder, "lib");
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "not-a-folder",
          path: "lib",
          detail: "it leads to a stamp root and is not a folder itself.",
        },
      ],
    });
  });

  test("for a folder in a stamp root that cannot be listed, naming the folder", () => {
    const folder = stamped();
    const locked = join(folder, "lib/core/locked");
    write(folder, "lib/core/locked/hidden.ts", "export const hidden = 1;\n");
    chmodSync(locked, 0o000);
    try {
      expect(checkStamp(folder)).toEqual({
        status: "broken",
        findings: [
          {
            kind: "unreadable",
            path: "lib/core/locked",
            detail: "it is a folder in a stamp root and cannot be listed.",
          },
        ],
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("for a stamp checker replaced by a named pipe, without waiting for a writer", () => {
    const folder = stamped();
    rmSync(join(folder, stampCheckerPath));
    const made = Bun.spawnSync(["mkfifo", join(folder, stampCheckerPath)], {
      timeout: 4_000,
      killSignal: "SIGKILL",
    });
    expect(made.exitCode).toBe(0);
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "stamp-checker",
          path: stampCheckerPath,
          detail: "it is not the stamp checker the stamp record names.",
        },
      ],
    });
  });

  test("for a stamp record that is a link to nothing, naming the stamp record, where no stamp record at all is unstamped", () => {
    const folder = stamped();
    rmSync(join(folder, stampRecordName));
    expect(checkStamp(folder)).toEqual({ status: "unstamped" });
    symlinkSync("no-such-file", join(folder, stampRecordName));
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "stamp-record",
          path: stampRecordName,
          detail: "it is not a plain file that can be read.",
        },
      ],
    });
  });

  test("for a stamp record that is a folder, naming the stamp record", () => {
    const folder = stamped();
    rmSync(join(folder, stampRecordName));
    mkdirSync(join(folder, stampRecordName));
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "stamp-record",
          path: stampRecordName,
          detail: "it is not a plain file that can be read.",
        },
      ],
    });
  });
});
