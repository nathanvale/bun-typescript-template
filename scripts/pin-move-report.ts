import { fileModeOf, nameText } from "../src/git-identities.ts";
import { git } from "../src/kernel-reader.ts";
import {
  CHANGE_NOTES_FOLDER,
  type ChangeNoteEntry,
  compareText,
  formatChangeNoteLines,
  parseChangeNote,
} from "./change-notes.ts";

export type PinMoveReport = {
  readonly from: string;
  readonly to: string;
  readonly changeNotes?: readonly ChangeNoteEntry[];
  readonly added: readonly string[];
  readonly changed: readonly string[];
  readonly removed: readonly string[];
  readonly log: readonly string[];
};

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });

function read(
  repository: string,
  command: "ls-tree" | "log" | "cat-file",
  args: readonly string[],
): Buffer {
  const run = git(repository, command, args);
  if (!run.ok)
    throw new Error(
      `git ${command} ${args.join(" ")} failed in ${repository}: ${run.said} Repair: give a kernel repository that holds both commits.`,
    );
  return run.stdout;
}

// Platform: git prints each path as the bytes it stores, which need not be
// UTF-8 text, so paths are compared as latin1 text, one character per byte,
// and decoded as UTF-8 only to be shown.
function filesAt(repository: string, commit: string): Map<string, string> {
  const listing = read(repository, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    commit,
  ]);
  const files = new Map<string, string>();
  for (let start = 0; start < listing.length; ) {
    const end = listing.indexOf(0, start);
    const record = listing.subarray(start, end < 0 ? listing.length : end);
    const tab = record.indexOf(9);
    files.set(
      record.subarray(tab + 1).toString("latin1"),
      record.subarray(0, tab).toString("latin1"),
    );
    start = end < 0 ? listing.length : end + 1;
  }
  return files;
}

function shown(path: string): string {
  return Buffer.from(path, "latin1").toString("utf8");
}

const notePrefix = `${CHANGE_NOTES_FOLDER}/`;

function decodeNoteFilename(rawFile: string): string {
  const rawBytes = Buffer.from(rawFile, "latin1");
  const file = nameText(rawBytes);
  if (file === undefined) {
    throw new Error(
      `${notePrefix} (raw filename bytes ${rawBytes.toString("hex")}): kernel change note filename is not valid UTF-8 text. Repair: rename the change note to a valid UTF-8 filename in the kernel repository.`,
    );
  }
  return file;
}

function addedChangeNotes(
  repository: string,
  before: ReadonlyMap<string, string>,
  after: ReadonlyMap<string, string>,
): readonly ChangeNoteEntry[] | undefined {
  let hasFolder = false;
  const addedFiles: { readonly file: string; readonly meta: string }[] = [];
  for (const [rawPath, meta] of after) {
    if (!rawPath.startsWith(notePrefix)) continue;
    hasFolder = true;
    const rawFile = rawPath.slice(notePrefix.length);
    if (
      before.has(rawPath) ||
      rawFile.includes("/") ||
      !rawFile.endsWith(".json")
    ) {
      continue;
    }
    addedFiles.push({ file: decodeNoteFilename(rawFile), meta });
  }
  if (!hasFolder) return undefined;
  addedFiles.sort((left, right) => compareText(left.file, right.file));
  return addedFiles.map(({ file, meta }) => {
    const path = `${notePrefix}${file}`;
    const [mode = "", type = "", blobId = ""] = meta.split(" ");
    if (fileModeOf(mode) === undefined || type !== "blob" || blobId === "") {
      throw new Error(
        `${path}: kernel change note is not a plain file (git entry "${meta}"). Repair: replace ${path} with a regular UTF-8 JSON file in the kernel repository.`,
      );
    }
    const bytes = read(repository, "cat-file", ["blob", blobId]);
    let raw: string;
    try {
      raw = strictUtf8.decode(bytes);
    } catch {
      throw new Error(
        `${path}: kernel change note is not valid UTF-8 text. Repair: save ${path} as UTF-8 JSON in the kernel repository.`,
      );
    }
    const parsed = parseChangeNote(path, raw);
    if (!parsed.ok) throw new Error(parsed.problem);
    return { file, note: parsed.note };
  });
}

export function pinMoveReport(
  repository: string,
  from: string,
  to: string,
): PinMoveReport {
  const before = filesAt(repository, from);
  const after = filesAt(repository, to);
  const changeNotes = addedChangeNotes(repository, before, after);
  const paths = [...new Set([...before.keys(), ...after.keys()])].sort();
  return {
    from,
    to,
    ...(changeNotes === undefined ? {} : { changeNotes }),
    added: paths.filter((path) => !before.has(path)).map(shown),
    changed: paths
      .filter(
        (path) =>
          before.has(path) &&
          after.has(path) &&
          before.get(path) !== after.get(path),
      )
      .map(shown),
    removed: paths.filter((path) => !after.has(path)).map(shown),
    log: read(repository, "log", [
      "--no-show-signature",
      "--format=%h %s",
      `${from}..${to}`,
    ])
      .toString()
      .split("\n")
      .filter((line) => line !== ""),
  };
}

function section(title: string, lines: readonly string[]): string {
  return `${title} (${lines.length}):\n${lines.map((line) => `  ${line}\n`).join("")}`;
}

function changeNotesSection(
  entries: readonly ChangeNoteEntry[] | undefined,
): string {
  if (entries === undefined) return "";
  const lines = formatChangeNoteLines(entries);
  return `Kernel change notes (${entries.length}):\n${lines.map((line) => `  ${line}\n`).join("")}`;
}

export function pinMoveReportText(
  report: PinMoveReport,
  written?: readonly string[],
): string {
  return [
    `Pin move report: ${report.from} to ${report.to}\n`,
    changeNotesSection(report.changeNotes),
    written === undefined
      ? ""
      : section(
          "Written in the template, kernel lockfile first and pin last",
          written,
        ),
    section("Kernel files added", report.added),
    section("Kernel files changed", report.changed),
    section("Kernel files removed", report.removed),
    section("Kernel log", report.log),
  ].join("");
}
