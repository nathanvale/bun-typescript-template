import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  cpSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
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
          detail:
            "it leads to a stamp root or the stamp checker and is not a folder itself.",
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
          detail:
            "it leads to a stamp root or the stamp checker and is not a folder itself.",
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

  test("for a stamp record with a byte that is not UTF-8, naming the stamp record", () => {
    const folder = stamped();
    const text = readFileSync(join(folder, stampRecordName));
    const cut = text.indexOf("small-kernel");
    expect(cut).toBeGreaterThan(0);
    writeFileSync(
      join(folder, stampRecordName),
      Buffer.concat([
        text.subarray(0, cut),
        Buffer.from([0xff]),
        text.subarray(cut),
      ]),
    );
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "stamp-record",
          path: stampRecordName,
          detail: "it is not UTF-8 text.",
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

describe("the stamp check, where an entry cannot be looked up", () => {
  test("returns broken, naming the stamp record, for a folder that may not be searched, and not unstamped", () => {
    const folder = stamped();
    chmodSync(folder, 0o000);
    try {
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
    } finally {
      chmodSync(folder, 0o755);
    }
  });

  test("returns broken, naming a stamped file it cannot look up and the folder it cannot list", () => {
    const folder = stamped();
    const locked = join(folder, "lib/core/deep");
    chmodSync(locked, 0o000);
    try {
      expect(checkStamp(folder)).toEqual({
        status: "broken",
        findings: [
          {
            kind: "unreadable",
            path: "lib/core/deep/leaf.ts",
            detail: "it is recorded and cannot be looked up.",
          },
          {
            kind: "unreadable",
            path: "lib/core/deep",
            detail: "it is a folder in a stamp root and cannot be listed.",
          },
        ],
      });
    } finally {
      chmodSync(locked, 0o755);
    }
  });
});

describe("the stamp check opens no link", () => {
  test("a stamp checker that is a link to a file with the same bytes outside the folder is broken, naming the stamp checker", () => {
    const folder = stamped();
    const outside = join(owned("stamp-check-elsewhere-"), "check-stamp.ts");
    renameSync(join(folder, stampCheckerPath), outside);
    symlinkSync(outside, join(folder, stampCheckerPath));
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

  test("a stamp record that is a link to a stamp record outside the folder is broken, naming the stamp record", () => {
    const folder = stamped();
    const outside = join(owned("stamp-check-elsewhere-"), "record.json");
    renameSync(join(folder, stampRecordName), outside);
    symlinkSync(outside, join(folder, stampRecordName));
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

  test("a folder above the stamp checker replaced by a link is broken, naming that folder", () => {
    const folder = stamped();
    linkAway(folder, "scripts");
    expect(checkStamp(folder)).toEqual({
      status: "broken",
      findings: [
        {
          kind: "not-a-folder",
          path: "scripts",
          detail:
            "it leads to a stamp root or the stamp checker and is not a folder itself.",
        },
      ],
    });
  });
});
