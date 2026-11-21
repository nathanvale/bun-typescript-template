export const ownershipFile = "glossary-ownership.json";
export const sharedExportFile =
  "tests/template/names-check/shared-tool-words.txt";

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
      `${ownershipFile} needs a "kernelEntries" array of strings. Repair: list each entry the kernel owns.`,
    );
  return list.filter((n): n is string => typeof n === "string");
}

export function ownershipProblems(
  glossary: string,
  ownershipText: string,
): string[] {
  const defined = new Set(namesIn(glossary));
  return listedEntries(ownershipText)
    .filter((name) => defined.has(name))
    .map(
      (name) =>
        `GLOSSARY.md defines "${name}", which the kernel owns and ${ownershipFile} lists. Repair: remove the entry and link the kernel's glossary instead.`,
    );
}
