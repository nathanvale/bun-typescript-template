import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  pinMoveReport,
  pinMoveReportText,
} from "../../../scripts/pin-move-report.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { initRepository } from "../../support/git-fixture.ts";
import {
  commitObjects,
  stageRawPath,
} from "../../support/git-object-fixture.ts";
import { git } from "../../support/git-fixture.ts";

const folder = ownedFolders();

describe("the pin move report", () => {
  test("lists files added, changed and removed between two kernel commits, and the kernel's log lines, newest first", () => {
    const root = join(folder("pin-move-report-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: "kept.ts", bytes: "1\n" },
      { path: "changed.ts", bytes: "1\n" },
      { path: "removed.ts", bytes: "1\n" },
    ]);
    commitObjects(root, "second", [{ path: "changed.ts", bytes: "2\n" }]);
    const to = commitObjects(root, "third", [
      { path: "added.ts", bytes: "1\n" },
      { path: "removed.ts", removed: true },
    ]);
    const short = (commit: string) => git(root, "rev-parse", "--short", commit);
    expect(pinMoveReport(root, from, to)).toEqual({
      from,
      to,
      added: ["added.ts"],
      changed: ["changed.ts"],
      removed: ["removed.ts"],
      log: [`${short(to)} third`, `${short(`${to}^`)} second`],
    });
  });

  test("tells apart two file names whose bytes differ only where neither is UTF-8 text", () => {
    const root = join(folder("pin-move-report-"), "kernel");
    initRepository(root);
    stageRawPath(root, new Uint8Array([0x61, 0xff]), "1\n");
    const from = commitObjects(root, "first", []);
    git(root, "rm", "--cached", "--quiet", "-r", ".");
    stageRawPath(root, new Uint8Array([0x61, 0xfe]), "1\n");
    const to = commitObjects(root, "second", []);
    const { added, removed } = pinMoveReport(root, from, to);
    expect([added.length, removed.length]).toEqual([1, 1]);
  });

  test("as text names both commits, then what was written, kernel lockfile first, then each list with its count", () => {
    expect(
      pinMoveReportText(
        {
          from: "a".repeat(40),
          to: "b".repeat(40),
          added: ["new.ts"],
          changed: [],
          removed: ["old.ts"],
          log: ["bbbbbbb move it"],
        },
        ["generated-repository/bun.lock", "kernel-pin.json"],
      ),
    ).toBe(
      `Pin move report: ${"a".repeat(40)} to ${"b".repeat(40)}\nWritten in the template, kernel lockfile first and pin last (2):\n  generated-repository/bun.lock\n  kernel-pin.json\nKernel files added (1):\n  new.ts\nKernel files changed (0):\nKernel files removed (1):\n  old.ts\nKernel log (1):\n  bbbbbbb move it\n`,
    );
  });

  test("lists added kernel change notes first, breaking before non-breaking, when the kernel has a change-notes folder at the new Pin", () => {
    const root = join(folder("pin-move-report-notes-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: "change-notes/README.md", bytes: "# Change notes\n" },
      {
        path: "change-notes/2026-11-20-older.json",
        bytes: JSON.stringify({
          kind: "added",
          breaking: false,
          affects: ["kernel"],
          summary: "Earlier note.",
          action: null,
        }),
      },
    ]);
    const to = commitObjects(root, "second", [
      {
        path: "change-notes/2026-11-22-forensics.json",
        bytes: JSON.stringify({
          kind: "added",
          breaking: false,
          affects: ["verify-cli"],
          summary: "Added forensics command.",
          action: null,
        }),
      },
      {
        path: "change-notes/2026-11-23-drop-alias.json",
        bytes: JSON.stringify({
          kind: "removed",
          breaking: true,
          affects: ["addons/diagnostics"],
          summary: "Removed legacy alias.",
          action: "Import DiagnosticsAddon instead.",
        }),
      },
      {
        path: "change-notes/2026-11-23-internal.json",
        bytes: JSON.stringify({
          kind: "none",
          breaking: false,
          affects: [],
          summary: "Internal refactor.",
          action: null,
        }),
      },
    ]);

    const report = pinMoveReport(root, from, to);
    expect(report.changeNotes).toHaveLength(3);
    expect(report.changeNotes?.map((entry) => entry.file)).toEqual([
      "2026-11-22-forensics.json",
      "2026-11-23-drop-alias.json",
      "2026-11-23-internal.json",
    ]);

    const text = pinMoveReportText(report, ["kernel-pin.json"]);
    const notesIndex = text.indexOf("Kernel change notes (3):");
    const breakingIndex = text.indexOf("BREAKING (1):");
    const addedIndex = text.indexOf("Added (1):");
    const noneIndex = text.indexOf("No consumer effect (1):");
    const writtenIndex = text.indexOf(
      "Written in the template, kernel lockfile first and pin last (1):",
    );
    expect(notesIndex).toBeGreaterThan(-1);
    expect(notesIndex).toBeLessThan(breakingIndex);
    expect(breakingIndex).toBeLessThan(addedIndex);
    expect(addedIndex).toBeLessThan(noneIndex);
    expect(noneIndex).toBeLessThan(writtenIndex);
    expect(text).toContain("Action: Import DiagnosticsAddon instead.");
    expect(text).not.toContain("2026-11-20-older.json");
  });

  test("reports zero added kernel change notes when change-notes exists at the new Pin with no new JSON note", () => {
    const root = join(folder("pin-move-report-empty-notes-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: "change-notes/README.md", bytes: "# Change notes\n" },
    ]);
    const to = commitObjects(root, "second", [
      { path: "kernel/index.ts", bytes: "export const v = 2;\n" },
    ]);

    const report = pinMoveReport(root, from, to);
    expect(report.changeNotes).toEqual([]);
    const text = pinMoveReportText(report, ["kernel-pin.json"]);
    expect(text).toContain(
      `Pin move report: ${from} to ${to}\nKernel change notes (0):\nWritten in the template`,
    );
  });

  test("refuses a malformed or non-UTF-8 kernel change note added between Pins", () => {
    const root = join(folder("pin-move-report-bad-notes-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: "change-notes/README.md", bytes: "# Change notes\n" },
    ]);
    const badJson = commitObjects(root, "bad-json", [
      {
        path: "change-notes/2026-11-22-broken.json",
        bytes: JSON.stringify({
          kind: "changed",
          breaking: true,
          affects: ["kernel"],
          summary: "Breaking without action.",
          action: null,
        }),
      },
    ]);
    expect(() => pinMoveReport(root, from, badJson)).toThrow(
      "change-notes/2026-11-22-broken.json: breaking is true so action must explain what the reader must do.",
    );

    const badBytes = commitObjects(root, "bad-bytes", [
      { path: "change-notes/2026-11-22-broken.json", removed: true },
      {
        path: "change-notes/2026-11-22-bytes.json",
        bytes: new Uint8Array([0xff, 0xfe]),
      },
    ]);
    expect(() => pinMoveReport(root, from, badBytes)).toThrow(
      "change-notes/2026-11-22-bytes.json: kernel change note is not valid UTF-8 text.",
    );
  });
});
