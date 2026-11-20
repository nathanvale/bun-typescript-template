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
});
