import { CHANGE_NOTES_FOLDER } from "../src/recipe.ts";

export { CHANGE_NOTES_FOLDER };

const kinds = ["added", "changed", "fixed", "removed", "none"] as const;
const fieldsList = [
  "kind",
  "breaking",
  "affects",
  "summary",
  "action",
] as const;
const allowedFieldSet = new Set<string>(fieldsList);
const surfacePattern = /^[a-z0-9]+(?:[/-][a-z0-9]+)*$/;
const noteFilePattern =
  /^(\d{4})-(\d{2})-(\d{2})-[a-z0-9]+(?:-[a-z0-9]+)*\.json$/;

export type ChangeNoteKind = (typeof kinds)[number];
export type ChangeNote = {
  readonly kind: ChangeNoteKind;
  readonly breaking: boolean;
  readonly affects: readonly string[];
  readonly summary: string;
  readonly action: string | null;
};
export type ChangeNoteEntry = {
  readonly file: string;
  readonly note: ChangeNote;
};
type Parsed<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly problem: string };

const fail = (problem: string) => ({ ok: false, problem }) as const;

export function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isValidChangeNoteFile(file: string): boolean {
  const match = noteFilePattern.exec(file);
  if (match === null) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function parseJsonObject(file: string, raw: string): Parsed<object> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(
      `${file}: invalid JSON (${reason}). Repair: fix the JSON syntax in ${file}.`,
    );
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return fail(
      `${file}: expected a JSON object. Repair: write an object with ${fieldsList.join(", ")}.`,
    );
  return { ok: true, value: parsed };
}

function readJsonFields(
  file: string,
  raw: string,
): Parsed<Map<string, unknown>> {
  const objectResult = parseJsonObject(file, raw);
  if (!objectResult.ok) return objectResult;
  const fields = new Map<string, unknown>(Object.entries(objectResult.value));
  const unknown = [...fields.keys()].find((key) => !allowedFieldSet.has(key));
  if (unknown !== undefined)
    return fail(
      `${file}: unknown field "${unknown}". Repair: keep only ${fieldsList.join(", ")}.`,
    );
  const missing = fieldsList.find((key) => !fields.has(key));
  if (missing !== undefined)
    return fail(
      `${file}: missing required field "${missing}". Repair: set ${fieldsList.join(", ")}.`,
    );
  return { ok: true, value: fields };
}

function parseKindAndBreaking(
  file: string,
  fields: ReadonlyMap<string, unknown>,
): Parsed<{ readonly kind: ChangeNoteKind; readonly breaking: boolean }> {
  const kind = kinds.find((value) => value === fields.get("kind"));
  if (kind === undefined)
    return fail(
      `${file}: kind must be one of ${kinds.join(", ")}. Repair: set kind to a valid value.`,
    );
  const breaking = fields.get("breaking");
  if (typeof breaking !== "boolean")
    return fail(
      `${file}: breaking must be true or false. Repair: set breaking to a boolean.`,
    );
  if (kind === "none" && breaking)
    return fail(
      `${file}: a "none" note cannot set breaking to true. Repair: set breaking to false or pick added, changed, fixed or removed.`,
    );
  return { ok: true, value: { kind, breaking } };
}

function parseAffects(
  file: string,
  raw: unknown,
  kind: ChangeNoteKind,
  allowedAffects?: ReadonlySet<string>,
): Parsed<readonly string[]> {
  if (
    !Array.isArray(raw) ||
    !raw.every((item) => typeof item === "string" && surfacePattern.test(item))
  )
    return fail(
      `${file}: affects must be an array of lowercase surface names. Repair: set affects to strings like ["bootstrap"] or [].`,
    );
  const affects = raw.filter(
    (item): item is string => typeof item === "string",
  );
  if (allowedAffects !== undefined) {
    const invalid = affects.find((item) => !allowedAffects.has(item));
    if (invalid !== undefined)
      return fail(
        `${file}: unknown affects entry "${invalid}". Repair: use one of ${[...allowedAffects].sort(compareText).join(", ")}.`,
      );
  }
  if (kind !== "none" && affects.length === 0)
    return fail(
      `${file}: affects must name at least one surface when kind is "${kind}". Repair: list the affected surface(s).`,
    );
  return { ok: true, value: Object.freeze(affects) };
}

function parseAction(
  file: string,
  raw: unknown,
  breaking: boolean,
): Parsed<string | null> {
  if (raw !== null && (typeof raw !== "string" || raw.trim() === ""))
    return fail(
      `${file}: action must be a non-empty string or null. Repair: set action to null or write what the reader must do.`,
    );
  if (breaking && raw === null)
    return fail(
      `${file}: breaking is true so action must explain what the reader must do. Repair: set action to a non-empty step.`,
    );
  return { ok: true, value: raw === null ? null : raw.trim() };
}

export function parseChangeNote(
  file: string,
  raw: string,
  allowedAffects?: ReadonlySet<string>,
):
  | { readonly ok: true; readonly note: ChangeNote }
  | { readonly ok: false; readonly problem: string } {
  const fieldsResult = readJsonFields(file, raw);
  if (!fieldsResult.ok) return fieldsResult;
  const fields = fieldsResult.value;
  const header = parseKindAndBreaking(file, fields);
  if (!header.ok) return header;
  const { kind, breaking } = header.value;
  const affects = parseAffects(
    file,
    fields.get("affects"),
    kind,
    allowedAffects,
  );
  if (!affects.ok) return affects;
  const summary = fields.get("summary");
  if (typeof summary !== "string" || summary.trim() === "")
    return fail(
      `${file}: summary must be a non-empty string. Repair: describe what changed for readers.`,
    );
  const action = parseAction(file, fields.get("action"), breaking);
  if (!action.ok) return action;
  return {
    ok: true,
    note: Object.freeze({
      kind,
      breaking,
      affects: affects.value,
      summary: summary.trim(),
      action: action.value,
    }),
  };
}

const sections: readonly [ChangeNoteKind, string][] = [
  ["added", "Added"],
  ["changed", "Changed"],
  ["fixed", "Fixed"],
  ["removed", "Removed"],
  ["none", "No consumer effect"],
];

function formatSection(
  heading: string,
  items: readonly ChangeNoteEntry[],
): string[] {
  if (items.length === 0) return [];
  const lines = [`${heading} (${items.length}):`];
  for (const { file, note } of items) {
    const scope =
      note.affects.length > 0 ? `[${note.affects.join(", ")}] ` : "";
    lines.push(`  - ${scope}${note.summary} (${file})`);
    if (note.action !== null) lines.push(`    Action: ${note.action}`);
  }
  return lines;
}

export function formatChangeNoteLines(
  entries: readonly ChangeNoteEntry[],
): readonly string[] {
  const ordered = [...entries].sort((left, right) =>
    compareText(left.file, right.file),
  );
  return [
    ...formatSection(
      "BREAKING",
      ordered.filter(({ note }) => note.breaking),
    ),
    ...sections.flatMap(([kind, heading]) =>
      formatSection(
        heading,
        ordered.filter(({ note }) => !note.breaking && note.kind === kind),
      ),
    ),
  ];
}
