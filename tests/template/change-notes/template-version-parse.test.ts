import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CHANGE_NOTES_FOLDER,
  type ChangeNote,
  type ChangeNoteEntry,
  isValidChangeNoteFile,
  parseChangeNote,
} from "../../../scripts/change-notes.ts";
import { templateChangeNoteAffects } from "../../../scripts/check-change-notes.ts";
import {
  applyVersionBump,
  bumpFromChangeNotes,
  compareTemplateVersions,
  formatTemplateVersion,
  isValidIsoDate,
  nextTemplateVersion,
  normalizeLead,
  parseTemplateVersion,
  pluralCount,
  renderTemplateVersion,
  STARTING_TEMPLATE_VERSION,
  TemplateVersionRefusal,
} from "../../../scripts/template-version-parse.ts";

const ROOT = resolve(import.meta.dir, "../../..");

function note(overrides: Partial<ChangeNote> = {}): ChangeNote {
  return {
    kind: "added",
    breaking: false,
    affects: ["bootstrap"],
    summary: "Added template capability.",
    action: null,
    ...overrides,
  };
}

const sampleRenderEntries: readonly ChangeNoteEntry[] = [
  {
    file: "2026-11-21-internal.json",
    note: note({
      kind: "none",
      breaking: false,
      affects: [],
      summary: "Internal test cleanup.",
      action: null,
    }),
  },
  {
    file: "2026-11-21-fixed.json",
    note: note({
      kind: "fixed",
      breaking: false,
      affects: ["generated-repository"],
      summary: "Ignored .worktrees/ in generated .gitignore.",
      action: "Add .worktrees/ to .gitignore.",
    }),
  },
  {
    file: "2026-11-21-added.json",
    note: note({
      kind: "added",
      breaking: false,
      affects: ["kernel-pin", "bootstrap"],
      summary: "Added verify-cli pointer skill.",
      action: "Copy .agents/skills/verify-cli/SKILL.md.",
    }),
  },
  {
    file: "2026-11-21-breaking.json",
    note: note({
      kind: "removed",
      breaking: true,
      affects: ["generated-repository"],
      summary: "Removed check:write script alias.",
      action: "Use bun run format instead.",
    }),
  },
];

const expectedRenderedSection = [
  "# Template version 0.3.0 (2026-11-21)",
  "",
  "Generated repositories gain the verify-cli pointer skill and drop check:write.",
  "",
  "Affects: bootstrap, generated-repository, kernel-pin (1 breaking change, 2 consumer updates; 1 internal change omitted).",
  "",
  "## Breaking Changes",
  "",
  "- **generated-repository:** Removed check:write script alias. (`2026-11-21-breaking.json`)",
  "  - **Action:** Use bun run format instead.",
  "",
  "## Added",
  "",
  "- **kernel-pin, bootstrap:** Added verify-cli pointer skill. (`2026-11-21-added.json`)",
  "  - **Action:** Copy .agents/skills/verify-cli/SKILL.md.",
  "",
  "## Fixed",
  "",
  "- **generated-repository:** Ignored .worktrees/ in generated .gitignore. (`2026-11-21-fixed.json`)",
  "  - **Action:** Add .worktrees/ to .gitignore.",
  "",
].join("\n");

test("parses, formats, compares with Bun.semver, and refuses malformed versions", () => {
  expect(STARTING_TEMPLATE_VERSION).toBe("0.1.0");
  const parsed = parseTemplateVersion("0.1.0");
  expect(parsed).toEqual({ major: 0, minor: 1, patch: 0 });
  expect(Object.isFrozen(parsed)).toBe(true);
  expect(formatTemplateVersion(parsed)).toBe("0.1.0");
  expect(compareTemplateVersions("0.1.0", "0.2.0")).toBe(-1);
  expect(compareTemplateVersions("0.10.0", "0.2.0")).toBe(1);
  expect(compareTemplateVersions("0.3.1", "0.3.1")).toBe(0);
  expect(pluralCount(1, "note")).toBe("1 note");
  expect(pluralCount(2, "note")).toBe("2 notes");

  expect(() => parseTemplateVersion("v0.1.0")).toThrow(
    'Invalid template version "v0.1.0"',
  );
  expect(() => parseTemplateVersion("01.0.0")).toThrow(
    'Invalid template version "01.0.0"',
  );
  expect(() => parseTemplateVersion("0.1.0-beta.1")).toThrow(
    'Invalid template version "0.1.0-beta.1"',
  );
  expect(() => parseTemplateVersion(" 0.1.0 ")).toThrow(
    'Invalid template version " 0.1.0 "',
  );
});

test("before 1.0, breaking bumps minor, non-breaking bumps patch, and none-only cuts nothing", () => {
  const breakingNote = note({
    kind: "removed",
    breaking: true,
    action: "Remove the old flag.",
  });
  const addedNote = note({ kind: "added", breaking: false });
  const fixedNote = note({ kind: "fixed", breaking: false });
  const changedNote = note({ kind: "changed", breaking: false });
  const noneNote = note({ kind: "none", breaking: false, affects: [] });

  expect(bumpFromChangeNotes("0.1.0", [breakingNote])).toBe("minor");
  expect(nextTemplateVersion("0.1.0", [breakingNote])).toBe("0.2.0");
  expect(Bun.semver.satisfies("0.2.0", "^0.1.0")).toBe(false);

  expect(bumpFromChangeNotes("0.2.0", [breakingNote, addedNote])).toBe("minor");
  expect(nextTemplateVersion("0.2.0", [breakingNote, addedNote])).toBe("0.3.0");

  expect(bumpFromChangeNotes("0.3.0", [addedNote, fixedNote])).toBe("patch");
  expect(nextTemplateVersion("0.3.0", [addedNote, fixedNote])).toBe("0.3.1");
  expect(Bun.semver.satisfies("0.3.1", "^0.3.0")).toBe(true);

  expect(bumpFromChangeNotes("0.3.1", [changedNote])).toBe("patch");
  expect(nextTemplateVersion("0.3.1", [changedNote])).toBe("0.3.2");

  expect(bumpFromChangeNotes("0.3.0", [noneNote])).toBe("none");
  expect(nextTemplateVersion("0.3.0", [noneNote])).toBeUndefined();
  expect(nextTemplateVersion("0.3.0", [])).toBeUndefined();
  expect(applyVersionBump("0.3.0", "none")).toBe("0.3.0");
});

test("at 1.0 and above, breaking bumps major, added bumps minor, and fixed/changed bump patch", () => {
  const breakingNote = note({
    kind: "changed",
    breaking: true,
    action: "Update callers.",
  });
  const addedNote = note({ kind: "added", breaking: false });
  const fixedNote = note({ kind: "fixed", breaking: false });

  expect(nextTemplateVersion("1.2.3", [breakingNote, addedNote])).toBe("2.0.0");
  expect(nextTemplateVersion("1.2.3", [addedNote, fixedNote])).toBe("1.3.0");
  expect(nextTemplateVersion("1.2.3", [fixedNote])).toBe("1.2.4");
});

test("validates ISO calendar dates, lead sentences, and this pull request's change note", () => {
  expect(isValidIsoDate("2026-11-22")).toBe(true);
  expect(isValidIsoDate("2024-02-29")).toBe(true);
  expect(isValidIsoDate("2026-02-29")).toBe(false);
  expect(isValidIsoDate("2026-13-01")).toBe(false);
  expect(isValidIsoDate("2026-11-2")).toBe(false);
  expect(normalizeLead("  One-line summary.  ")).toBe("One-line summary.");
  expect(() => normalizeLead("   ")).toThrow("Lead sentence is required.");
  expect(() => normalizeLead("One.\nTwo.")).toThrow(
    "Lead sentence must be a single line.",
  );

  const refusal = new TemplateVersionRefusal("Refused.");
  expect(refusal).toBeInstanceOf(Error);
  expect(refusal.name).toBe("TemplateVersionRefusal");

  const file = "2026-11-22-template-version-sections.json";
  expect(isValidChangeNoteFile(file)).toBe(true);
  const raw = readFileSync(join(ROOT, CHANGE_NOTES_FOLDER, file), "utf8");
  const parsed = parseChangeNote(
    `${CHANGE_NOTES_FOLDER}/${file}`,
    raw,
    templateChangeNoteAffects,
  );
  expect(parsed.ok).toBe(true);
});

test("renders the lead sentence, grouped kinds, every action line, and omits none notes", () => {
  const text = renderTemplateVersion({
    version: "0.3.0",
    date: "2026-11-21",
    lead: "Generated repositories gain the verify-cli pointer skill and drop check:write.",
    entries: sampleRenderEntries,
  });

  expect(text).toBe(expectedRenderedSection);
  expect(text).not.toContain("Internal test cleanup.");
});

test("refuses invalid date in renderTemplateVersion", () => {
  expect(() =>
    renderTemplateVersion({
      version: "0.2.0",
      date: "2026-02-29",
      lead: "Valid lead.",
      entries: [{ file: "2026-11-21-a.json", note: note() }],
    }),
  ).toThrow('Invalid date "2026-02-29"');
});
