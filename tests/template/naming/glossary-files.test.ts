import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { mapProblems } from "../../../scripts/glossary-map.ts";
import {
  readGlossary,
  readRecordedUnusedTerms,
  recordedUnusedTermsFile,
  termUseProblems,
  trackedTexts,
} from "../../../scripts/glossary.ts";

const root = join(import.meta.dir, "../../..");
const ownedFolder = ownedFolders();

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

test("every path GLOSSARY-MAP.md points to exists", () => {
  expect(mapProblems(read("GLOSSARY-MAP.md"), root)).toEqual([]);
});

test("every GLOSSARY.md term is used in a tracked file outside the glossary files, apart from its recorded unused terms", () => {
  expect(
    termUseProblems(
      readGlossary(read("GLOSSARY.md")),
      trackedTexts(root),
      readRecordedUnusedTerms(read(recordedUnusedTermsFile)),
    ),
  ).toEqual([]);
});

test("the glossary files and the recorded unused terms are not read as uses of a term", () => {
  const texts = trackedTexts(root);
  expect(texts).not.toContain(read("GLOSSARY.md"));
  expect(texts).not.toContain(read("GLOSSARY-MAP.md"));
  expect(texts).not.toContain(read(recordedUnusedTermsFile));
  expect(texts).toContain(read("AGENTS.md"));
});

test("a map whose links all resolve has no problem", () => {
  expect(
    mapProblems("[here](GLOSSARY.md) and [web](https://example.test/x)", root),
  ).toEqual([]);
});

test("GM.a a map pointer to a missing path fails", () => {
  expect(
    mapProblems(
      "[here](GLOSSARY.md) and [gone](missing/GLOSSARY.md#language)",
      root,
    ),
  ).toEqual([
    "GLOSSARY-MAP.md points to missing/GLOSSARY.md, which does not exist. Repair: correct the link, or remove its row.",
  ]);
});

function mapIn(files: Record<string, string>): string {
  const folder = ownedFolder("map-");
  for (const [path, content] of Object.entries(files))
    write(folder, path, content);
  return folder;
}

const ownedMap = (rows: readonly string[]) =>
  ["| Glossary | Owns | Where |", "| --- | --- | --- |", ...rows].join("\n");

test("GM.h a link to a heading the target does not have fails, and one it has passes", () => {
  expect(mapProblems("[map](GLOSSARY-MAP.md#glossary-map)", root)).toEqual([]);
  expect(mapProblems("[map](GLOSSARY-MAP.md#no-such-heading)", root)).toEqual([
    "GLOSSARY-MAP.md points to GLOSSARY-MAP.md#no-such-heading, and GLOSSARY-MAP.md has no heading with that anchor. Repair: correct the anchor, or drop it.",
  ]);
});

test("GM.i an owner row with no name, or a second row for one owner, fails", () => {
  const rows = ownedMap([
    "|  | Words | [GLOSSARY.md](GLOSSARY.md) |",
    "| Kernel | Words | [here](GLOSSARY.md) |",
    "| kernel | More words | [there](AGENTS.md) |",
  ]);
  expect(mapProblems(rows, root)).toEqual([
    "GLOSSARY-MAP.md has a row with no owner name in its first cell. Repair: name the glossary or project that owns those words.",
    'GLOSSARY-MAP.md gives GLOSSARY.md to both "" and "Kernel". Repair: keep the row of the one that owns it.',
    'GLOSSARY-MAP.md lists the owner "kernel" in two rows, so its words have two owners. Repair: merge the rows.',
  ]);
});

test("GM.j an owner whose glossary file defines no term fails", () => {
  const folder = mapIn({ "GLOSSARY.md": "# Notes\nNo terms here.\n" });
  expect(
    mapProblems(
      ownedMap(["| Kernel | Words | [GLOSSARY.md](GLOSSARY.md) |"]),
      folder,
    ),
  ).toEqual([
    'GLOSSARY-MAP.md makes "Kernel" the owner of GLOSSARY.md, which defines no term. Repair: point the row at the glossary that defines its words.',
  ]);
});

test("GM.b a map that points to no file fails", () => {
  expect(
    mapProblems("Only [a web page](https://example.test/x).", root),
  ).toEqual([
    "GLOSSARY-MAP.md points to no glossary file, so this check would check nothing. Repair: link each glossary it names.",
  ]);
});

const fixture = readGlossary(`# Fixture glossary

**CLI starter**:
A program to start from.

**Test area**:
Tests that run together.
`);

test.each([
  ["prose that wraps a line", "two CLI\nstarters in one test area"],
  ["a camel-case name", "const testAreas = [cliStarter];"],
  ["a kebab-case name", "cli-starter.ts and test-area.ts"],
])("terms used in %s count as used", (_kind, text) => {
  expect(termUseProblems(fixture, [text], [])).toEqual([]);
});

const noStarterYet = ["a test area", "a starter for the CLI"];
const awaited = {
  term: "CLI starter",
  reason: "The ticket that builds it has not landed.",
  ticket: "MAG-1",
};

test("GM.c a glossary term used nowhere fails", () => {
  expect(termUseProblems(fixture, noStarterYet, [])).toEqual([
    `"CLI starter" appears in no tracked file outside the glossary files. Repair: use it, remove it from GLOSSARY.md, or record it in ${recordedUnusedTermsFile} with the ticket that will use it.`,
  ]);
});

test("a recorded unused term passes while nothing uses it", () => {
  expect(termUseProblems(fixture, noStarterYet, [awaited])).toEqual([]);
});

const endsInY = readGlossary(`# Fixture glossary

**Quiet gallery**:
A room nobody visits.
`);

test("a term that ends in y counts as used in its plural", () => {
  expect(termUseProblems(endsInY, ["two quiet galleries"], [])).toEqual([]);
});

test("a recorded unused term that ends in y fails once a tracked file uses its plural", () => {
  expect(
    termUseProblems(
      endsInY,
      ["two quiet galleries"],
      [{ term: "Quiet gallery", reason: "Not built yet.", ticket: "MAG-1" }],
    ),
  ).toEqual([
    `${recordedUnusedTermsFile} records "Quiet gallery", which a tracked file now uses. Repair: remove the entry.`,
  ]);
});

test("GM.d a recorded unused term that a tracked file now uses fails", () => {
  expect(
    termUseProblems(fixture, ["a test area", "a CLI starter"], [awaited]),
  ).toEqual([
    `${recordedUnusedTermsFile} records "CLI starter", which a tracked file now uses. Repair: remove the entry.`,
  ]);
});

test("GM.e a recorded unused term that GLOSSARY.md does not define fails", () => {
  expect(
    termUseProblems(
      fixture,
      ["a test area", "a CLI starter"],
      [{ ...awaited, term: "Layout" }],
    ),
  ).toEqual([
    `${recordedUnusedTermsFile} records "Layout", which GLOSSARY.md does not define. Repair: remove the entry.`,
  ]);
});

test("a recorded unused term is read with its reason and its ticket", () => {
  expect(readRecordedUnusedTerms(JSON.stringify({ terms: [awaited] }))).toEqual(
    [awaited],
  );
});

test.each([
  ["a reason", { term: "CLI starter", ticket: "MAG-1" }],
  ["a ticket", { term: "CLI starter", reason: "Not built yet." }],
  ["a term", { reason: "Not built yet.", ticket: "MAG-1" }],
])("GM.f a recorded unused term without %s is refused", (_field, entry) => {
  expect(() =>
    readRecordedUnusedTerms(JSON.stringify({ terms: [entry] })),
  ).toThrow(
    `${recordedUnusedTermsFile}: terms[0] needs a non-empty term, reason and ticket. Repair: write each one as a non-empty string.`,
  );
});

test("GM.g recorded unused terms with no terms list are refused", () => {
  expect(() => readRecordedUnusedTerms("{}")).toThrow(
    `${recordedUnusedTermsFile} has no "terms" array. Repair: add "terms": [] at its top level.`,
  );
});
