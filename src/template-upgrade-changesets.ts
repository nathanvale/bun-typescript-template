import { parseChangesetFile } from "@changesets/parse";
import { CliError } from "./cli-error.ts";
import { fileModeOf, nameText, parseGitTreeEntries } from "./git-identities.ts";
import { CHANGESET_FOLDER } from "./recipe.ts";
import {
  decodeUtf8Strict,
  type ProcessEnvMap,
  runGitCommand,
} from "./template-upgrade-git.ts";

const CHANGESET_PREFIX = `${CHANGESET_FOLDER}/`;
const LEGACY_NOTES_FOLDER = "change-notes";
const LEGACY_NOTES_PREFIX = `${LEGACY_NOTES_FOLDER}/`;
const ACTION_LINE = /^Action: \S/;

export type TemplateChangesetEntry = {
  readonly file: string;
  readonly level: "major" | "minor" | "patch" | "none";
  readonly summary: string;
  readonly action: string | null;
};

const LEVEL_ORDER: readonly TemplateChangesetEntry["level"][] = [
  "major",
  "minor",
  "patch",
  "none",
];

const LEVEL_HEADINGS: readonly (readonly [
  TemplateChangesetEntry["level"],
  string,
])[] = [
  ["major", "MAJOR"],
  ["minor", "Minor"],
  ["patch", "Patch"],
  ["none", "No consumer effect"],
];

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareEntries(
  left: TemplateChangesetEntry,
  right: TemplateChangesetEntry,
): number {
  const rankDelta =
    LEVEL_ORDER.indexOf(left.level) - LEVEL_ORDER.indexOf(right.level);
  return rankDelta !== 0 ? rankDelta : compareCodeUnits(left.file, right.file);
}

function listTreeAt(
  repositoryRoot: string,
  commit: string,
  folder: string,
  env: ProcessEnvMap,
): Map<string, string> {
  const result = runGitCommand(
    repositoryRoot,
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", folder],
    { env },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = new TextDecoder("utf-8").decode(result.stderr).trim();
    throw new CliError(
      "changesets_unreadable",
      `cannot list ${folder}/ at commit ${commit.slice(0, 7)}${detail === "" ? "" : `: ${detail}`}`,
      `verify commit ${commit.slice(0, 7)} exists in ${repositoryRoot}, then rerun`,
      1,
      false,
    );
  }
  return parseGitTreeEntries(Buffer.from(result.stdout));
}

function isCandidateChangesetFile(rawFile: string): boolean {
  if (!rawFile.endsWith(".md")) {
    return false;
  }
  if (rawFile.startsWith("pre/")) {
    const nested = rawFile.slice("pre/".length);
    return nested !== "" && !nested.includes("/") && nested !== "README.md";
  }
  return !rawFile.includes("/") && rawFile !== "README.md";
}

function decodeChangesetFilename(rawFile: string): string {
  const rawBytes = Buffer.from(rawFile, "latin1");
  const file = nameText(rawBytes);
  if (file === undefined) {
    throw new CliError(
      "changeset_invalid",
      `${CHANGESET_PREFIX} (raw filename bytes ${rawBytes.toString("hex")}): changeset filename is not valid UTF-8 text`,
      `rename the changeset under ${CHANGESET_FOLDER}/ to valid UTF-8, then rerun`,
      1,
      false,
    );
  }
  return file;
}

function readChangesetBlob(
  repositoryRoot: string,
  path: string,
  meta: string,
  env: ProcessEnvMap,
): string {
  const [mode = "", type = "", blobId = ""] = meta.split(" ");
  if (fileModeOf(mode) === undefined || type !== "blob" || blobId === "") {
    throw new CliError(
      "changeset_invalid",
      `${path}: changeset is not a plain file (git entry "${meta}")`,
      `replace ${path} with a regular UTF-8 Markdown file, then rerun`,
      1,
      false,
    );
  }
  const blob = runGitCommand(repositoryRoot, ["cat-file", "blob", blobId], {
    env,
  });
  if (blob.timedOut || blob.exitCode !== 0) {
    throw new CliError(
      "changesets_unreadable",
      `cannot read changeset blob for ${path}`,
      `verify git objects in ${repositoryRoot}, then rerun`,
      1,
      false,
    );
  }
  return decodeUtf8Strict(blob.stdout, path);
}

function levelOf(
  releases: readonly { readonly type: string }[],
): TemplateChangesetEntry["level"] {
  if (releases.some((release) => release.type === "major")) return "major";
  if (releases.some((release) => release.type === "minor")) return "minor";
  if (releases.some((release) => release.type === "patch")) return "patch";
  return "none";
}

function actionOf(summary: string): string | null {
  const lines = summary.replace(/\r\n/g, "\n").split("\n").slice(1);
  const matched = lines.find((line) => ACTION_LINE.test(line));
  return matched === undefined ? null : matched.slice("Action: ".length).trim();
}

function isBumpLevel(type: string): boolean {
  return type === "major" || type === "minor" || type === "patch";
}

function parseChangesetFrontmatter(
  raw: string,
  path: string,
): ReturnType<typeof parseChangesetFile> {
  try {
    return parseChangesetFile(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new CliError(
      "changeset_invalid",
      `${path}: ${reason}`,
      `fix ${path} so it has valid Changesets frontmatter, then rerun`,
      1,
      false,
    );
  }
}

export function changesetPackageLevel(
  raw: string,
  path: string,
  packageName: string,
): boolean {
  const parsed = parseChangesetFrontmatter(raw, path);
  return parsed.releases.some(
    (release) => release.name === packageName && isBumpLevel(release.type),
  );
}

function parseEntry(
  repositoryRoot: string,
  rawFile: string,
  meta: string,
  env: ProcessEnvMap,
): TemplateChangesetEntry {
  const file = decodeChangesetFilename(rawFile);
  const path = `${CHANGESET_PREFIX}${file}`;
  const raw = readChangesetBlob(repositoryRoot, path, meta, env);
  const parsed = parseChangesetFrontmatter(raw, path);
  return Object.freeze({
    file,
    level: levelOf(parsed.releases),
    summary: parsed.summary,
    action: actionOf(parsed.summary),
  });
}

function collectLegacyJsonStems(
  entries: ReadonlyMap<string, string>,
): ReadonlySet<string> {
  const stems = new Set<string>();
  for (const rawPath of entries.keys()) {
    if (!rawPath.startsWith(LEGACY_NOTES_PREFIX)) {
      continue;
    }
    const rawFile = rawPath.slice(LEGACY_NOTES_PREFIX.length);
    if (!rawFile.includes("/") && rawFile.endsWith(".json")) {
      stems.add(rawFile.slice(0, -".json".length));
    }
  }
  return stems;
}

function collectAddedEntries(options: {
  readonly repositoryRoot: string;
  readonly baseChangesets: ReadonlyMap<string, string>;
  readonly targetChangesets: ReadonlyMap<string, string>;
  readonly baseLegacyStems: ReadonlySet<string>;
  readonly env: ProcessEnvMap;
}): readonly TemplateChangesetEntry[] {
  const entries: TemplateChangesetEntry[] = [];
  for (const [rawPath, meta] of options.targetChangesets) {
    if (
      !rawPath.startsWith(CHANGESET_PREFIX) ||
      options.baseChangesets.has(rawPath)
    ) {
      continue;
    }
    const rawFile = rawPath.slice(CHANGESET_PREFIX.length);
    if (!isCandidateChangesetFile(rawFile)) {
      continue;
    }
    if (
      !rawFile.includes("/") &&
      options.baseLegacyStems.has(rawFile.slice(0, -".md".length))
    ) {
      continue;
    }
    entries.push(
      parseEntry(options.repositoryRoot, rawFile, meta, options.env),
    );
  }
  entries.sort(compareEntries);
  return Object.freeze(entries);
}

export function readTemplateUpgradeChangesets(
  templateRoot: string,
  baseCommit: string,
  targetCommit: string,
  env: ProcessEnvMap = process.env,
): readonly TemplateChangesetEntry[] {
  if (baseCommit === targetCommit) {
    return Object.freeze([]);
  }
  const targetChangesets = listTreeAt(
    templateRoot,
    targetCommit,
    CHANGESET_FOLDER,
    env,
  );
  if (targetChangesets.size === 0) {
    const targetLegacy = listTreeAt(
      templateRoot,
      targetCommit,
      LEGACY_NOTES_FOLDER,
      env,
    );
    if (collectLegacyJsonStems(targetLegacy).size > 0) {
      const target7 = targetCommit.slice(0, 7);
      throw new CliError(
        "changeset_predates_switchover",
        `target commit ${target7} predates the Changesets switchover`,
        `target predates the Changesets switchover; run upgrade from a template checkout at ${target7}`,
        1,
        false,
      );
    }
    return Object.freeze([]);
  }
  const baseChangesets = listTreeAt(
    templateRoot,
    baseCommit,
    CHANGESET_FOLDER,
    env,
  );
  const baseLegacy = listTreeAt(
    templateRoot,
    baseCommit,
    LEGACY_NOTES_FOLDER,
    env,
  );
  return collectAddedEntries({
    repositoryRoot: templateRoot,
    baseChangesets,
    targetChangesets,
    baseLegacyStems: collectLegacyJsonStems(baseLegacy),
    env,
  });
}

export function readRepositoryChangesets(
  repositoryRoot: string,
  fromCommit: string,
  toCommit: string,
  env: ProcessEnvMap = process.env,
): readonly TemplateChangesetEntry[] | undefined {
  const targetChangesets = listTreeAt(
    repositoryRoot,
    toCommit,
    CHANGESET_FOLDER,
    env,
  );
  if (targetChangesets.size === 0) {
    return undefined;
  }
  const baseChangesets = listTreeAt(
    repositoryRoot,
    fromCommit,
    CHANGESET_FOLDER,
    env,
  );
  return collectAddedEntries({
    repositoryRoot,
    baseChangesets,
    targetChangesets,
    baseLegacyStems: new Set<string>(),
    env,
  });
}

export function repositoryPackageChangeset(
  repositoryRoot: string,
  fromCommit: string,
  toCommit: string,
  packageName: string,
  env: ProcessEnvMap = process.env,
): boolean {
  const targetChangesets = listTreeAt(
    repositoryRoot,
    toCommit,
    CHANGESET_FOLDER,
    env,
  );
  if (targetChangesets.size === 0) {
    return false;
  }
  const baseChangesets = listTreeAt(
    repositoryRoot,
    fromCommit,
    CHANGESET_FOLDER,
    env,
  );
  for (const [rawPath, meta] of targetChangesets) {
    if (!rawPath.startsWith(CHANGESET_PREFIX) || baseChangesets.has(rawPath)) {
      continue;
    }
    const rawFile = rawPath.slice(CHANGESET_PREFIX.length);
    if (!isCandidateChangesetFile(rawFile)) {
      continue;
    }
    const file = decodeChangesetFilename(rawFile);
    const path = `${CHANGESET_PREFIX}${file}`;
    const raw = readChangesetBlob(repositoryRoot, path, meta, env);
    if (changesetPackageLevel(raw, path, packageName)) {
      return true;
    }
  }
  return false;
}

function summaryWithoutAction(summary: string): string {
  const lines = summary
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, index) => index === 0 || !ACTION_LINE.test(line));
  const text = lines.join(" ").replace(/\s+/g, " ").trim();
  return text === "" ? "(no summary)" : text;
}

export function formatChangesetLines(
  entries: readonly TemplateChangesetEntry[],
): readonly string[] {
  const ordered = [...entries].sort(compareEntries);
  return LEVEL_HEADINGS.flatMap(([level, heading]) => {
    const items = ordered.filter((entry) => entry.level === level);
    if (items.length === 0) return [];
    const lines = [`${heading} (${items.length}):`];
    for (const entry of items) {
      lines.push(`  - ${summaryWithoutAction(entry.summary)} (${entry.file})`);
      if (entry.action !== null) {
        lines.push(`    Action: ${entry.action}`);
      }
    }
    return lines;
  });
}
