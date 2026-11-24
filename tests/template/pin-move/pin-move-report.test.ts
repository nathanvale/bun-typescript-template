import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  pinMoveReport,
  pinMoveReportText,
} from "../../../scripts/pin-move-report.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, initRepository } from "../../support/git-fixture.ts";
import {
  commitObjects,
  stageRawPath,
} from "../../support/git-object-fixture.ts";

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

  test("lists added kernel changesets first, major before minor before empty, when the kernel has a .changeset folder at the new Pin", () => {
    const root = join(folder("pin-move-report-changesets-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: ".changeset/README.md", bytes: "# Changesets\n" },
      {
        path: ".changeset/2026-11-20-older.md",
        bytes: '---\n"agent-cli-kernel": minor\n---\n\nEarlier changeset.\n',
      },
    ]);
    const to = commitObjects(root, "second", [
      {
        path: ".changeset/2026-11-22-forensics.md",
        bytes:
          '---\n"agent-cli-kernel": minor\n---\n\nAdded forensics command.\n',
      },
      {
        path: ".changeset/2026-11-23-drop-alias.md",
        bytes:
          '---\n"agent-cli-kernel": major\n---\n\nRemoved legacy alias.\n\nAction: Import DiagnosticsAddon instead.\n',
      },
      {
        path: ".changeset/2026-11-23-internal.md",
        bytes: "---\n\n---\n",
      },
    ]);

    const report = pinMoveReport(root, from, to);
    expect(report.changesets).toHaveLength(3);
    expect(
      report.changesets?.map((entry) => [entry.file, entry.level]),
    ).toEqual([
      ["2026-11-23-drop-alias.md", "major"],
      ["2026-11-22-forensics.md", "minor"],
      ["2026-11-23-internal.md", "none"],
    ]);

    const text = pinMoveReportText(report, ["kernel-pin.json"]);
    const sectionIndex = text.indexOf("Kernel changesets (3):");
    const majorIndex = text.indexOf("MAJOR (1):");
    const minorIndex = text.indexOf("Minor (1):");
    const noneIndex = text.indexOf("No consumer effect (1):");
    const writtenIndex = text.indexOf(
      "Written in the template, kernel lockfile first and pin last (1):",
    );
    expect(sectionIndex).toBeGreaterThan(-1);
    expect(sectionIndex).toBeLessThan(majorIndex);
    expect(majorIndex).toBeLessThan(minorIndex);
    expect(minorIndex).toBeLessThan(noneIndex);
    expect(noneIndex).toBeLessThan(writtenIndex);
    expect(text).toContain("Action: Import DiagnosticsAddon instead.");
    expect(text).not.toContain("2026-11-20-older.md");
  });

  test("reports zero added kernel changesets when .changeset exists at the new Pin with no new Markdown file", () => {
    const root = join(folder("pin-move-report-empty-changesets-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: ".changeset/README.md", bytes: "# Changesets\n" },
    ]);
    const to = commitObjects(root, "second", [
      { path: "kernel/index.ts", bytes: "export const v = 2;\n" },
    ]);

    const report = pinMoveReport(root, from, to);
    expect(report.changesets).toEqual([]);
    const text = pinMoveReportText(report, ["kernel-pin.json"]);
    expect(text).toContain(
      `Pin move report: ${from} to ${to}\nKernel changesets (0):\nWritten in the template`,
    );
  });

  test("refuses a malformed or non-UTF-8 kernel changeset added between Pins", () => {
    const root = join(folder("pin-move-report-bad-changesets-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: ".changeset/README.md", bytes: "# Changesets\n" },
    ]);
    const badFrontmatter = commitObjects(root, "bad-frontmatter", [
      {
        path: ".changeset/2026-11-22-broken.md",
        bytes: "missing frontmatter\n",
      },
    ]);
    expect(() => pinMoveReport(root, from, badFrontmatter)).toThrow(
      ".changeset/2026-11-22-broken.md: could not parse changeset",
    );

    const badBytes = commitObjects(root, "bad-bytes", [
      { path: ".changeset/2026-11-22-broken.md", removed: true },
      {
        path: ".changeset/2026-11-22-bytes.md",
        bytes: new Uint8Array([0xff, 0xfe]),
      },
    ]);
    expect(() => pinMoveReport(root, from, badBytes)).toThrow(
      "is not valid UTF-8",
    );
  });

  test("refuses a kernel changeset whose filename is not valid UTF-8 and preserves a leading BOM in a valid filename", () => {
    const root = join(folder("pin-move-report-bad-name-"), "kernel");
    initRepository(root);
    const from = commitObjects(root, "first", [
      { path: ".changeset/README.md", bytes: "# Changesets\n" },
    ]);
    const validMarkdown =
      '---\n"agent-cli-kernel": patch\n---\n\nValid changeset body.\n';
    const badNameBytes = Buffer.concat([
      Buffer.from(".changeset/2026-11-22-"),
      Buffer.from([0xff]),
      Buffer.from(".md"),
    ]);
    stageRawPath(root, badNameBytes, validMarkdown);
    const toBad = commitObjects(root, "bad-name", []);
    expect(() => pinMoveReport(root, from, toBad)).toThrow(
      "changeset filename is not valid UTF-8 text",
    );
    expect(() => pinMoveReport(root, from, toBad)).toThrow("ff2e6d64");

    git(root, "rm", "--cached", "--quiet", "-r", ".changeset");
    commitObjects(root, "restore-readme", [
      { path: ".changeset/README.md", bytes: "# Changesets\n" },
    ]);
    const bomNameBytes = Buffer.concat([
      Buffer.from(".changeset/"),
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from("2026-11-22-bom.md"),
    ]);
    stageRawPath(root, bomNameBytes, validMarkdown);
    const toBom = commitObjects(root, "bom-name", []);
    const bomReport = pinMoveReport(root, from, toBom);
    expect(bomReport.changesets?.map((entry) => entry.file)).toEqual([
      "\uFEFF2026-11-22-bom.md",
    ]);
  });
});
