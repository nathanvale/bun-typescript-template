import {
  gitInNamesCheck,
  mergeBaseOf,
  recordedEntries,
  recordedHitsFile,
  recordedUnusedTermsFile,
  textAt,
} from "./glossary.ts";
import { plainWordsFile } from "./plain-words.ts";

type RecordedList = {
  readonly file: string;
  readonly gate: string;
  readonly repair: string;
  readonly entries: (
    file: string,
    text: string,
  ) => {
    readonly identity: string;
    readonly label: string;
    readonly size: number;
    readonly approved: string | undefined;
  }[];
  readonly movable?: true;
};

type RecordedEntry = ReturnType<RecordedList["entries"]>[number];

const namesRepair = "rename the path, or use or remove the term";

function ownFields(value: unknown): Map<string, unknown> {
  return new Map(
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.entries(value)
      : [],
  );
}

function approvalOf(own: ReadonlyMap<string, unknown>): string | undefined {
  const approved = own.get("approved");
  return typeof approved === "string" && approved.trim() !== ""
    ? approved
    : undefined;
}

function arrayEntries(
  list: string,
  identity: readonly string[],
  label: (own: ReadonlyMap<string, unknown>) => string,
): RecordedList["entries"] {
  return (file, text) =>
    recordedEntries(file, text, list).map((own) => ({
      identity: JSON.stringify(identity.map((key) => own.get(key))),
      label: label(own),
      size: 1,
      approved: approvalOf(own),
    }));
}

function countEntries(
  text: string,
  field: string | undefined,
  label: (key: string, kind: string) => string,
): RecordedEntry[] {
  const parsed = ownFields(JSON.parse(text));
  const table = field === undefined ? parsed : ownFields(parsed.get(field));
  return [...table].flatMap(([key, kinds]) =>
    [...ownFields(kinds)].map(([kind, recorded]) => {
      const own = ownFields(recorded);
      const count = own.get("count");
      return {
        identity: JSON.stringify([field, key, kind]),
        label: label(key, kind),
        size: typeof count === "number" ? count : Number.POSITIVE_INFINITY,
        approved: approvalOf(own),
      };
    }),
  );
}

function healthLabel(key: string, kind: string): string {
  const [path = "", name] = key.split("\0");
  return `a recorded ${kind} hit for ${path}${name === undefined ? "" : ` ${name}`}`;
}

const recordedLists: readonly RecordedList[] = [
  {
    file: recordedHitsFile,
    gate: "the names check",
    repair: namesRepair,
    movable: true,
    entries: arrayEntries(
      "hits",
      ["path", "word", "declaration"],
      (own) =>
        `a recorded hit for "${String(own.get("word"))}" in ${String(own.get("path"))}${own.get("declaration") === undefined ? "" : ` declaration ${String(own.get("declaration"))}`}`,
    ),
  },
  {
    file: recordedUnusedTermsFile,
    gate: "the names check",
    repair: namesRepair,
    movable: true,
    entries: arrayEntries(
      "terms",
      ["term"],
      (own) => `a recorded unused term "${String(own.get("term"))}"`,
    ),
  },
  {
    file: plainWordsFile,
    gate: "the names check",
    repair: "name it with a glossary word instead",
    entries: arrayEntries(
      "words",
      ["word"],
      (own) => `a plain word "${String(own.get("word"))}"`,
    ),
  },
  {
    file: "tests/template/standards/coverage-gaps-recorded-hits.json",
    gate: "the coverage gaps test",
    repair: "add a test that imports it",
    entries: arrayEntries(
      "hits",
      ["path", "export"],
      (own) =>
        `a recorded coverage gap for ${String(own.get("path"))}${own.get("export") === undefined ? "" : ` export ${String(own.get("export"))}`}`,
    ),
  },
  {
    file: "scripts/file-size-recorded-hits.json",
    gate: "the file size check",
    repair: "bring the file within the limit",
    entries: (_file, text) =>
      [...ownFields(JSON.parse(text))].map(([path, recorded]) => {
        const own = ownFields(recorded);
        const lifetime = String(own.get("lifetime"));
        return {
          identity: JSON.stringify([path, lifetime]),
          label: `a ${lifetime} recorded hit for ${path}`,
          size: 1,
          approved: approvalOf(own),
        };
      }),
  },
  {
    file: "eslint-suppressions.json",
    gate: "lint",
    repair: "fix the lint error, since eslint --suppress-rule writes the entry",
    entries: (_file, text) =>
      countEntries(
        text,
        undefined,
        (path, rule) => `a recorded ${rule} hit for ${path}`,
      ),
  },
  {
    file: "fallow-health-recorded-hits.json",
    gate: "the Fallow health audit",
    repair:
      "simplify the function or split the file, since fallow health --save-baseline writes the entry",
    entries: (_file, text) => [
      ...countEntries(text, "identity_finding_counts", healthLabel),
      ...countEntries(text, "finding_counts", healthLabel),
    ],
  },
];

export const recordedListFiles: readonly string[] = recordedLists.map(
  ({ file }) => file,
);

function widenings(
  { file, gate, repair, entries }: RecordedList,
  base: string | undefined,
  current: string | undefined,
  revision: string,
): string[] {
  const before = new Map(
    (base === undefined ? [] : entries(file, base)).map((entry) => [
      entry.identity,
      entry,
    ]),
  );
  const fix = `Repair: remove it (${repair}); or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`;
  return (current === undefined ? [] : entries(file, current)).flatMap(
    (entry) => {
      const earlier = before.get(entry.identity);
      if (earlier !== undefined && entry.size <= earlier.size) return [];
      if (entry.approved !== undefined && entry.approved !== earlier?.approved)
        return [];
      return [
        earlier === undefined
          ? `${file} adds ${entry.label}, which ${revision} does not record, so this change widens what ${gate} admits. ${fix}`
          : `${file} raises ${entry.label} from ${earlier.size} to ${entry.size}, above what ${revision} records, so this change widens what ${gate} admits. ${fix}`,
      ];
    },
  );
}

function baseText(
  root: string,
  base: string,
  { file, movable }: RecordedList,
): string | undefined {
  if (movable === true) return textAt(root, base, file);
  const shown = gitInNamesCheck(root, ["show", `${base}:${file}`]);
  return shown.exitCode === 0 ? shown.stdout.toString() : undefined;
}

export function recordedAdditionProblems(
  root: string,
  revision: string,
  currentText: (path: string) => string | undefined,
): string[] {
  const base = mergeBaseOf(root, revision);
  return recordedLists.flatMap((recorded) =>
    widenings(
      recorded,
      baseText(root, base, recorded),
      currentText(recorded.file),
      revision,
    ),
  );
}
