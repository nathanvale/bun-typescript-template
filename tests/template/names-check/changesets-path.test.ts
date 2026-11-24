import { expect, test } from "bun:test";
import {
  hitsIn,
  isChangesetMarkdownPath,
  readGlossary,
} from "../../../scripts/glossary.ts";
import {
  readNameWords,
  unknownPathProblems,
} from "../../../scripts/plain-words.ts";
import { repository } from "./fixture-tree.ts";
import { check, glossary, samplePlainWords } from "./names-check-fixture.ts";

const changesetGlossary = `${glossary}
**Changeset**:
One Markdown file under .changeset/.
_Avoid_: change note, release note; changelog (for a changeset)

**Gated path**:
A path requiring a changeset.
_Avoid_: shipped path
`;

test("isChangesetMarkdownPath matches top-level and pre/ changeset markdown files while excluding README.md and other paths", () => {
  expect(isChangesetMarkdownPath(".changeset/plenty-pianos-draw.md")).toBe(
    true,
  );
  expect(isChangesetMarkdownPath(".changeset/pre/plenty-pianos-draw.md")).toBe(
    true,
  );
  expect(
    isChangesetMarkdownPath(".changeset/2026-11-22-template-change-notes.md"),
  ).toBe(true);
  expect(isChangesetMarkdownPath(".changeset/README.md")).toBe(false);
  expect(isChangesetMarkdownPath(".changeset/pre/README.md")).toBe(false);
  expect(isChangesetMarkdownPath(".changeset/config.json")).toBe(false);
  expect(isChangesetMarkdownPath(".changeset/nested/deep/file.md")).toBe(false);
  expect(isChangesetMarkdownPath(".changeset")).toBe(false);
  expect(isChangesetMarkdownPath("change-notes/foo.json")).toBe(false);
});

test("hitsIn and unknownPathProblems exempt changeset markdown paths while still refusing declarations, README.md, and change-notes paths", async () => {
  const parsed = readGlossary(changesetGlossary);
  const words = readNameWords(changesetGlossary, samplePlainWords);

  expect(
    hitsIn(".changeset/2026-11-22-template-change-notes.md", parsed),
  ).toEqual([]);
  expect(hitsIn(".changeset/pre/2026-11-22-change-note.md", parsed)).toEqual(
    [],
  );
  expect(
    hitsIn(".changeset/plenty-pianos-draw.md", parsed, "changeNote"),
  ).toHaveLength(1);
  expect(
    hitsIn("change-notes", parsed).map(({ word, rule }) => ({ word, rule })),
  ).toEqual([{ word: "change note", rule: "Avoid" }]);

  expect(
    unknownPathProblems(words, parsed, [
      { path: ".changeset/plenty-pianos-draw.md", isFile: true },
      { path: ".changeset/pre/plenty-pianos-draw.md", isFile: true },
      { path: ".changeset/2026-11-22-template-change-notes.md", isFile: true },
    ]),
  ).toEqual([]);
  expect(
    unknownPathProblems(words, parsed, [
      { path: ".changeset/nested/gizmo.md", isFile: true },
    ]),
  ).toHaveLength(1);

  expect(
    await check(repository, [
      ".changeset/plenty-pianos-draw.md",
      ".changeset/pre/plenty-pianos-draw.md",
      ".changeset/config.json",
      "scripts/check-gated-paths.ts",
    ]),
  ).toEqual({ code: 0, stderr: "" });

  const legacy = await check(repository, ["change-notes/foo.json"]);
  expect(legacy.code).toBe(1);
  expect(legacy.stderr).toContain('lists under Avoid for "Changeset"');
});
