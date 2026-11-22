import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nameProblems,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  trackedNames,
} from "../../../scripts/glossary.ts";

const root = join(import.meta.dir, "../../..");

const fixture = readGlossary(`# Fixture glossary

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

**Layout**:
One package or many.
_Avoid_: variant

_Qualify_: host, proof
`);

test("every tracked name uses glossary words, apart from its recorded hits", () => {
  const glossary = readGlossary(
    readFileSync(join(root, "GLOSSARY.md"), "utf8"),
  );
  const recorded = readRecordedHits(
    readFileSync(join(root, recordedHitsFile), "utf8"),
  );
  expect(nameProblems(trackedNames(root), glossary, recorded)).toEqual([]);
});

test("a folder and the files under it are each judged by their own name", () => {
  const names = trackedNames(root);
  expect(
    [
      "tests",
      "tests/template/standards",
      "tests/template/standards/standards.test.ts",
    ].filter((name) => !names.includes(name)),
  ).toEqual([]);
});

test("names that use only glossary words have no problem", () => {
  expect(
    nameProblems(
      ["src", "src/test-host-lint.ts", "docs/test-proof.md", "tests/known.ts"],
      fixture,
      [],
    ),
  ).toEqual([]);
});

test.each([
  ["a file", "tests/known-hits.json", "known hit", "Recorded hit"],
  ["a folder", "src/allowlist", "allowlist", "Recorded hit"],
  ["a camel-case file", "src/layoutVariants.ts", "variant", "Layout"],
])(
  "NM.a %s named with an Avoid word is a new hit",
  (_kind, path, word, term) => {
    expect(nameProblems([path], fixture, [])).toEqual([
      `${path} uses "${word}", which GLOSSARY.md lists under Avoid for "${term}". Repair: Look in the glossary first; rename it with "${term}".`,
    ]);
  },
);

test.each([
  ["a bare folder", "hosts"],
  ["a bare file", "docs/PROOF.md"],
  ["a bare test file", "tests/host.test.ts"],
])("NM.b %s that uses a qualify word alone is a new hit", (_kind, path) => {
  const word = path.toLowerCase().includes("host") ? "host" : "proof";
  expect(nameProblems([path], fixture, [])).toEqual([
    `${path} uses "${word}" with no qualifier. Repair: Look in the glossary first; add a word that says which ${word} it is.`,
  ]);
});

const withNotes = readGlossary(`# Fixture glossary

**Layout**:
One package or many.
_Avoid_: floor plan; shape, form (for a layout), reader (unqualified; a note, with a comma), variant
`);

test("a word that a note covers is left to the reviewer", () => {
  expect(
    nameProblems(
      [
        "src/shape.ts",
        "src/form-notes.ts",
        "src/reader.ts",
        "docs/with-a-comma.md",
        "docs/for-a-layout.md",
      ],
      withNotes,
      [],
    ),
  ).toEqual([]);
});

test.each([
  ["before a semicolon", "src/floor-plan.ts", "floor plan"],
  ["after the last note", "tests/variant.test.ts", "variant"],
])(
  "NM.d %s, an Avoid word with no note after it is a new hit",
  (_place, path, word) => {
    expect(nameProblems([path], withNotes, [])).toEqual([
      `${path} uses "${word}", which GLOSSARY.md lists under Avoid for "Layout". Repair: Look in the glossary first; rename it with "Layout".`,
    ]);
  },
);

test.each([
  ["that never closes", "shape (for a layout, form"],
  ["inside another", "shape (for a layout (of packages)), form"],
  ["that never opened", "shape for a layout), form"],
])("NM.e an Avoid line with a parenthesis %s is refused", (_kind, list) => {
  expect(() =>
    readGlossary(`**Layout**:\nOne package or many.\n_Avoid_: ${list}\n`),
  ).toThrow(
    'GLOSSARY.md: the Avoid line for "Layout" has a parenthesis with no partner, so the words its note covers cannot be told. Repair: close each note, and put no note inside another.',
  );
});

test("a recorded hit admits its name and no other", () => {
  const recorded = [{ path: "hosts", word: "host", reason: "fixture" }];
  expect(nameProblems(["hosts"], fixture, recorded)).toEqual([]);
  expect(nameProblems(["hosts", "src/hosts"], fixture, recorded)).toEqual([
    'src/hosts uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.',
  ]);
});

test.each([
  ["whose path is gone", ["src"]],
  ["whose name no longer uses the word", ["src", "src/test-hosts"]],
])("NM.c a recorded hit %s fails", (_kind, paths) => {
  const recorded = [
    { path: "src/test-hosts", word: "host", reason: "fixture" },
  ];
  expect(nameProblems(paths, fixture, recorded)).toEqual([
    `${recordedHitsFile} records "host" in src/test-hosts, which no longer occurs. Repair: remove the recorded hit.`,
  ]);
});

test("new name problems leave a stale recorded hit to the tracked names check", () => {
  const recorded = [
    { path: "src/test-hosts", word: "host", reason: "fixture" },
  ];
  expect(newNameProblems(["src", "hosts"], fixture, recorded)).toEqual([
    'hosts uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.',
  ]);
});

test("a recorded hit without a reason is refused", () => {
  expect(() =>
    readRecordedHits(
      JSON.stringify({ hits: [{ path: "hosts", word: "host" }] }),
    ),
  ).toThrow(
    `${recordedHitsFile}: hits[0] needs a non-empty path, word and reason. Repair: write each one as a non-empty string.`,
  );
});
