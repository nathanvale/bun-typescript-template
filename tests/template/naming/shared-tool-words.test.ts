import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  awaitingEntries,
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
const glossaryOf = (awaiting: readonly string[], shared: readonly string[]) =>
  `# G\n\n### Entries awaiting kernel acceptance\n\n${awaiting.map(entry).join("")}### Shared tool words\n\n${shared.map(entry).join("")}## Words that need a qualifier\n\n_Qualify_: host\n`;
const owned = (names: readonly string[]) =>
  JSON.stringify({ kernelEntries: names });

test("the shared tool words in GLOSSARY.md are the template's recorded export, byte for byte", () => {
  expect(sharedSection(read("GLOSSARY.md"))).toBe(read(sharedExportFile));
});

test("the shared tool words are 29 entries that stay template-owned", () => {
  expect(sharedEntries(read("GLOSSARY.md"))).toHaveLength(29);
});

test("the entries awaiting kernel acceptance are the ones glossary-ownership.json lists", () => {
  expect(ownershipProblems(read("GLOSSARY.md"), read(ownershipFile))).toEqual(
    [],
  );
});

test("the export and glossary-ownership.json are not read as uses of a term", () => {
  const texts = trackedTexts(root);
  expect(texts).not.toContain(read(sharedExportFile));
  expect(texts).not.toContain(read(ownershipFile));
});

test("every term, including the awaiting entries, is used in a tracked file or recorded unused", () => {
  expect(
    termUseProblems(
      readGlossary(read("GLOSSARY.md")),
      trackedTexts(root),
      readRecordedUnusedTerms(read(recordedUnusedTermsFile)),
    ),
  ).toEqual([]);
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

test("SW.c a shared section placed before the awaiting entries is refused", () => {
  const swapped = `### Shared tool words\n\n${entry("Gate")}### Entries awaiting kernel acceptance\n\n${entry("Pin")}`;
  expect(() => awaitingEntries(swapped)).toThrow(
    'GLOSSARY.md puts "### Shared tool words" before "### Entries awaiting kernel acceptance". Repair: move the shared section after the awaiting entries.',
  );
});

test("SW.d an awaiting entry that glossary-ownership.json does not list is refused", () => {
  expect(
    ownershipProblems(glossaryOf(["Pin", "Add-on"], ["Gate"]), owned(["Pin"])),
  ).toEqual([
    'GLOSSARY.md holds "Add-on" among the entries awaiting kernel acceptance, and glossary-ownership.json does not list it. Repair: list it in kernelEntries, or move its entry out of that section.',
  ]);
});

test("SW.e a listed entry that is not awaiting kernel acceptance is refused", () => {
  expect(
    ownershipProblems(glossaryOf(["Pin"], ["Gate"]), owned(["Pin", "Recipe"])),
  ).toEqual([
    'glossary-ownership.json lists "Recipe", and GLOSSARY.md does not hold it among the entries awaiting kernel acceptance. Repair: move its entry there, or remove it from kernelEntries.',
  ]);
});

test("SW.f a shared tool word that glossary-ownership.json lists is refused", () => {
  expect(
    ownershipProblems(glossaryOf(["Gate"], ["Gate"]), owned(["Gate"])),
  ).toEqual([
    'glossary-ownership.json lists "Gate", a shared tool word, so it would have two owners. Repair: remove it from kernelEntries; shared tool words stay template-owned.',
  ]);
});

test("SW.g a glossary-ownership.json whose kernelEntries is not an array of strings is refused", () => {
  const refusal =
    'glossary-ownership.json needs a "kernelEntries" array of strings. Repair: list each entry the kernel is to own.';
  expect(() => ownershipProblems(glossaryOf([], []), "{}")).toThrow(refusal);
  expect(() =>
    ownershipProblems(glossaryOf([], []), '{"kernelEntries":[1]}'),
  ).toThrow(refusal);
});
