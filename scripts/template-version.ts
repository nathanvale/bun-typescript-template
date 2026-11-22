import {
  closeSync,
  constants,
  lstatSync,
  mkdirSync,
  openSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { fileModeOf, nameText } from "../src/git-identities.ts";
import {
  CHANGE_NOTES_FOLDER,
  type ChangeNoteEntry,
  compareText,
  isValidChangeNoteFile,
  parseChangeNote,
} from "./change-notes.ts";
import {
  nulFields,
  parseDiffEntries,
  templateChangeNoteAffects,
  writeCommandResult,
} from "./check-change-notes.ts";
import { withoutRepositoryLocation } from "./process-runner.ts";
import {
  compareTemplateVersions,
  isValidIsoDate,
  nextTemplateVersion,
  normalizeLead,
  parseTemplateVersion,
  pluralCount,
  renderTemplateVersion,
  STARTING_TEMPLATE_VERSION,
  TEMPLATE_VERSIONS_FOLDER,
  TemplateVersionRefusal,
} from "./template-version-parse.ts";

export type GitReadCommand = "for-each-ref" | "ls-tree" | "diff" | "cat-file";

export type GitReader = (
  root: string,
  command: GitReadCommand,
  args: readonly string[],
) => Buffer;

export type TemplateVersionTag = {
  readonly tag: string;
  readonly version: string;
};

export type TemplateVersionCut = {
  readonly previousTag: string | undefined;
  readonly previousVersion: string;
  readonly version: string;
  readonly date: string;
  readonly relativePath: string;
  readonly written: boolean;
  readonly text: string;
  readonly consumerCount: number;
  readonly internalCount: number;
};

export type TemplateVersionResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

const versionTagPattern = /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/;
const gitMilliseconds = 10_000;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const notePrefixBytes = Buffer.from(`${CHANGE_NOTES_FOLDER}/`);
const noteReadmeBytes = Buffer.from(`${CHANGE_NOTES_FOLDER}/README.md`);
const readOnlyGitCommands: ReadonlySet<string> = new Set<GitReadCommand>([
  "for-each-ref",
  "ls-tree",
  "diff",
  "cat-file",
]);

const usage =
  'Usage: bun run template-version --lead "<one-sentence summary>" [--print] [--date YYYY-MM-DD] [--root <folder>]\n';

export function defaultGitReader(
  root: string,
  command: GitReadCommand,
  args: readonly string[],
): Buffer {
  if (!readOnlyGitCommands.has(command))
    throw new Error(
      `Refused non-read-only git subcommand "${command}". Repair: only read-only git commands may run.`,
    );
  const result = Bun.spawnSync(["git", command, ...args], {
    cwd: root,
    env: {
      ...withoutRepositoryLocation(process.env),
      GIT_OPTIONAL_LOCKS: "0",
      GIT_NO_LAZY_FETCH: "1",
      GIT_TERMINAL_PROMPT: "0",
      GIT_NO_REPLACE_OBJECTS: "1",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${command} ${args.join(" ")} did not finish within ${gitMilliseconds} ms in ${root}.`,
    );
  if (result.exitCode !== 0)
    throw new Error(
      `git ${command} ${args.join(" ")} failed in ${root}: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

function splitByte(output: Buffer, separator: number): Buffer[] {
  const parts: Buffer[] = [];
  let offset = 0;
  for (
    let end = output.indexOf(separator);
    end >= 0;
    end = output.indexOf(separator, offset)
  ) {
    parts.push(output.subarray(offset, end));
    offset = end + 1;
  }
  if (offset < output.length) parts.push(output.subarray(offset));
  return parts;
}

export function latestTemplateVersionTag(
  root: string,
  runGit: GitReader = defaultGitReader,
): TemplateVersionTag | undefined {
  const output = runGit(root, "for-each-ref", [
    "--merged=HEAD",
    "--format=%(refname:short)",
    "refs/tags",
  ]);
  const tags: TemplateVersionTag[] = [];
  for (const rawLine of splitByte(output, 10)) {
    if (rawLine.length === 0) continue;
    const tag = nameText(rawLine);
    if (tag === undefined) continue;
    const match = versionTagPattern.exec(tag);
    if (match?.[1] === undefined) continue;
    parseTemplateVersion(match[1]);
    tags.push({ tag, version: match[1] });
  }
  tags.sort((left, right) =>
    compareTemplateVersions(left.version, right.version),
  );
  return tags.at(-1);
}

type BlobCandidate = {
  readonly mode: string;
  readonly blob: string;
  readonly rawPath: Buffer;
};

function isTrackedNotePath(rawPath: Buffer): boolean {
  return (
    rawPath.subarray(0, notePrefixBytes.length).equals(notePrefixBytes) &&
    !rawPath.equals(noteReadmeBytes)
  );
}

function readCandidateNote(
  root: string,
  candidate: BlobCandidate,
  runGit: GitReader,
): ChangeNoteEntry {
  const decodedPath = nameText(candidate.rawPath);
  if (decodedPath === undefined)
    throw new TemplateVersionRefusal(
      `${CHANGE_NOTES_FOLDER}/ (raw path bytes ${candidate.rawPath.toString("hex")}): filename is not valid UTF-8 text. Repair: rename the change note to a valid UTF-8 ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<kebab-slug>.json filename.`,
    );
  const file = decodedPath.slice(CHANGE_NOTES_FOLDER.length + 1);
  if (file.includes("/") || !isValidChangeNoteFile(file))
    throw new TemplateVersionRefusal(
      `${decodedPath}: filename must match ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<kebab-slug>.json with a valid date. Repair: rename the change note to a valid dated filename.`,
    );
  if (fileModeOf(candidate.mode) === undefined)
    throw new TemplateVersionRefusal(
      `${decodedPath}: must be a plain file in HEAD (git mode ${candidate.mode}). Repair: replace ${decodedPath} with a regular UTF-8 JSON file.`,
    );
  const bytes = runGit(root, "cat-file", ["blob", candidate.blob]);
  let raw: string;
  try {
    raw = strictUtf8.decode(bytes);
  } catch {
    throw new TemplateVersionRefusal(
      `${decodedPath}: is not valid UTF-8 text. Repair: save ${decodedPath} as UTF-8 JSON.`,
    );
  }
  const parsed = parseChangeNote(decodedPath, raw, templateChangeNoteAffects);
  if (!parsed.ok) throw new TemplateVersionRefusal(parsed.problem);
  return Object.freeze({ file, note: parsed.note });
}

function candidatesAtHead(root: string, runGit: GitReader): BlobCandidate[] {
  const output = runGit(root, "ls-tree", [
    "-r",
    "-z",
    "--full-tree",
    "HEAD",
    "--",
    CHANGE_NOTES_FOLDER,
  ]);
  const candidates: BlobCandidate[] = [];
  for (const record of nulFields(output)) {
    const tab = record.indexOf(9);
    if (tab < 0)
      throw new Error("git ls-tree returned an incomplete tree record.");
    const header = record.subarray(0, tab).toString("ascii");
    const rawPath = record.subarray(tab + 1);
    if (!isTrackedNotePath(rawPath)) continue;
    const [mode = "", type = "", blob = ""] = header.split(" ");
    if (mode === "" || type === "" || blob === "")
      throw new Error("git ls-tree returned an incomplete tree record.");
    if (type !== "blob")
      throw new TemplateVersionRefusal(
        `${nameText(rawPath) ?? rawPath.toString("hex")}: must be a plain file in HEAD (git entry "${header}"). Repair: replace it with a regular UTF-8 JSON file.`,
      );
    candidates.push({ mode, blob, rawPath });
  }
  return candidates;
}

function candidatesSinceTag(
  root: string,
  previousTag: string,
  runGit: GitReader,
): BlobCandidate[] {
  const range = `${previousTag}..HEAD`;
  const output = runGit(root, "diff", [
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "-z",
    range,
    "--",
    CHANGE_NOTES_FOLDER,
  ]);
  return parseDiffEntries(output, range)
    .filter((entry) => entry.status === "A" && isTrackedNotePath(entry.rawPath))
    .map(({ mode, blob, rawPath }) => ({ mode, blob, rawPath }));
}

export function readChangeNotesSince(
  root: string,
  previousTag: string | undefined,
  runGit: GitReader = defaultGitReader,
): readonly ChangeNoteEntry[] {
  const candidates =
    previousTag === undefined
      ? candidatesAtHead(root, runGit)
      : candidatesSinceTag(root, previousTag, runGit);
  const entries = candidates.map((candidate) =>
    readCandidateNote(root, candidate, runGit),
  );
  entries.sort((left, right) => compareText(left.file, right.file));
  return Object.freeze(entries);
}

function errorCode(error: unknown): unknown {
  return Reflect.get(Object(error), "code");
}

function writeTemplateVersionFile(
  root: string,
  fileName: string,
  content: string,
): void {
  const folderPath = join(root, TEMPLATE_VERSIONS_FOLDER);
  const relativePath = `${TEMPLATE_VERSIONS_FOLDER}/${fileName}`;
  let folderStat: ReturnType<typeof lstatSync> | undefined;
  try {
    folderStat = lstatSync(folderPath);
  } catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
  }
  if (folderStat === undefined) mkdirSync(folderPath);
  else if (!folderStat.isDirectory())
    throw new TemplateVersionRefusal(
      `${TEMPLATE_VERSIONS_FOLDER} must be a plain folder, not a symlink or file. Repair: replace ${TEMPLATE_VERSIONS_FOLDER} with a directory.`,
    );

  const targetPath = join(folderPath, fileName);
  let descriptor: number;
  try {
    descriptor = openSync(
      targetPath,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o644,
    );
  } catch (error) {
    const code = errorCode(error);
    if (code === "EEXIST" || code === "ELOOP")
      throw new TemplateVersionRefusal(
        `${relativePath} already exists. Repair: inspect or tag the existing template version before cutting a new one.`,
      );
    throw error;
  }
  try {
    writeFileSync(descriptor, content, "utf8");
  } finally {
    closeSync(descriptor);
  }
}

type PendingCut = {
  readonly previousTag: string | undefined;
  readonly previousVersion: string;
  readonly version: string;
  readonly entries: readonly ChangeNoteEntry[];
  readonly consumerCount: number;
  readonly internalCount: number;
};

function resolvePendingCut(root: string, runGit: GitReader): PendingCut {
  const previous = latestTemplateVersionTag(root, runGit);
  const previousVersion = previous?.version ?? STARTING_TEMPLATE_VERSION;
  const sinceLabel =
    previous === undefined
      ? `since starting version ${STARTING_TEMPLATE_VERSION}`
      : `since ${previous.tag}`;
  const entries = readChangeNotesSince(root, previous?.tag, runGit);
  if (entries.length === 0)
    throw new TemplateVersionRefusal(
      `No new change notes found ${sinceLabel}. Repair: commit at least one consumer-facing change note under ${CHANGE_NOTES_FOLDER}/ before cutting a template version.`,
    );
  const version = nextTemplateVersion(
    previousVersion,
    entries.map(({ note }) => note),
  );
  if (version === undefined)
    throw new TemplateVersionRefusal(
      `Only internal (kind: "none") change notes (${entries.length}) were found ${sinceLabel}, so no template version is cut. Repair: wait until a consumer-facing change note lands before cutting a template version.`,
    );
  const consumerCount = entries.filter(
    ({ note }) => note.kind !== "none",
  ).length;
  return {
    previousTag: previous?.tag,
    previousVersion,
    version,
    entries,
    consumerCount,
    internalCount: entries.length - consumerCount,
  };
}

export function cutTemplateVersion({
  root,
  lead,
  date = new Date().toISOString().slice(0, 10),
  printOnly = false,
  runGit = defaultGitReader,
}: {
  readonly root: string;
  readonly lead: string;
  readonly date?: string;
  readonly printOnly?: boolean;
  readonly runGit?: GitReader;
}): TemplateVersionCut {
  const cleanLead = normalizeLead(lead);
  if (!isValidIsoDate(date))
    throw new TemplateVersionRefusal(
      `Invalid date "${date}". Repair: pass --date YYYY-MM-DD with a real calendar date.`,
    );
  const pending = resolvePendingCut(root, runGit);
  const text = renderTemplateVersion({
    version: pending.version,
    date,
    lead: cleanLead,
    entries: pending.entries,
  });
  const fileName = `v${pending.version}.md`;
  const relativePath = `${TEMPLATE_VERSIONS_FOLDER}/${fileName}`;
  if (!printOnly) writeTemplateVersionFile(root, fileName, text);
  return Object.freeze({
    previousTag: pending.previousTag,
    previousVersion: pending.previousVersion,
    version: pending.version,
    date,
    relativePath,
    written: !printOnly,
    text,
    consumerCount: pending.consumerCount,
    internalCount: pending.internalCount,
  });
}

type ParsedArguments = {
  readonly lead: string;
  readonly date: string | undefined;
  readonly root: string;
  readonly printOnly: boolean;
};

const valueFlags = new Set(["--lead", "--date", "--root"]);

type ParseStep =
  | { readonly ok: true; readonly advance: number }
  | { readonly ok: false; readonly message: string };

type ArgumentState = {
  readonly values: Map<string, string>;
  printOnly: boolean;
};

function argumentError(message: string): {
  readonly ok: false;
  readonly message: string;
} {
  return { ok: false, message: `${message}\n${usage}` };
}

function isInvalidFlagValue(flag: string, value: string): boolean {
  if (flag === "--lead") return value.startsWith("--");
  return value === "" || value.startsWith("-");
}

function consumeValueFlag(
  flag: string,
  value: string | undefined,
  values: Map<string, string>,
): ParseStep {
  if (values.has(flag)) return argumentError(`Duplicate flag "${flag}".`);
  if (value === undefined || isInvalidFlagValue(flag, value))
    return argumentError(`Missing value for "${flag}".`);
  values.set(flag, value);
  return { ok: true, advance: 2 };
}

function consumeArgument(
  args: readonly string[],
  index: number,
  state: ArgumentState,
): ParseStep {
  const flag = args[index] ?? "";
  if (flag === "--print") {
    if (state.printOnly) return argumentError('Duplicate flag "--print".');
    state.printOnly = true;
    return { ok: true, advance: 1 };
  }
  if (!valueFlags.has(flag))
    return argumentError(`Unknown argument "${flag}".`);
  return consumeValueFlag(flag, args[index + 1], state.values);
}

function parseArguments(
  args: readonly string[],
  defaultRoot: string,
):
  | { readonly ok: true; readonly value: ParsedArguments }
  | { readonly ok: false; readonly message: string } {
  const state: ArgumentState = { values: new Map(), printOnly: false };
  for (let index = 0; index < args.length; ) {
    const step = consumeArgument(args, index, state);
    if (!step.ok) return step;
    index += step.advance;
  }
  const lead = state.values.get("--lead");
  if (lead === undefined)
    return argumentError('Missing required flag "--lead".');
  return {
    ok: true,
    value: {
      lead,
      date: state.values.get("--date"),
      root: state.values.get("--root") ?? defaultRoot,
      printOnly: state.printOnly,
    },
  };
}

export function runTemplateVersion(
  args: readonly string[],
  defaultRoot: string,
  runGit: GitReader = defaultGitReader,
): TemplateVersionResult {
  const parsed = parseArguments(args, defaultRoot);
  if (!parsed.ok) return { stdout: "", stderr: parsed.message, code: 2 };
  try {
    const cut = cutTemplateVersion({
      root: parsed.value.root,
      lead: parsed.value.lead,
      ...(parsed.value.date === undefined ? {} : { date: parsed.value.date }),
      printOnly: parsed.value.printOnly,
      runGit,
    });
    if (!cut.written) return { stdout: cut.text, stderr: "", code: 0 };
    const omitted =
      cut.internalCount > 0
        ? `, ${pluralCount(cut.internalCount, "internal note")} omitted`
        : "";
    return {
      stdout: `Wrote ${cut.relativePath} (${cut.previousVersion} -> ${cut.version}, ${pluralCount(cut.consumerCount, "consumer note")}${omitted}).\n`,
      stderr: "",
      code: 0,
    };
  } catch (error) {
    if (error instanceof TemplateVersionRefusal)
      return { stdout: "", stderr: `${error.message}\n`, code: 1 };
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `template-version: ${reason} Repair: ensure the target folder is a readable git repository with at least one commit and run again.\n`,
      code: 2,
    };
  }
}

if (import.meta.main) {
  writeCommandResult(
    runTemplateVersion(process.argv.slice(2), join(import.meta.dir, "..")),
  );
}
