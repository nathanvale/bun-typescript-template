import {
  type ChangeNote,
  type ChangeNoteEntry,
  type ChangeNoteKind,
  compareText,
  isValidChangeNoteFile,
} from "./change-notes.ts";

export const STARTING_TEMPLATE_VERSION = "0.1.0";
export const TEMPLATE_VERSIONS_FOLDER = "template-versions";

export type TemplateVersion = {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
};

export type VersionBump = "major" | "minor" | "patch" | "none";

export class TemplateVersionRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TemplateVersionRefusal";
  }
}

const strictVersionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const isoDatePattern = /^(\d{4})-(\d{2})-(\d{2})$/;

const kindSections: readonly [ChangeNoteKind, string][] = [
  ["added", "Added"],
  ["changed", "Changed"],
  ["fixed", "Fixed"],
  ["removed", "Removed"],
];

export function parseTemplateVersion(raw: string): TemplateVersion {
  const match = strictVersionPattern.exec(raw);
  if (match === null)
    throw new TemplateVersionRefusal(
      `Invalid template version "${raw}". Repair: use strict X.Y.Z numbers such as ${STARTING_TEMPLATE_VERSION}.`,
    );
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch) ||
    Bun.semver.order(raw, raw) !== 0
  )
    throw new TemplateVersionRefusal(
      `Invalid template version "${raw}". Repair: use strict X.Y.Z numbers supported by Bun.semver.`,
    );
  return Object.freeze({ major, minor, patch });
}

export function formatTemplateVersion(version: TemplateVersion): string {
  return `${version.major}.${version.minor}.${version.patch}`;
}

export function compareTemplateVersions(left: string, right: string): number {
  parseTemplateVersion(left);
  parseTemplateVersion(right);
  return Bun.semver.order(left, right);
}

export function bumpFromChangeNotes(
  currentVersion: string,
  notes: readonly ChangeNote[],
): VersionBump {
  const { major } = parseTemplateVersion(currentVersion);
  const consumerNotes = notes.filter((note) => note.kind !== "none");
  if (consumerNotes.length === 0) return "none";
  const hasBreaking = consumerNotes.some((note) => note.breaking);
  if (major === 0) return hasBreaking ? "minor" : "patch";
  if (hasBreaking) return "major";
  return consumerNotes.some((note) => note.kind === "added")
    ? "minor"
    : "patch";
}

export function applyVersionBump(
  currentVersion: string,
  bump: VersionBump,
): string {
  const parsed = parseTemplateVersion(currentVersion);
  if (bump === "none") return currentVersion;
  const next =
    bump === "major"
      ? formatTemplateVersion({ major: parsed.major + 1, minor: 0, patch: 0 })
      : bump === "minor"
        ? formatTemplateVersion({
            major: parsed.major,
            minor: parsed.minor + 1,
            patch: 0,
          })
        : formatTemplateVersion({
            major: parsed.major,
            minor: parsed.minor,
            patch: parsed.patch + 1,
          });
  if (Bun.semver.order(next, currentVersion) <= 0)
    throw new TemplateVersionRefusal(
      `Computed next template version "${next}" is not greater than "${currentVersion}". Repair: inspect the current version tag.`,
    );
  return next;
}

export function nextTemplateVersion(
  currentVersion: string,
  notes: readonly ChangeNote[],
): string | undefined {
  const bump = bumpFromChangeNotes(currentVersion, notes);
  if (bump === "none") return undefined;
  return applyVersionBump(currentVersion, bump);
}

export function isValidIsoDate(raw: string): boolean {
  return isoDatePattern.test(raw) && isValidChangeNoteFile(`${raw}-a.json`);
}

export function normalizeLead(raw: string): string {
  if (/[\r\n]/.test(raw))
    throw new TemplateVersionRefusal(
      "Lead sentence must be a single line. Repair: pass a one-sentence --lead without line breaks.",
    );
  const trimmed = raw.trim();
  if (trimmed === "")
    throw new TemplateVersionRefusal(
      'Lead sentence is required. Repair: pass --lead "<one-sentence summary>".',
    );
  return trimmed;
}

function renderBullet({ file, note }: ChangeNoteEntry): string[] {
  const scope =
    note.affects.length > 0 ? `**${note.affects.join(", ")}:** ` : "";
  const lines = [`- ${scope}${note.summary} (\`${file}\`)`];
  if (note.action !== null) lines.push(`  - **Action:** ${note.action}`);
  return lines;
}

export function pluralCount(count: number, singular: string): string {
  return `${count} ${singular}${count === 1 ? "" : "s"}`;
}

function renderAffectsLine(
  consumer: readonly ChangeNoteEntry[],
  breakingCount: number,
  nonBreakingCount: number,
  internalCount: number,
): string {
  const countParts: string[] = [];
  if (breakingCount > 0)
    countParts.push(pluralCount(breakingCount, "breaking change"));
  if (nonBreakingCount > 0)
    countParts.push(pluralCount(nonBreakingCount, "consumer update"));
  const omitted =
    internalCount > 0
      ? `; ${pluralCount(internalCount, "internal change")} omitted`
      : "";
  const surfaces = [
    ...new Set(consumer.flatMap(({ note }) => note.affects)),
  ].sort(compareText);
  return `Affects: ${surfaces.join(", ")} (${countParts.join(", ")}${omitted}).`;
}

function renderGroupedSections(
  breaking: readonly ChangeNoteEntry[],
  nonBreaking: readonly ChangeNoteEntry[],
): string[] {
  const lines: string[] = [];
  if (breaking.length > 0) {
    lines.push("", "## Breaking Changes", "");
    for (const entry of breaking) lines.push(...renderBullet(entry));
  }
  for (const [kind, heading] of kindSections) {
    const group = nonBreaking.filter(({ note }) => note.kind === kind);
    if (group.length === 0) continue;
    lines.push("", `## ${heading}`, "");
    for (const entry of group) lines.push(...renderBullet(entry));
  }
  return lines;
}

export function renderTemplateVersion({
  version,
  date,
  lead,
  entries,
}: {
  readonly version: string;
  readonly date: string;
  readonly lead: string;
  readonly entries: readonly ChangeNoteEntry[];
}): string {
  parseTemplateVersion(version);
  if (!isValidIsoDate(date))
    throw new TemplateVersionRefusal(
      `Invalid date "${date}". Repair: pass --date YYYY-MM-DD with a real calendar date.`,
    );
  const cleanLead = normalizeLead(lead);
  const ordered = [...entries].sort((left, right) =>
    compareText(left.file, right.file),
  );
  const consumer = ordered.filter(({ note }) => note.kind !== "none");
  const breaking = consumer.filter(({ note }) => note.breaking);
  const nonBreaking = consumer.filter(({ note }) => !note.breaking);
  const lines: string[] = [
    `# Template version ${version} (${date})`,
    "",
    cleanLead,
    "",
    renderAffectsLine(
      consumer,
      breaking.length,
      nonBreaking.length,
      ordered.length - consumer.length,
    ),
    ...renderGroupedSections(breaking, nonBreaking),
  ];
  return `${lines.join("\n")}\n`;
}
