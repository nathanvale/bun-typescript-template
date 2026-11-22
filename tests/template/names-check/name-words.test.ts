import { afterAll, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  againstNameWordProblems,
  designWords,
  givenNameWordProblems,
  knownGlossaryWords,
  plainWordsFile,
  readNameWords,
  readPlainWords,
  splitWords,
  stagedNameWordProblems,
  unknownDeclarationProblems,
  unknownPathProblems,
} from "../../../scripts/name-words.ts";
import { gitInNamesCheck, readGlossary } from "../../../scripts/glossary.ts";
import {
  listedEntries,
  ownershipFile,
} from "../../../scripts/glossary-ownership.ts";
import { treeTexts } from "../../../scripts/staged-texts.ts";
import { git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  checkNames,
  fixtureRepository,
  removeFixtureTrees,
  repository,
  runFixtureGit,
} from "./fixture-tree.ts";
import {
  check,
  glossary,
  namesCheckFixture,
  put,
  samplePlainWords,
  thrownBy,
  unknownDeclarationLine,
  unknownPathLine,
} from "./names-check-fixture.ts";
import { write } from "../../support/fixture-files.ts";

const { plainWordsRepository } = namesCheckFixture();
afterAll(removeFixtureTrees);

test("the repository's names-plain-words.json is valid against GLOSSARY.md and glossary-ownership.json", () => {
  const glossaryText = readFileSync(join(repository, "GLOSSARY.md"), "utf8");
  const ownershipText = readFileSync(join(repository, ownershipFile), "utf8");
  const plainText = readFileSync(join(repository, plainWordsFile), "utf8");
  const words = readNameWords(glossaryText, plainText, ownershipText);
  expect(words.plain.get("apply")).toBeString();
  expect(words.plain.get("pattern")).toBeString();
  for (const design of designWords) expect(words.known.has(design)).toBe(true);
  for (const entry of listedEntries(ownershipText))
    for (const word of splitWords(entry))
      expect(words.known.has(word)).toBe(true);
});

test("splitWords splits at separators, digits and case transitions", () => {
  expect(splitWords("gizmoWidget")).toEqual(["gizmo", "widget"]);
  expect(splitWords("CLICommand")).toEqual(["cli", "command"]);
  expect(splitWords("check-names_2.test")).toEqual(["check", "names", "test"]);
});

test("NW.a a new folder and new file with a non-glossary word are refused across given paths, --staged, --against and --tool-call", async () => {
  const root = plainWordsRepository();
  expect(await check(root, ["src/gizmo-tools/gizmo.ts"])).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("src/gizmo-tools", "gizmo"),
      unknownPathLine("src/gizmo-tools", "tools"),
      unknownPathLine("src/gizmo-tools/gizmo.ts", "gizmo"),
      "",
    ].join("\n"),
  });

  const call = JSON.stringify({
    tool_name: "Write",
    tool_input: { file_path: join(root, "src/gizmo-tools/gizmo.ts") },
  });
  expect(
    await check(root, ["--tool-call"], () => Promise.resolve(call)),
  ).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("src/gizmo-tools", "gizmo"),
      unknownPathLine("src/gizmo-tools", "tools"),
      unknownPathLine("src/gizmo-tools/gizmo.ts", "gizmo"),
      "",
    ].join("\n"),
  });

  put(root, "src/gizmo-tools/gizmo.ts", "export const fault = 1;\n");
  git(root, "add", "--", "src/gizmo-tools/gizmo.ts");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("src/gizmo-tools", "gizmo"),
      unknownPathLine("src/gizmo-tools", "tools"),
      unknownPathLine("src/gizmo-tools/gizmo.ts", "gizmo"),
      "",
    ].join("\n"),
  });

  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: [
      unknownPathLine("src/gizmo-tools", "gizmo"),
      unknownPathLine("src/gizmo-tools", "tools"),
      unknownPathLine("src/gizmo-tools/gizmo.ts", "gizmo"),
      "",
    ].join("\n"),
  });
});

test("NW.b a new exported symbol with a non-glossary word is refused across given paths, --staged and --against", async () => {
  const root = plainWordsRepository();
  put(
    root,
    "src/planted-fault.ts",
    "export const plantedFault = 1;\nexport const gizmoWidget = 2;\n",
  );
  const expected = [
    unknownDeclarationLine("src/planted-fault.ts", 2, "gizmoWidget", "gizmo"),
    unknownDeclarationLine("src/planted-fault.ts", 2, "gizmoWidget", "widget"),
    "",
  ].join("\n");

  expect(await check(root, ["src/planted-fault.ts"])).toEqual({
    code: 1,
    stderr: expected,
  });

  git(root, "add", "--", "src/planted-fault.ts");
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: expected,
  });

  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 1,
    stderr: expected,
  });
});

test("a new folder, file and exported symbol with glossary words, design words, kernel words or plain words pass", async () => {
  const root = plainWordsRepository(samplePlainWords, {
    [ownershipFile]: JSON.stringify({
      kernelEntries: ["Pin", "Add-on selection"],
    }),
  });
  put(
    root,
    "src/seam-patterns/apply-pins.ts",
    "export const applyPatterns = 1;\nexport const plantedFaults = 2;\nexport const moduleSeam = 3;\nexport const addOnSelections = 4;\n",
  );
  expect(await check(root, ["src/seam-patterns/apply-pins.ts"])).toEqual({
    code: 0,
    stderr: "",
  });
  git(root, "add", "--", "src/seam-patterns/apply-pins.ts");
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 0,
    stderr: "",
  });
});

test.each([
  [
    "missing words array",
    "{}",
    `${plainWordsFile} has no "words" array. Repair: add "words": [] at its top level.`,
  ],
  [
    "entry without reason",
    JSON.stringify({ words: [{ word: "apply" }] }),
    `${plainWordsFile}: words[0] needs a non-empty word and reason. Repair: write each one as a non-empty string.`,
  ],
  [
    "entry with blank reason",
    JSON.stringify({ words: [{ word: "apply", reason: "   " }] }),
    `${plainWordsFile}: words[0] needs a non-empty word and reason. Repair: write each one as a non-empty string.`,
  ],
  [
    "entry with non-lowercase word",
    JSON.stringify({ words: [{ word: "Apply", reason: "Capitalized." }] }),
    `${plainWordsFile}: words[0] word "Apply" must be one lowercase word. Repair: write a single lowercase word of letters only.`,
  ],
  [
    "duplicate word",
    JSON.stringify({
      words: [
        { word: "apply", reason: "First." },
        { word: "apply", reason: "Second." },
      ],
    }),
    `${plainWordsFile} lists "apply" twice. Repair: remove the duplicate entry.`,
  ],
  [
    "word already in glossary",
    JSON.stringify({ words: [{ word: "faults", reason: "Already defined." }] }),
    `${plainWordsFile} lists "faults", which is already a glossary word. Repair: remove it from ${plainWordsFile}, because it belongs to the glossary.`,
  ],
  [
    "unsorted words",
    JSON.stringify({
      words: [
        { word: "pattern", reason: "Second." },
        { word: "apply", reason: "First." },
      ],
    }),
    `${plainWordsFile} is not sorted at "apply" (after "pattern"). Repair: sort words alphabetically.`,
  ],
])("NW.c readPlainWords refuses %s", (_kind, text, expected) => {
  const known = knownGlossaryWords(glossary);
  expect(() => readPlainWords(text, known)).toThrow(expected);
});

test("--staged reads staged names-plain-words.json and refuses when a tracked plain-words file is missing from the index", async () => {
  const root = plainWordsRepository();
  put(root, "src/gizmo.ts", "export const fault = 1;\n");
  git(root, "add", "--", "src/gizmo.ts");
  put(
    root,
    plainWordsFile,
    JSON.stringify({
      words: [
        { word: "apply", reason: "Approved." },
        { word: "gizmo", reason: "Unstaged only." },
        { word: "pattern", reason: "Approved." },
        { word: "src", reason: "Fixture." },
      ],
    }),
  );
  expect(await check(root, ["--staged"])).toEqual({
    code: 1,
    stderr: `${unknownPathLine("src/gizmo.ts", "gizmo")}\n`,
  });

  git(root, "add", "--", plainWordsFile);
  put(root, plainWordsFile, samplePlainWords);
  expect(await check(root, ["--staged"])).toEqual({ code: 0, stderr: "" });

  git(root, "rm", "--cached", "-f", "--quiet", "--", plainWordsFile);
  expect(await check(root, ["--staged"])).toEqual({
    code: 2,
    stderr: `git has no staged ${plainWordsFile}, so the names check cannot judge a commit by the ${plainWordsFile} it will contain. Repair: stage it with git add ${plainWordsFile}, then run the names check again.\n`,
  });
});

test("--against exits 2 when names-plain-words.json existed at the base and is missing from the tree", async () => {
  const root = plainWordsRepository();
  rmSync(join(root, plainWordsFile));
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    code: 2,
    stderr: `${plainWordsFile} exists at HEAD but is missing from this tree. Repair: restore it with git restore ${plainWordsFile}.\n`,
  });
});

test("planted fault patch filenames strip their leading commit SHA while still judging the descriptive words", () => {
  const parsed = readGlossary(glossary);
  const words = readNameWords(glossary, samplePlainWords);
  expect(
    unknownPathProblems(words, parsed, [
      {
        path: "tests/planted-faults/patches/a0ae6f4-planted-fault-apply.patch",
        isFile: true,
      },
    ]),
  ).toEqual([]);
  expect(
    unknownPathProblems(words, parsed, [
      {
        path: "tests/planted-faults/patches/a0ae6f4-gizmo.patch",
        isFile: true,
      },
    ]),
  ).toEqual([
    unknownPathLine(
      "tests/planted-faults/patches/a0ae6f4-gizmo.patch",
      "gizmo",
    ),
  ]);
  expect(
    unknownDeclarationProblems(words, parsed, [
      {
        path: "src/planted-fault.ts",
        line: 3,
        name: "gizmo",
        declaration: "gizmo",
      },
    ]),
  ).toEqual([
    unknownDeclarationLine("src/planted-fault.ts", 3, "gizmo", "gizmo"),
  ]);
});

test("in-process exports and treeTexts work directly", async () => {
  const root = plainWordsRepository();
  const committed = treeTexts(
    root,
    "HEAD",
    (path) => path === "src/planted-fault.ts",
  );
  expect(committed.get("src/planted-fault.ts")).toBe(
    "export const plantedFault = 1;\n",
  );
  expect(await givenNameWordProblems(root, ["src/gizmo.ts"])).toEqual([
    unknownPathLine("src/gizmo.ts", "gizmo"),
  ]);
  expect(await stagedNameWordProblems(root)).toEqual([]);
  expect(await againstNameWordProblems(root, "HEAD")).toEqual([]);
  expect(
    gitInNamesCheck(root, ["rev-parse", "--verify", "HEAD"]).exitCode,
  ).toBe(0);
  expect(thrownBy(() => treeTexts(root, "missing-ref", () => true))).toContain(
    "could not read the public surface at missing-ref",
  );
});

test(
  "new-names rule is reachable through the production names check entry",
  async () => {
    const root = await fixtureRepository();
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    write(root, plainWordsFile, samplePlainWords);
    await runFixtureGit(root, "add", "--", plainWordsFile);
    await runFixtureGit(root, "commit", "--quiet", "-m", "plain words");
    expect(await checkNames(root, ["src/gizmo.ts"])).toEqual({
      stdout: "",
      stderr: `${unknownPathLine("src/gizmo.ts", "gizmo")}\n`,
      exit: 1,
    });
    expect(await checkNames(root, ["src/apply-pattern.ts"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  },
  processWatchdog(5),
);
