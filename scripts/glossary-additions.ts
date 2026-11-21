import {
  mergeBaseOf,
  recordedEntries,
  recordedHitsFile,
  recordedUnusedTermsFile,
  textAt,
} from "./glossary.ts";

type Recorded = {
  readonly file: string;
  readonly list: string;
  readonly identity: readonly string[];
  readonly describe: (own: ReadonlyMap<string, unknown>) => string;
};

const recordedLists: readonly Recorded[] = [
  {
    file: recordedHitsFile,
    list: "hits",
    identity: ["path", "word", "declaration"],
    describe: (own) =>
      `a recorded hit for "${String(own.get("word"))}" in ${String(own.get("path"))}${own.get("declaration") === undefined ? "" : ` declaration ${String(own.get("declaration"))}`}`,
  },
  {
    file: recordedUnusedTermsFile,
    list: "terms",
    identity: ["term"],
    describe: (own) => `a recorded unused term "${String(own.get("term"))}"`,
  },
];

function identityOf(
  own: ReadonlyMap<string, unknown>,
  keys: readonly string[],
): string {
  return JSON.stringify(keys.map((key) => own.get(key)));
}

function isApproved(own: ReadonlyMap<string, unknown>): boolean {
  const approved = own.get("approved");
  return typeof approved === "string" && approved.trim() !== "";
}

function additionProblems(
  { file, list, identity, describe }: Recorded,
  base: string,
  current: string,
  revision: string,
): string[] {
  const before = new Set(
    recordedEntries(file, base, list).map((own) => identityOf(own, identity)),
  );
  return recordedEntries(file, current, list).flatMap((own) =>
    before.has(identityOf(own, identity)) || isApproved(own)
      ? []
      : [
          `${file} adds ${describe(own)}, which ${revision} does not record, so this change widens what the names check admits. Repair: remove it (rename the path, or use or remove the term); or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`,
        ],
  );
}

export function recordedAdditionProblems(
  root: string,
  revision: string,
  currentText: (path: string) => string,
): string[] {
  const base = mergeBaseOf(root, revision);
  return recordedLists.flatMap((recorded) =>
    additionProblems(
      recorded,
      textAt(root, base, recorded.file),
      currentText(recorded.file),
      revision,
    ),
  );
}
