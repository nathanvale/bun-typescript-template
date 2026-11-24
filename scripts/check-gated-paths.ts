import { readChangesets } from "@changesets/read";
import { kernelPinFile } from "../src/kernel-pin.ts";
import { copiesOf, KERNEL_RECIPE } from "../src/recipe.ts";
import { withoutRepositoryLocation } from "./process-runner.ts";

export type GatedPathCheckResult = {
  readonly stdout: string;
  readonly stderr: string;
  readonly code: number;
};

const gitMilliseconds = 10_000;
const knownFlags = new Set(["--base", "--root"]);
const usage =
  "Usage: bun run scripts/check-gated-paths.ts [--base <revision>] [--root <folder>]\n";

const gatedExactPaths = new Set<string>([
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

export function isGatedTemplatePath(path: string): boolean {
  return path.startsWith("generated-repository/") || gatedExactPaths.has(path);
}

function runGit(
  root: string,
  baseRef: string,
  args: readonly string[],
): string {
  const run = Bun.spawnSync(["git", ...args], {
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
  if (run.exitedDueToTimeout) {
    throw new Error(
      `git ${args.join(" ")} did not finish within ${gitMilliseconds} ms. Repair: resolve the git lock or slow disk, then run bun run check:changesets again.`,
    );
  }
  if (run.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${run.exitCode}: ${run.stderr.toString().trim()}. Repair: fetch ${baseRef} with full history, then run bun run check:changesets again.`,
    );
  }
  return run.stdout.toString();
}

function changedPaths(
  root: string,
  baseRef: string,
  ...range: readonly string[]
): string[] {
  return runGit(root, baseRef, [
    "diff",
    "--ignore-submodules=none",
    "--no-renames",
    "-z",
    "--name-only",
    "--no-relative",
    ...range,
  ])
    .split("\0")
    .filter((path) => path !== "");
}

export async function checkGatedPaths(
  root: string,
  baseRef: string,
): Promise<GatedPathCheckResult> {
  const mergeBase = runGit(root, baseRef, [
    "merge-base",
    baseRef,
    "HEAD",
  ]).trim();
  const gatedPaths = [
    ...new Set([
      ...changedPaths(root, baseRef, mergeBase, "HEAD"),
      ...changedPaths(root, baseRef, "--cached", mergeBase),
      ...changedPaths(root, baseRef, mergeBase),
    ]),
  ].filter(isGatedTemplatePath);
  const [firstGatedPath] = gatedPaths;

  if (
    firstGatedPath !== undefined &&
    (await readChangesets(root, baseRef)).length === 0
  ) {
    return {
      stdout: "",
      stderr: `This branch changes ${gatedPaths.length} gated path(s) (first: ${JSON.stringify(firstGatedPath)}) and adds no changeset. Repair: run bun run --bun changeset add, then git add .changeset. For a change with no consumer effect, run bun run --bun changeset add --empty instead.\n`,
      code: 1,
    };
  }
  return { stdout: "", stderr: "", code: 0 };
}

function optionPair(
  args: readonly string[],
  index: number,
  seen: ReadonlyMap<string, string>,
): readonly [string, string] | undefined {
  const flag = args[index];
  const value = args[index + 1];
  if (flag === undefined || !knownFlags.has(flag) || seen.has(flag)) {
    return undefined;
  }
  if (value === undefined || value === "" || value.startsWith("-")) {
    return undefined;
  }
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

export async function runGatedPathCheck(
  args: readonly string[],
  defaultRoot: string,
): Promise<GatedPathCheckResult> {
  const parsed = parseArguments(args, defaultRoot);
  if (parsed === undefined) return { stdout: "", stderr: usage, code: 2 };
  try {
    return await checkGatedPaths(parsed.root, parsed.base);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `check:changesets: ${reason}\n`,
      code: 2,
    };
  }
}

if (import.meta.main) {
  const result = await runGatedPathCheck(process.argv.slice(2), process.cwd());
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
  process.exitCode = result.code;
}
