import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import { join } from "node:path";
import { kernelPinFile } from "../src/kernel-pin.ts";
import { copiesOf, KERNEL_LOCKFILE, KERNEL_RECIPE } from "../src/recipe.ts";
import {
  CHANGE_NOTES_FOLDER,
  isValidChangeNoteFile,
  parseChangeNote,
} from "./change-notes.ts";
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

function gitDiffPaths(root: string, args: readonly string[]): string[] {
  const result = Bun.spawnSync(
    ["git", "diff", "--name-only", "-z", "--no-renames", ...args],
    {
      cwd: root,
      env: {
        ...withoutRepositoryLocation(process.env),
        GIT_OPTIONAL_LOCKS: "0",
        GIT_NO_LAZY_FETCH: "1",
        GIT_TERMINAL_PROMPT: "0",
      },
      stdout: "pipe",
      stderr: "pipe",
      timeout: gitMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  if (result.exitedDueToTimeout)
    throw new Error(
      `git diff ${args.join(" ")} did not finish within ${gitMilliseconds} ms in ${root}.`,
    );
  if (result.exitCode !== 0)
    throw new Error(
      `git diff ${args.join(" ")} failed in ${root}: ${result.stderr.toString().trim()}`,
    );
  return result.stdout
    .toString()
    .split("\0")
    .filter((entry) => entry !== "");
}

function readPlainUtf8(fullPath: string, displayPath: string): string {
  const fd = openSync(
    fullPath,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!fstatSync(fd).isFile())
      throw new Error(
        `${displayPath}: must be a plain file. Repair: replace it with a regular JSON file.`,
      );
    try {
      return strictUtf8.decode(readFileSync(fd));
    } catch {
      throw new Error(
        `${displayPath}: is not valid UTF-8 text. Repair: save ${displayPath} as UTF-8 JSON.`,
      );
    }
  } finally {
    closeSync(fd);
  }
}

const isNotePath = (path: string) =>
  path.startsWith(`${CHANGE_NOTES_FOLDER}/`) &&
  path !== `${CHANGE_NOTES_FOLDER}/README.md`;

function noteProblem(root: string, path: string): string | undefined {
  const file = path.slice(CHANGE_NOTES_FOLDER.length + 1);
  if (file.includes("/") || !isValidChangeNoteFile(file))
    return `${path}: filename must match ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<kebab-slug>.json with a valid date. Repair: rename the note to start with a valid ISO date and lowercase kebab-case slug.`;
  let raw: string;
  try {
    raw = readPlainUtf8(join(root, path), path);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return reason.startsWith(`${path}:`)
      ? reason
      : `${path}: could not read plain file (${reason}). Repair: make ${path} a readable regular UTF-8 JSON file.`;
  }
  const parsed = parseChangeNote(path, raw, templateChangeNoteAffects);
  return parsed.ok ? undefined : parsed.problem;
}

export function checkChangeNotes(
  root: string,
  base: string,
): ChangeNoteCheckResult {
  const range = `${base}...HEAD`;
  const changed = gitDiffPaths(root, [range]);
  const addedNotes = gitDiffPaths(root, ["--diff-filter=A", range]).filter(
    isNotePath,
  );
  const problems = gitDiffPaths(root, ["--diff-filter=d", range])
    .filter(isNotePath)
    .map((path) => noteProblem(root, path))
    .filter((problem): problem is string => problem !== undefined);

  const shippedChanged = changed.filter(isShippedTemplatePath);
  if (shippedChanged.length > 0 && addedNotes.length === 0)
    problems.push(
      `This branch changes ${shippedChanged.length} shipped file(s) (first: ${shippedChanged[0] ?? ""}) without adding a change note under ${CHANGE_NOTES_FOLDER}/. Repair: add ${CHANGE_NOTES_FOLDER}/YYYY-MM-DD-<slug>.json (use "kind": "none" if there is no consumer effect).`,
    );
  if (problems.length > 0)
    return {
      stdout: "",
      stderr: problems.map((problem) => `${problem}\n`).join(""),
      code: 1,
    };
  const detail =
    shippedChanged.length === 0
      ? `${changed.length} changed file(s), none on the shipped template surface`
      : `${shippedChanged.length} shipped file(s) covered by ${addedNotes.join(", ")}`;
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
