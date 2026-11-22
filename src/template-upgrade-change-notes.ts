import {
  CHANGE_NOTES_FOLDER,
  type ChangeNoteEntry,
  compareText,
  parseChangeNote,
} from "./change-notes.ts";
import { CliError } from "./cli-error.ts";
import { fileModeOf, nameText, parseGitTreeEntries } from "./git-identities.ts";
import {
  decodeUtf8Strict,
  type ProcessEnvMap,
  runGitCommand,
} from "./template-upgrade-git.ts";

const NOTE_PREFIX = `${CHANGE_NOTES_FOLDER}/`;

function listChangeNoteEntriesAt(
  templateRoot: string,
  commit: string,
  env: ProcessEnvMap,
): Map<string, string> {
  const result = runGitCommand(
    templateRoot,
    ["ls-tree", "-r", "-z", "--full-tree", commit, "--", CHANGE_NOTES_FOLDER],
    { env },
  );
  if (result.timedOut || result.exitCode !== 0) {
    const detail = new TextDecoder("utf-8").decode(result.stderr).trim();
    throw new CliError(
      "change_notes_unreadable",
      `cannot list ${CHANGE_NOTES_FOLDER}/ at template commit ${commit.slice(0, 7)}${detail === "" ? "" : `: ${detail}`}`,
      `verify commit ${commit.slice(0, 7)} exists in ${templateRoot}, then rerun`,
      1,
      false,
    );
  }
  return parseGitTreeEntries(Buffer.from(result.stdout));
}

function decodeChangeNoteFilename(rawFile: string): string {
  const rawBytes = Buffer.from(rawFile, "latin1");
  const file = nameText(rawBytes);
  if (file === undefined) {
    throw new CliError(
      "change_note_invalid",
      `${NOTE_PREFIX} (raw filename bytes ${rawBytes.toString("hex")}): change note filename is not valid UTF-8 text`,
      `rename the change note under ${CHANGE_NOTES_FOLDER}/ in the template to valid UTF-8, then rerun`,
      1,
      false,
    );
  }
  return file;
}

function readChangeNoteBlob(
  templateRoot: string,
  path: string,
  meta: string,
  env: ProcessEnvMap,
): string {
  const [mode = "", type = "", blobId = ""] = meta.split(" ");
  if (fileModeOf(mode) === undefined || type !== "blob" || blobId === "") {
    throw new CliError(
      "change_note_invalid",
      `${path}: template change note is not a plain file (git entry "${meta}")`,
      `replace ${path} in the template with a regular UTF-8 JSON file, then rerun`,
      1,
      false,
    );
  }
  const blob = runGitCommand(templateRoot, ["cat-file", "blob", blobId], {
    env,
  });
  if (blob.timedOut || blob.exitCode !== 0) {
    throw new CliError(
      "change_notes_unreadable",
      `cannot read template change note blob for ${path}`,
      `verify git objects in ${templateRoot}, then rerun`,
      1,
      false,
    );
  }
  return decodeUtf8Strict(blob.stdout, path);
}

export function readTemplateUpgradeChangeNotes(
  templateRoot: string,
  baseCommit: string,
  targetCommit: string,
  env: ProcessEnvMap = process.env,
): readonly ChangeNoteEntry[] {
  if (baseCommit === targetCommit) {
    return Object.freeze([]);
  }
  const baseFiles = listChangeNoteEntriesAt(templateRoot, baseCommit, env);
  const targetFiles = listChangeNoteEntriesAt(templateRoot, targetCommit, env);
  const entries: ChangeNoteEntry[] = [];
  for (const [rawPath, meta] of targetFiles) {
    if (!rawPath.startsWith(NOTE_PREFIX) || baseFiles.has(rawPath)) {
      continue;
    }
    const rawFile = rawPath.slice(NOTE_PREFIX.length);
    if (rawFile.includes("/") || !rawFile.endsWith(".json")) {
      continue;
    }
    const file = decodeChangeNoteFilename(rawFile);
    const path = `${NOTE_PREFIX}${file}`;
    const raw = readChangeNoteBlob(templateRoot, path, meta, env);
    const parsed = parseChangeNote(path, raw);
    if (!parsed.ok) {
      throw new CliError(
        "change_note_invalid",
        parsed.problem,
        `fix ${path} in the template, then rerun`,
        1,
        false,
      );
    }
    entries.push(Object.freeze({ file, note: parsed.note }));
  }
  entries.sort((left, right) => {
    if (left.note.breaking !== right.note.breaking) {
      return left.note.breaking ? -1 : 1;
    }
    return compareText(left.file, right.file);
  });
  return Object.freeze(entries);
}
