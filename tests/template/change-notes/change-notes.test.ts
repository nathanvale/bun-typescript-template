import { describe, expect, test } from "bun:test";
import { readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHANGE_NOTES_FOLDER,
  compareText,
  formatChangeNoteLines,
  isValidChangeNoteFile,
  parseChangeNote,
} from "../../../scripts/change-notes.ts";
import {
  checkChangeNotes,
  isShippedTemplatePath,
  runChangeNoteCheck,
  templateChangeNoteAffects,
} from "../../../scripts/check-change-notes.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { commit, git, initRepository } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const folder = ownedFolders();

function makeTemplateRepository(): string {
  const repo = join(folder("change-notes-gate-"), "repo");
  initRepository(repo);
  commit(repo, "init", {
    "docs/guide.md": "# Guide\n",
    "generated-repository/settings/package.json": "{}\n",
    "config/template-rules.mjs": "export default {};\n",
    "tests/support/test-folder.ts": "export const x = 1;\n",
    "src/recipe.ts": "export const r = 1;\n",
    "kernel-pin.json": "{}\n",
    [`${CHANGE_NOTES_FOLDER}/README.md`]: "# Change notes\n",
  });
  return repo;
}

describe("change note parsing and formatting", () => {
  test("accepts valid notes and returns a frozen object", () => {
    const parsed = parseChangeNote(
      "change-notes/2026-11-22-bootstrap-folder.json",
      JSON.stringify({
        kind: "added",
        breaking: false,
        affects: ["bootstrap", "generated-repository"],
        summary: "  Added change-notes/ to generated repositories.  ",
        action: null,
      }),
      templateChangeNoteAffects,
    );
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.note).toEqual({
        kind: "added",
        breaking: false,
        affects: ["bootstrap", "generated-repository"],
        summary: "Added change-notes/ to generated repositories.",
        action: null,
      });
      expect(Object.isFrozen(parsed.note)).toBe(true);
      expect(Object.isFrozen(parsed.note.affects)).toBe(true);
    }
  });

  test("validates this pull request's own first change note", () => {
    const file = "2026-11-22-template-change-notes.json";
    expect(isValidChangeNoteFile(file)).toBe(true);
    const raw = readFileSync(join(ROOT, CHANGE_NOTES_FOLDER, file), "utf8");
    const parsed = parseChangeNote(
      `${CHANGE_NOTES_FOLDER}/${file}`,
      raw,
      templateChangeNoteAffects,
    );
    expect(parsed.ok).toBe(true);
  });

  test("refuses malformed JSON, non-objects, missing fields, unknown fields, and broken invariants", () => {
    const expectRefused = (
      result: ReturnType<typeof parseChangeNote>,
      expected: string,
    ) => {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.problem).toContain(expected);
    };

    expectRefused(parseChangeNote("change-notes/a.json", "{"), "invalid JSON");
    expectRefused(
      parseChangeNote("change-notes/a.json", "[]"),
      "expected a JSON object",
    );
    expectRefused(
      parseChangeNote(
        "change-notes/a.json",
        JSON.stringify({
          kind: "fixed",
          breaking: false,
          affects: ["bootstrap"],
          summary: "Fixed copy.",
          action: null,
          extra: true,
        }),
      ),
      'unknown field "extra"',
    );
    expectRefused(
      parseChangeNote(
        "change-notes/a.json",
        JSON.stringify({
          kind: "fixed",
          breaking: false,
          affects: ["bootstrap"],
          summary: "Fixed copy.",
        }),
      ),
      'missing required field "action"',
    );
    expectRefused(
      parseChangeNote(
        "change-notes/a.json",
        JSON.stringify({
          kind: "changed",
          breaking: true,
          affects: ["bootstrap"],
          summary: "Changed recipe.",
          action: null,
        }),
        templateChangeNoteAffects,
      ),
      "breaking is true so action must explain",
    );
    expectRefused(
      parseChangeNote(
        "change-notes/a.json",
        JSON.stringify({
          kind: "none",
          breaking: true,
          affects: [],
          summary: "Internal cleanup.",
          action: "Nothing.",
        }),
      ),
      'a "none" note cannot set breaking to true',
    );
    expectRefused(
      parseChangeNote(
        "change-notes/a.json",
        JSON.stringify({
          kind: "added",
          breaking: false,
          affects: [],
          summary: "Added feature.",
          action: null,
        }),
      ),
      "affects must name at least one surface",
    );
    expectRefused(
      parseChangeNote(
        "change-notes/a.json",
        JSON.stringify({
          kind: "fixed",
          breaking: false,
          affects: ["unknown-surface"],
          summary: "Fixed thing.",
          action: null,
        }),
        templateChangeNoteAffects,
      ),
      'unknown affects entry "unknown-surface"',
    );
  });

  test("validates YYYY-MM-DD-<kebab-slug>.json filenames and calendar dates", () => {
    expect(isValidChangeNoteFile("2026-11-22-template-change-notes.json")).toBe(
      true,
    );
    expect(isValidChangeNoteFile("2026-02-29-not-leap.json")).toBe(false);
    expect(isValidChangeNoteFile("2026-13-01-bad-month.json")).toBe(false);
    expect(isValidChangeNoteFile("2026-11-22-Upper.json")).toBe(false);
    expect(isValidChangeNoteFile("note.json")).toBe(false);
    expect(compareText("a", "b")).toBe(-1);
    expect(compareText("b", "a")).toBe(1);
    expect(compareText("a", "a")).toBe(0);
  });

  test("formats breaking notes before Added, Changed, Fixed, Removed, and No consumer effect", () => {
    const lines = formatChangeNoteLines([
      {
        file: "2026-11-23-internal.json",
        note: {
          kind: "none",
          breaking: false,
          affects: [],
          summary: "Internal cleanup.",
          action: null,
        },
      },
      {
        file: "2026-11-22-fixed.json",
        note: {
          kind: "fixed",
          breaking: false,
          affects: ["lint-rules"],
          summary: "Fixed lint rule.",
          action: null,
        },
      },
      {
        file: "2026-11-21-added.json",
        note: {
          kind: "added",
          breaking: false,
          affects: ["bootstrap"],
          summary: "Added folder.",
          action: null,
        },
      },
      {
        file: "2026-11-24-breaking.json",
        note: {
          kind: "removed",
          breaking: true,
          affects: ["bootstrap"],
          summary: "Removed old flag.",
          action: "Drop the flag.",
        },
      },
    ]);
    expect(lines).toEqual([
      "BREAKING (1):",
      "  - [bootstrap] Removed old flag. (2026-11-24-breaking.json)",
      "    Action: Drop the flag.",
      "Added (1):",
      "  - [bootstrap] Added folder. (2026-11-21-added.json)",
      "Fixed (1):",
      "  - [lint-rules] Fixed lint rule. (2026-11-22-fixed.json)",
      "No consumer effect (1):",
      "  - Internal cleanup. (2026-11-23-internal.json)",
    ]);
  });
});

describe("shipped template paths and check:change-notes gate", () => {
  test("classifies shipped template paths from the recipe and excludes internal template files", () => {
    expect(
      isShippedTemplatePath("generated-repository/settings/package.json"),
    ).toBe(true);
    expect(isShippedTemplatePath("generated-repository/bun.lock")).toBe(true);
    expect(isShippedTemplatePath("config/template-rules.mjs")).toBe(true);
    expect(isShippedTemplatePath("tests/support/test-folder.ts")).toBe(true);
    expect(isShippedTemplatePath("src/recipe.ts")).toBe(true);
    expect(isShippedTemplatePath("src/bootstrap.ts")).toBe(true);
    expect(isShippedTemplatePath("kernel-pin.json")).toBe(true);

    expect(isShippedTemplatePath("config/template-rules.d.mts")).toBe(false);
    expect(isShippedTemplatePath("docs/agents/pull-requests.md")).toBe(false);
    expect(isShippedTemplatePath("scripts/check-change-notes.ts")).toBe(false);
    expect(isShippedTemplatePath("src/cli-inventory.ts")).toBe(false);
    expect(isShippedTemplatePath("tests/support/git-fixture.ts")).toBe(false);
  });

  test("passes when only non-shipped files change", () => {
    const repo = makeTemplateRepository();
    git(repo, "checkout", "-b", "docs-only");
    commit(repo, "docs change", { "docs/guide.md": "# Updated\n" });

    const result = checkChangeNotes(repo, "main");
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("none on the shipped template surface");
  });

  test("fails when a shipped file changes without adding a change note, and passes with a note or kind none", () => {
    const repo = makeTemplateRepository();
    git(repo, "checkout", "-b", "shipped");
    commit(repo, "shipped change", {
      "generated-repository/settings/package.json": '{"private":true}\n',
    });

    const red = checkChangeNotes(repo, "main");
    expect(red.code).toBe(1);
    expect(red.stderr).toContain(
      "changes 1 shipped file(s) (first: generated-repository/settings/package.json) without adding a change note",
    );

    commit(repo, "add none note", {
      [`${CHANGE_NOTES_FOLDER}/2026-11-22-internal.json`]: JSON.stringify({
        kind: "none",
        breaking: false,
        affects: [],
        summary: "Formatted package.json; no consumer effect.",
        action: null,
      }),
    });

    const green = checkChangeNotes(repo, "main");
    expect(green.code).toBe(0);
    expect(green.stderr).toBe("");
    expect(green.stdout).toContain("2026-11-22-internal.json");
  });

  test("refuses invalid filenames, nested notes, symlinks, and non-UTF-8 notes", () => {
    const repo = makeTemplateRepository();
    git(repo, "checkout", "-b", "bad-notes");
    commit(repo, "bad filename and nested note", {
      [`${CHANGE_NOTES_FOLDER}/not-dated.json`]: "{}",
      [`${CHANGE_NOTES_FOLDER}/sub/2026-11-22-nested.json`]: "{}",
    });
    const badNames = checkChangeNotes(repo, "main");
    expect(badNames.code).toBe(1);
    expect(badNames.stderr).toContain(
      "change-notes/not-dated.json: filename must match",
    );
    expect(badNames.stderr).toContain(
      "change-notes/sub/2026-11-22-nested.json: filename must match",
    );

    const bytesRepo = makeTemplateRepository();
    git(bytesRepo, "checkout", "-b", "bad-bytes");
    const notePath = join(
      bytesRepo,
      CHANGE_NOTES_FOLDER,
      "2026-11-22-bytes.json",
    );
    writeFileSync(notePath, new Uint8Array([0xff, 0xfe]));
    git(bytesRepo, "add", `${CHANGE_NOTES_FOLDER}/2026-11-22-bytes.json`);
    git(bytesRepo, "commit", "--quiet", "-m", "bad bytes");
    const badBytes = checkChangeNotes(bytesRepo, "main");
    expect(badBytes.code).toBe(1);
    expect(badBytes.stderr).toContain("is not valid UTF-8 text");

    const linkRepo = makeTemplateRepository();
    git(linkRepo, "checkout", "-b", "symlink-note");
    write(
      linkRepo,
      "outside.json",
      JSON.stringify({
        kind: "none",
        breaking: false,
        affects: [],
        summary: "Outside.",
        action: null,
      }),
    );
    symlinkSync(
      "../outside.json",
      join(linkRepo, CHANGE_NOTES_FOLDER, "2026-11-22-linked.json"),
    );
    git(
      linkRepo,
      "add",
      "outside.json",
      `${CHANGE_NOTES_FOLDER}/2026-11-22-linked.json`,
    );
    git(linkRepo, "commit", "--quiet", "-m", "linked note");
    const badLink = checkChangeNotes(linkRepo, "main");
    expect(badLink.code).toBe(1);
    expect(badLink.stderr).toContain(
      "change-notes/2026-11-22-linked.json: could not read plain file",
    );
  });

  test("exits 2 on invalid arguments or an unknown base revision", () => {
    const repo = makeTemplateRepository();
    expect(runChangeNoteCheck(["--unknown"], repo)).toEqual({
      stdout: "",
      stderr:
        "Usage: bun run check:change-notes [--base <revision>] [--root <folder>]\n",
      code: 2,
    });
    expect(runChangeNoteCheck(["--base"], repo).code).toBe(2);
    expect(runChangeNoteCheck(["--base", "-bad"], repo).code).toBe(2);

    const unknownBase = runChangeNoteCheck(
      ["--base", "no-such-revision", "--root", repo],
      repo,
    );
    expect(unknownBase.code).toBe(2);
    expect(unknownBase.stderr).toContain(
      "Repair: ensure the base revision exists",
    );
  });

  test(
    "runs the production CLI entry and exits 1 when a shipped file has no change note",
    async () => {
      const repo = makeTemplateRepository();
      git(repo, "checkout", "-b", "cli-proof");
      commit(repo, "change recipe", {
        "src/recipe.ts": "export const r = 2;\n",
      });

      const run = await spawnBounded(
        [
          process.execPath,
          "run",
          join(ROOT, "scripts/check-change-notes.ts"),
          "--base",
          "main",
          "--root",
          repo,
        ],
        { cwd: ROOT, processGroup: true },
      );
      expect(run.exit).toBe(1);
      expect(run.stderr).toContain(
        "changes 1 shipped file(s) (first: src/recipe.ts) without adding a change note",
      );
    },
    processWatchdog(1),
  );
});
