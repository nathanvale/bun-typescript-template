import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { recordedAdditionProblems } from "./glossary-additions.ts";
import {
  namesOnPaths,
  newNameProblems,
  readGlossary,
  readRecordedHits,
  recordedHitsFile,
  stagedNewPaths,
  stagedText,
} from "./glossary.ts";
import { keptMoveTargets } from "./name-moves.ts";
import {
  againstNameWordProblems,
  givenNameWordProblems,
  stagedNameWordProblems,
} from "./name-words.ts";
import { holdsTestFile, readRepository, testFilePlaces } from "./repository.ts";
import { publicNameProblems } from "./public-surface.ts";

const usage =
  "Usage: bun run check:names <path> [path ...] | --staged | --tool-call | --against <revision>";

class UsageError extends Error {}

export type Environment = {
  readonly root: string;
  readonly cwd: string;
  readonly stdin: () => Promise<string>;
};

export type NamesCheckResult = {
  readonly stderr: string;
  readonly code: number;
};

type TextOf = (path: string) => string;

function problemsGiven(textOf: TextOf, names: readonly string[]): string[] {
  return newNameProblems(
    names,
    readGlossary(textOf("GLOSSARY.md")),
    readRecordedHits(textOf(recordedHitsFile)),
  );
}

function placementProblems(tree: string, names: readonly string[]): string[] {
  if (!existsSync(join(tree, "repository.json"))) return [];
  const { testAreas } = readRepository(tree);
  const places = testFilePlaces(testAreas).join(", ");
  return names
    .filter(
      (name) =>
        name.startsWith("tests/") &&
        name.endsWith(".test.ts") &&
        !testAreas.some((area) => holdsTestFile(area, name)),
    )
    .map(
      (name) =>
        `${name} is a test file outside the folders repository.json gives test files. Repair: move it into one of ${places}, or add its folder to testAreas. Done when bun run check:names ${name} passes.`,
    );
}

async function problemsIn(
  tree: string,
  names: readonly string[],
  keptPaths?: ReadonlySet<string>,
): Promise<string[]> {
  return [
    ...problemsGiven((path) => readFileSync(join(tree, path), "utf8"), names),
    ...placementProblems(tree, names),
    ...(await publicNameProblems(
      tree,
      false,
      names.filter((path) => existsSync(join(tree, path))),
    )),
    ...(await givenNameWordProblems(tree, names, keptPaths)),
  ];
}

async function stagedProblems(root: string): Promise<string[]> {
  const names = namesOnPaths(stagedNewPaths(root));
  return [
    ...problemsGiven((path) => stagedText(root, path), names),
    ...placementProblems(root, names),
    ...(await publicNameProblems(root, true)),
    ...(await stagedNameWordProblems(root)),
  ];
}

function pathWithin(tree: string, absolute: string): string | undefined {
  const path = relative(tree, absolute);
  return /^(?:\.\.(?:\/|$)|\/|$)/.test(path) ? undefined : path;
}

function givenPath(root: string, cwd: string, arg: string): string {
  const path = pathWithin(root, resolve(cwd, arg));
  if (path === undefined)
    throw new UsageError(`${arg} is outside this repository.`);
  return path;
}

function givenPaths(
  root: string,
  cwd: string,
  args: readonly string[],
): string[] {
  const option = args.find((arg) => arg.startsWith("--"));
  if (option !== undefined) throw new UsageError(`Unknown option "${option}".`);
  return args.map((arg) => givenPath(root, cwd, arg));
}

function owningTree(path: string): string | undefined {
  const folder = dirname(path);
  if (existsSync(join(folder, ".git"))) return folder;
  return folder === path ? undefined : owningTree(folder);
}

function hasNamesCheck(tree: string): boolean {
  return (
    existsSync(join(tree, "GLOSSARY.md")) &&
    existsSync(join(tree, recordedHitsFile))
  );
}

function sameTree(one: string, other: string): boolean {
  return realpathSync(one) === realpathSync(other);
}

async function problemsCreating(
  root: string,
  file: string,
  keptIn?: (tree: string) => ReadonlySet<string>,
): Promise<string[]> {
  const tree = owningTree(file);
  const own =
    tree === undefined
      ? pathWithin(root, file) !== undefined
      : sameTree(tree, root);
  if (own && !hasNamesCheck(root))
    throw new Error(
      `names check: ${root} has no GLOSSARY.md or no ${recordedHitsFile}, so it cannot judge the names this call creates. Repair: restore both with git restore GLOSSARY.md ${recordedHitsFile}.`,
    );
  if (tree === undefined || !hasNamesCheck(tree)) return [];
  return problemsIn(
    tree,
    namesOnPaths([relative(tree, file)]).filter(
      (name) => !existsSync(join(tree, name)),
    ),
    keptIn?.(tree),
  );
}

function ownFields(value: unknown): Map<string, unknown> {
  return new Map(
    typeof value === "object" && value !== null ? Object.entries(value) : [],
  );
}

type CallReader = {
  readonly field: string;
  readonly created: (value: string) => string[];
};

const callReaders = new Map<unknown, CallReader>([
  ["Write", { field: "file_path", created: (filePath) => [filePath] }],
  [
    "apply_patch",
    {
      field: "command",
      created: (patch) =>
        [...patch.matchAll(/^\*\*\* (?:Add File|Move to): (.+?)\s*$/gm)].map(
          ([, path = ""]) => path,
        ),
    },
  ],
]);

function createdPaths(tool: unknown, input: Map<string, unknown>): string[] {
  const reader = callReaders.get(tool);
  if (reader === undefined)
    throw new Error(
      `--tool-call reads a Write call's file_path and an apply_patch call's command, not a ${String(tool)} call. Repair: wire the names check hook to those two tools.`,
    );
  const value = input.get(reader.field);
  if (typeof value !== "string")
    throw new Error(
      `--tool-call got a ${String(tool)} call whose tool_input has no string ${reader.field}, so it cannot tell which names the call creates. Repair: pass the tool call as the hook receives it.`,
    );
  return reader.created(value);
}

async function toolCallProblems(
  hookInput: string,
  root: string,
  fallbackCwd: string,
): Promise<string[]> {
  const call = ownFields(JSON.parse(hookInput));
  const cwd = call.get("cwd");
  const from =
    typeof cwd === "string" ? resolve(fallbackCwd, cwd) : fallbackCwd;
  const tool = call.get("tool_name");
  const input = ownFields(call.get("tool_input"));
  const keptIn = (tree: string) => keptMoveTargets(tool, input, from, tree);
  const problems = await Promise.all(
    createdPaths(tool, input).map((path) =>
      problemsCreating(root, resolve(from, path), keptIn),
    ),
  );
  return problems.flat();
}

type Mode = (environment: Environment) => Promise<string[]>;

const modes = new Map<string, Mode>([
  ["--staged", ({ root }) => stagedProblems(root)],
  [
    "--tool-call",
    async ({ root, cwd, stdin }) => toolCallProblems(await stdin(), root, cwd),
  ],
]);

async function problemsFor(
  args: readonly string[],
  environment: Environment,
): Promise<string[]> {
  const [first, ...rest] = args;
  if (first === undefined)
    throw new UsageError("Give at least one path, --staged or --tool-call.");
  if (first === "--against") {
    const [revision, ...extra] = rest;
    if (revision === undefined || revision.startsWith("--") || extra.length > 0)
      throw new UsageError("--against takes one revision.");
    return [
      ...recordedAdditionProblems(environment.root, revision, (path) =>
        existsSync(join(environment.root, path))
          ? readFileSync(join(environment.root, path), "utf8")
          : undefined,
      ),
      ...(await publicNameProblems(environment.root, false, undefined, true)),
      ...(await againstNameWordProblems(environment.root, revision)),
    ];
  }
  const mode = modes.get(first);
  if (mode === undefined)
    return Promise.resolve(
      problemsIn(
        environment.root,
        namesOnPaths(givenPaths(environment.root, environment.cwd, args)),
      ),
    );
  if (rest.length > 0) throw new UsageError(`${first} takes no path.`);
  return mode(environment);
}

export async function runNamesCheck(
  args: readonly string[],
  environment: Environment,
): Promise<NamesCheckResult> {
  try {
    const problems = new Set(await problemsFor(args, environment));
    return {
      stderr: [...problems].map((problem) => `${problem}\n`).join(""),
      code: problems.size > 0 ? 1 : 0,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stderr: `${error instanceof UsageError ? `${usage}. ` : ""}${reason}\n`,
      code: 2,
    };
  }
}

if (import.meta.main) {
  const { stderr, code } = await runNamesCheck(process.argv.slice(2), {
    root: join(import.meta.dir, ".."),
    cwd: process.cwd(),
    stdin: () => Bun.stdin.text(),
  });
  process.stderr.write(stderr);
  process.exitCode = code;
}
