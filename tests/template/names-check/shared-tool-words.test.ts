import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ownershipFile,
  ownershipProblems,
  sharedEntries,
  sharedExportFile,
  sharedSection,
} from "../../../scripts/glossary-ownership.ts";
import {
  readGlossary,
  readRecordedUnusedTerms,
  recordedUnusedTermsFile,
  termUseProblems,
  trackedTexts,
} from "../../../scripts/glossary.ts";

const root = join(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

const entry = (name: string) => `**${name}**:\nA definition.\n\n`;
const glossaryOf = (own: readonly string[], shared: readonly string[]) =>
  `# G\n\n### Own\n\n${own.map(entry).join("")}### Shared tool words\n\n${shared.map(entry).join("")}## Words that need a qualifier\n\n_Qualify_: host\n`;
const owned = (names: readonly string[]) =>
  JSON.stringify({ kernelEntries: names });

test("the shared tool words in GLOSSARY.md are the template's recorded export, byte for byte", () => {
  expect(sharedSection(read("GLOSSARY.md"))).toBe(read(sharedExportFile));
});

test("the shared tool words are 34 entries that stay template-owned", () => {
  expect(sharedEntries(read("GLOSSARY.md"))).toHaveLength(34);
});

test("GLOSSARY.md defines no entry that glossary-ownership.json lists as the kernel's", () => {
  expect(ownershipProblems(read("GLOSSARY.md"), read(ownershipFile))).toEqual(
    [],
  );
});

test("the export and glossary-ownership.json are not read as uses of a term", () => {
  const texts = trackedTexts(root);
  expect(texts).not.toContain(read(sharedExportFile));
  expect(texts).not.toContain(read(ownershipFile));
});

test("every term is used in a tracked file or recorded unused", () => {
  expect(
    termUseProblems(
      readGlossary(read("GLOSSARY.md")),
      trackedTexts(root),
      readRecordedUnusedTerms(read(recordedUnusedTermsFile)),
    ),
  ).toEqual([]);
});

test("a GLOSSARY.md entry naming a repository.json key absent from repository.json states none is declared yet", () => {
  const repoFields = new Map(
    Object.entries(
      JSON.parse(read("repository.json")) as Record<string, unknown>,
    ),
  );
  const entries = read("GLOSSARY.md").split(/\n(?=\*\*[^*]+\*\*:)/);
  const undeclared = entries.filter((block) => {
    const key = /`repository\.json` `([^`]+)`/.exec(block)?.[1];
    return key !== undefined && !repoFields.has(key);
  });
  expect(undeclared.length).toBeGreaterThan(0);
  for (const block of undeclared) {
    expect(block).not.toContain("The names check refuses a path");
    expect(block).toContain("this repository declares none yet.");
  }
});

test("SW.a the shared section ends at the end of the file, so a changed qualifier line is a difference", () => {
  const glossary = glossaryOf([], ["Gate"]);
  expect(sharedSection(glossary)).toContain("_Qualify_: host");
  expect(sharedSection(glossary).startsWith("### Shared tool words\n")).toBe(
    true,
  );
});

test("SW.b a glossary with two shared sections is refused", () => {
  const twice = `${glossaryOf([], ["Gate"])}### Shared tool words\n`;
  expect(() => sharedSection(twice)).toThrow(
    'GLOSSARY.md needs exactly one "### Shared tool words" heading. Repair: keep one, and no other heading with that text.',
  );
});

test("SW.c an entry that the kernel owns and GLOSSARY.md still defines is refused", () => {
  expect(
    ownershipProblems(glossaryOf(["Pin", "Recipe"], ["Gate"]), owned(["Pin"])),
  ).toEqual([
    'GLOSSARY.md defines "Pin", which the kernel owns and glossary-ownership.json lists. Repair: remove the entry and link the kernel\'s glossary instead.',
  ]);
});

test("SW.d a shared tool word that glossary-ownership.json lists is refused", () => {
  expect(ownershipProblems(glossaryOf([], ["Gate"]), owned(["Gate"]))).toEqual([
    'GLOSSARY.md defines "Gate", which the kernel owns and glossary-ownership.json lists. Repair: remove the entry and link the kernel\'s glossary instead.',
  ]);
});

test("SW.g a glossary-ownership.json whose kernelEntries is not an array of strings is refused", () => {
  const refusal =
    'glossary-ownership.json needs a "kernelEntries" array of strings. Repair: list each entry the kernel owns.';
  expect(() => ownershipProblems(glossaryOf([], []), "{}")).toThrow(refusal);
  expect(() =>
    ownershipProblems(glossaryOf([], []), '{"kernelEntries":[1]}'),
  ).toThrow(refusal);
});
