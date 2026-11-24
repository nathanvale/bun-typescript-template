import {
  gitInNamesCheck,
  mergeBaseOf,
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

function refuse(file: string, shape: string): never {
  throw new Error(
    `${file} is not ${shape}, so the recorded lists check cannot read it. Repair: restore that shape, then run bun run check:names --against <base> again.`,
  );
}

function shaped(
  value: unknown,
  file: string,
  shape: string,
  keys?: readonly string[],
): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return refuse(file, shape);
  const own = new Map<string, unknown>(Object.entries(value));
  if (keys !== undefined && [...own.keys()].some((key) => !keys.includes(key)))
    return refuse(file, shape);
  return own;
}

function approvalOf(
  own: ReadonlyMap<string, unknown>,
  file: string,
  shape: string,
): string | undefined {
  const approved = own.get("approved");
  if (approved !== undefined && typeof approved !== "string")
    return refuse(file, shape);
  return approved?.trim() === "" ? undefined : approved?.trim();
}

function arrayEntries(
  list: string,
  identity: readonly string[],
  fields: readonly string[],
  label: (own: ReadonlyMap<string, unknown>) => string,
): RecordedList["entries"] {
  const shape = `{ "${list}": [{ ${[...identity, ...fields].join(", ")}, approved? }] }`;
  return (file, text) => {
    const entries = shaped(JSON.parse(text), file, shape, ["about", list]).get(
      list,
    );
    if (!Array.isArray(entries)) return refuse(file, shape);
    return entries.map((entry: unknown) => {
      const own = shaped(entry, file, shape, [
        ...identity,
        ...fields,
        "approved",
      ]);
      return {
        identity: JSON.stringify(identity.map((key) => own.get(key))),
        label: label(own),
        size: 1,
        approved: approvalOf(own, file, shape),
      };
    });
  };
}

function countEntries(
  file: string,
  table: unknown,
  field: string,
  label: (key: string, kind: string) => string,
): RecordedEntry[] {
  const shape = `{ "<path>": { "<kind>": { count, approved? } } } in ${field}`;
  return [...shaped(table, file, shape)].flatMap(([key, kinds]) =>
    [...shaped(kinds, file, shape)].map(([kind, recorded]) => {
      const own = shaped(recorded, file, shape, ["count", "approved"]);
      const count = own.get("count");
      if (!Number.isSafeInteger(count) || Number(count) < 0)
        return refuse(file, shape);
      return {
        identity: JSON.stringify([field, key, kind]),
        label: label(key, kind),
        size: Number(count),
        approved: approvalOf(own, file, shape),
      };
    }),
  );
}

const healthFields = [
  "kind",
  "finding_counts",
  "identity_finding_counts",
  "runtime_coverage_findings",
  "target_keys",
  "approved",
];
const healthShape = `{ ${healthFields.join(", ")}? } as fallow health --save-baseline writes it`;

function healthEntries(file: string, text: string): RecordedEntry[] {
  const own = shaped(JSON.parse(text), file, healthShape, healthFields);
  const approvals = shaped(own.get("approved") ?? {}, file, healthShape);
  if (
    own.get("kind") !== "health" ||
    [...approvals.values()].some((approved) => typeof approved !== "string")
  )
    return refuse(file, healthShape);
  const keys = ["runtime_coverage_findings", "target_keys"].flatMap((field) => {
    const listed = own.get(field);
    if (!Array.isArray(listed) || listed.some((key) => typeof key !== "string"))
      return refuse(file, healthShape);
    return listed.map((key: string) => ({
      identity: JSON.stringify([field, key]),
      label: `a recorded ${field} entry ${key}`,
      size: 1,
      approved: approvalOf(
        new Map([["approved", approvals.get(key)]]),
        file,
        healthShape,
      ),
    }));
  });
  return [
    ...countEntries(
      file,
      own.get("identity_finding_counts"),
      "identity_finding_counts",
      healthLabel,
    ),
    ...countEntries(
      file,
      own.get("finding_counts"),
      "finding_counts",
      healthLabel,
    ),
    ...keys,
  ];
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
      ["reason"],
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
      ["reason", "ticket"],
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
      ["reason"],
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
      ["reason"],
      (own) =>
        `a recorded coverage gap for ${String(own.get("path"))}${own.get("export") === undefined ? "" : ` export ${String(own.get("export"))}`}`,
    ),
  },
  {
    file: "scripts/file-size-recorded-hits.json",
    gate: "the file size check",
    repair: "bring the file within the limit",
    entries: (file, text) => {
      const shape = `{ "<path>": { lifetime: "standing" | "temporary", reason, approved? } }`;
      return [...shaped(JSON.parse(text), file, shape)].map(([path, hit]) => {
        const own = shaped(hit, file, shape, [
          "lifetime",
          "reason",
          "approved",
        ]);
        const lifetime = own.get("lifetime");
        if (lifetime !== "standing" && lifetime !== "temporary")
          return refuse(file, shape);
        return {
          identity: JSON.stringify([path, lifetime]),
          label: `a ${String(lifetime)} recorded hit for ${path}`,
          size: 1,
          approved: approvalOf(own, file, shape),
        };
      });
    },
  },
  {
    file: "eslint-suppressions.json",
    gate: "lint",
    repair: "fix the lint error, since eslint --suppress-rule writes the entry",
    entries: (file, text) =>
      countEntries(
        file,
        JSON.parse(text),
        "eslint-suppressions.json",
        (path, rule) => `a recorded ${rule} hit for ${path}`,
      ),
  },
  {
    file: "fallow-health-recorded-hits.json",
    gate: "the Fallow health audit",
    repair:
      "simplify the function or split the file, since fallow health --save-baseline writes the entry. A runtime_coverage_findings or target_keys entry takes its approval in the top-level approved object, keyed by the entry",
    entries: healthEntries,
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
