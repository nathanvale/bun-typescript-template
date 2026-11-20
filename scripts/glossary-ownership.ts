export const ownershipFile = "glossary-ownership.json";
export const sharedExportFile = "tests/template/naming/shared-tool-words.txt";

const awaitingHeading = "### Entries awaiting kernel acceptance\n";
const sharedHeading = "### Shared tool words\n";
const termLine = /^\*\*(.+)\*\*:$/gm;

function only(text: string, heading: string): number {
  const at = text.indexOf(heading);
  if (at < 0 || text.indexOf(heading, at + heading.length) >= 0)
    throw new Error(
      `GLOSSARY.md needs exactly one "${heading.trim()}" heading. Repair: keep one, and no other heading with that text.`,
    );
  return at;
}

export function sharedSection(glossary: string): string {
  return glossary.slice(only(glossary, sharedHeading));
}

function namesIn(text: string): string[] {
  return [...text.matchAll(termLine)].map(([, name = ""]) => name);
}

export function awaitingEntries(glossary: string): string[] {
  const from = only(glossary, awaitingHeading);
  const to = only(glossary, sharedHeading);
  if (to < from)
    throw new Error(
      `GLOSSARY.md puts "${sharedHeading.trim()}" before "${awaitingHeading.trim()}". Repair: move the shared section after the awaiting entries.`,
    );
  return namesIn(glossary.slice(from, to));
}

export function sharedEntries(glossary: string): string[] {
  return namesIn(sharedSection(glossary));
}

function listedEntries(text: string): string[] {
  const parsed: unknown = JSON.parse(text);
  const list: unknown =
    typeof parsed === "object" && parsed !== null
      ? new Map(Object.entries(parsed)).get("kernelEntries")
      : undefined;
  if (!Array.isArray(list) || !list.every((n) => typeof n === "string"))
    throw new Error(
      `${ownershipFile} needs a "kernelEntries" array of strings. Repair: list each entry the kernel is to own.`,
    );
  return list.filter((n): n is string => typeof n === "string");
}

export function ownershipProblems(
  glossary: string,
  ownershipText: string,
): string[] {
  const listed = listedEntries(ownershipText);
  const awaiting = awaitingEntries(glossary);
  const shared = new Set(sharedEntries(glossary));
  return [
    ...awaiting
      .filter((name) => !listed.includes(name))
      .map(
        (name) =>
          `GLOSSARY.md holds "${name}" among the entries awaiting kernel acceptance, and ${ownershipFile} does not list it. Repair: list it in kernelEntries, or move its entry out of that section.`,
      ),
    ...listed
      .filter((name) => !awaiting.includes(name))
      .map(
        (name) =>
          `${ownershipFile} lists "${name}", and GLOSSARY.md does not hold it among the entries awaiting kernel acceptance. Repair: move its entry there, or remove it from kernelEntries.`,
      ),
    ...listed
      .filter((name) => shared.has(name))
      .map(
        (name) =>
          `${ownershipFile} lists "${name}", a shared tool word, so it would have two owners. Repair: remove it from kernelEntries; shared tool words stay template-owned.`,
      ),
  ];
}
