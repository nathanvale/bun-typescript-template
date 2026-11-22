import { join } from "node:path";
import { fileModeOf, nameText } from "../src/git-identities.ts";
import { kernelPinFile } from "../src/kernel-pin.ts";
import { copiesOf, KERNEL_LOCKFILE, KERNEL_RECIPE } from "../src/recipe.ts";
import {
  CHANGE_NOTES_FOLDER,
  isChangeNoteFile,
  parseChangeNote,
} from "../src/change-notes.ts";
import { withoutRepositoryLocation } from "./process-runner.ts";

export type ChangeNoteCheckResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

export const templateChangeNoteAffects: ReadonlySet<string> = new Set([
  "bootstrap",
  "generated-repository",
  "kernel-pin",
  "lint-rules",
  "test-support",
]);

const shippedExactPaths = new Set<string>([
  KERNEL_LOCKFILE,
  kernelPinFile,
  "src/bootstrap.ts",
  "src/bootstrap-arguments.ts",
  "src/kernel-pin.ts",
  "src/recipe.ts",
  "src/token-substitution.ts",
  ...copiesOf(KERNEL_RECIPE).flatMap(({ from, only }) =>
    only === undefined ? [] : only.map((name) => `${from}/${name}`),
  ),
]);

const shippedPrefixes = [
  "generated-repository/",
  ...copiesOf(KERNEL_RECIPE)
    .filter(
      ({ from, only }) =>
        only === undefined && !from.startsWith("generated-repository/"),
    )
    .map(({ from }) => `${from}/`),
];

export function isShippedTemplatePath(path: string): boolean {
  return (
    shippedExactPaths.has(path) ||
    shippedPrefixes.some((prefix) => path.startsWith(prefix))
  );
}

const gitMilliseconds = 10_000;
const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const knownFlags = new Set(["--base", "--root"]);
const usage =
  "Usage: bun run check:change-notes [--base <revision>] [--root <folder>]\n";
const notePrefixBytes = Buffer.from(`${CHANGE_NOTES_FOLDER}/`);
const noteReadmeBytes = Buffer.from(`${CHANGE_NOTES_FOLDER}/README.md`);
const shippedPrefixBytes = shippedPrefixes.map((prefix) => Buffer.from(prefix));

type DiffEntry = {
  readonly mode: string;
  readonly blob: string;
  readonly status: string;
  readonly rawPath: Buffer;
  readonly path: string | undefined;
};

function runGit(root: string, args: readonly string[]): Buffer {
  const result = Bun.spawnSync(["git", ...args], {
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
      `git ${args.join(" ")} did not finish within ${gitMilliseconds} ms in ${root}.`,
    );
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed in ${root}: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

function nulFields(output: Buffer): Buffer[] {
  const fields: Buffer[] = [];
  let offset = 0;
  for (let end = output.indexOf(0); end >= 0; end = output.indexOf(0, offset)) {
    fields.push(output.subarray(offset, end));
    offset = end + 1;
  }
  return fields;
}

function diffEntries(root: string, range: string): readonly DiffEntry[] {
  const fields = nulFields(
    runGit(root, [
      "diff",
      "--raw",
      "--no-abbrev",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      "--no-relative",
      "-z",
      range,
    ]),
  );
  if (fields.length % 2 !== 0)
    throw new Error(`git diff ${range} returned an incomplete record.`);
  const entries: DiffEntry[] = [];
  for (let index = 0; index < fields.length; index += 2) {
    const header = fields[index]?.toString("ascii") ?? "";
    const rawPath = fields[index + 1];
    const [, mode = "", , blob = "", status = ""] = header.split(" ");
    if (rawPath === undefined || mode === "" || blob === "" || status === "")
      throw new Error(`git diff ${range} returned an incomplete record.`);
    entries.push({
      mode,
      blob,
      status,
      rawPath,
      path: nameText(rawPath),
    });
  }
  return entries;
}

function isNoteEntry(entry: DiffEntry): boolean {
  return (
    entry.rawPath.subarray(0, notePrefixBytes.length).equals(notePrefixBytes) &&
    !entry.rawPath.equals(noteReadmeBytes)
  );
}

function isShippedEntry(entry: DiffEntry): boolean {
  return entry.path !== undefined
    ? isShippedTemplatePath(entry.path)
    : shippedPrefixBytes.some((prefix) =>
        entry.rawPath.subarray(0, prefix.length).equals(prefix),
      );
}

function entryLabel(entry: DiffEntry): string {
  return entry.path ?? entry.rawPath.toString("hex");
}

function noteProblem(root: string, entry: DiffEntry): string | undefined {
  if (entry.path === undefined)
    return `${CHANGE_NOTES_FOLDER}/ (raw path bytes ${entry.rawPath.toString("hex")}): filename is not valid UTF-8 text. Repair: rename the note to a valid UTF-8 ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<kebab-slug>.json filename.`;
  const file = entry.path.slice(CHANGE_NOTES_FOLDER.length + 1);
  if (file.includes("/") || !isChangeNoteFile(file))
    return `${entry.path}: filename must match ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<kebab-slug>.json with a valid date. Repair: rename the note to start with a valid ISO date and lowercase kebab-case slug.`;
  if (fileModeOf(entry.mode) === undefined)
    return `${entry.path}: must be a plain file in HEAD (git mode ${entry.mode}). Repair: replace ${entry.path} with a regular UTF-8 JSON file.`;
  const bytes = runGit(root, ["cat-file", "blob", entry.blob]);
  let raw: string;
  try {
    raw = strictUtf8.decode(bytes);
  } catch {
    return `${entry.path}: is not valid UTF-8 text. Repair: save ${entry.path} as UTF-8 JSON.`;
  }
  const parsed = parseChangeNote(entry.path, raw, templateChangeNoteAffects);
  return parsed.ok ? undefined : parsed.problem;
}

export function checkChangeNotes(
  root: string,
  base: string,
): ChangeNoteCheckResult {
  const entries = diffEntries(root, `${base}...HEAD`);
  const addedNotes = entries.filter(
    (entry) => entry.status === "A" && isNoteEntry(entry),
  );
  const problems = entries
    .filter((entry) => entry.status !== "D" && isNoteEntry(entry))
    .map((entry) => noteProblem(root, entry))
    .filter((problem): problem is string => problem !== undefined);

  const shippedChanged = entries.filter(isShippedEntry);
  if (shippedChanged.length > 0 && addedNotes.length === 0) {
    const first = shippedChanged[0];
    problems.push(
      `This branch changes ${shippedChanged.length} shipped file(s) (first: ${first === undefined ? "" : entryLabel(first)}) without adding a change note under ${CHANGE_NOTES_FOLDER}/. Repair: add ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<slug>.json (use "kind": "none" if there is no consumer effect).`,
    );
  }
  if (problems.length > 0)
    return {
      stdout: "",
      stderr: problems.map((problem) => `${problem}\n`).join(""),
      code: 1,
    };
  const detail =
    shippedChanged.length === 0
      ? `${entries.length} changed file(s), none on the shipped template surface`
      : `${shippedChanged.length} shipped file(s) covered by ${addedNotes.map(entryLabel).join(", ")}`;
  return {
    stdout: `check:change-notes: OK (${detail}).\n`,
    stderr: "",
    code: 0,
  };
}

function optionPair(
  args: readonly string[],
  index: number,
  seen: ReadonlyMap<string, string>,
): readonly [string, string] | undefined {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === undefined || !knownFlags.has(flag) || seen.has(flag))
    return undefined;
  if (value === undefined || value === "" || value.startsWith("-"))
    return undefined;
  return [flag, value];
}

function parseArguments(
  args: readonly string[],
  defaultRoot: string,
): { readonly base: string; readonly root: string } | undefined {
  const flags = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const pair = optionPair(args, index, flags);
    if (pair === undefined) return undefined;
    flags.set(pair[0], pair[1]);
  }
  return {
    base: flags.get("--base") ?? "origin/main",
    root: flags.get("--root") ?? defaultRoot,
  };
}

export function runChangeNoteCheck(
  args: readonly string[],
  defaultRoot: string,
): ChangeNoteCheckResult {
  const parsed = parseArguments(args, defaultRoot);
  if (parsed === undefined) return { stdout: "", stderr: usage, code: 2 };
  try {
    return checkChangeNotes(parsed.root, parsed.base);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `check:change-notes: ${reason} Repair: ensure the base revision exists locally and run again.\n`,
      code: 2,
    };
  }
}

if (import.meta.main) {
  const result = runChangeNoteCheck(
    process.argv.slice(2),
    join(import.meta.dir, ".."),
  );
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
