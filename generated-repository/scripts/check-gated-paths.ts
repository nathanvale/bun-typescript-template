import { readChangesets } from "@changesets/read";

const baseRef = "origin/main";
const root = process.cwd();

function git(...args: readonly string[]): string {
  const run = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (run.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${run.exitCode}: ${run.stderr.toString().trim()}. Repair: fetch ${baseRef} with full history, then run bun run check:changesets again.`,
    );
  }
  return run.stdout.toString();
}

function changedPaths(...range: readonly string[]): string[] {
  return git(
    "diff",
    "--ignore-submodules=none",
    "--no-renames",
    "-z",
    "--name-only",
    "--no-relative",
    ...range,
  )
    .split("\0")
    .filter((path) => path !== "");
}

function isGatedPath(path: string): boolean {
  return path === "package.json" || path.startsWith("src/");
}

const mergeBase = git("merge-base", baseRef, "HEAD").trim();
const gatedPaths = [
  ...new Set([
    ...changedPaths(mergeBase, "HEAD"),
    ...changedPaths("--cached", mergeBase),
    ...changedPaths(mergeBase),
  ]),
].filter(isGatedPath);
const [firstGatedPath] = gatedPaths;

if (
  firstGatedPath !== undefined &&
  (await readChangesets(root, baseRef)).length === 0
) {
  process.stderr.write(
    `This branch changes ${gatedPaths.length} gated path(s) (first: ${JSON.stringify(firstGatedPath)}) and adds no changeset. Repair: run bun run --bun changeset add, then git add .changeset. For a change with no consumer effect, run bun run --bun changeset add --empty instead.\n`,
  );
  process.exitCode = 1;
}
