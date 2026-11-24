import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

type MeasureOptions = { readonly root: string; readonly fallow: string };
type GitResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

const GIT_MS = 15_000;
const FALLOW_MS = 60_000;
const GIT_LOC_VARS = new Set(
  "GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_SUPER_PREFIX GIT_QUARANTINE_PATH".split(
    " ",
  ),
);
const FALLOW_ARGS =
  "health --complexity --no-type-aware --report-only --format json --quiet --no-cache".split(
    " ",
  );
// Platform: Fallow loads the first of these settings files that a folder holds.
const SETTINGS_FILES = [
  ".fallowrc.json",
  ".fallowrc.jsonc",
  "fallow.toml",
  ".fallow.toml",
] as const;
const IGNORE_FILES = new Set([".gitignore", ".ignore"]);
const INLINE_MARKER = "fallow-ignore";
const INERT_MARKER = "fallow-inert";

function fail(message: string): never {
  throw new Error(message);
}
export function runGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): GitResult {
  const env: Record<string, string | undefined> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
  for (const [k, v] of Object.entries(process.env))
    if (!GIT_LOC_VARS.has(k) && !Object.hasOwn(env, k)) env[k] = v;
  const run = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_MS,
    killSignal: "SIGKILL",
  });
  if (run.exitedDueToTimeout)
    fail(
      `git ${args.join(" ")} did not finish within ${GIT_MS} ms. Repair: resolve the git lock or slow disk, then run this check again.`,
    );
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function mustGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>>,
  repair: string,
): string {
  const res = runGit(root, args, extra);
  if (res.exitCode !== 0)
    fail(
      `git ${args[0] ?? ""} failed: ${res.stderr.trim() || `exit ${res.exitCode}`}. Repair: ${repair}, then run this check again.`,
    );
  return res.stdout;
}

function runFallowHealth(
  fallowBin: string,
  treeDir: string,
  settingsFile: string,
  rev: string,
): string {
  let run: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    run = Bun.spawnSync(
      [fallowBin, ...FALLOW_ARGS, "--config", settingsFile, "--root", treeDir],
      {
        cwd: treeDir,
        stdout: "pipe",
        stderr: "pipe",
        timeout: FALLOW_MS,
        killSignal: "SIGKILL",
      },
    );
  } catch (error) {
    fail(
      `cannot run fallow at ${fallowBin}: ${error instanceof Error ? error.message : String(error)}. Repair: run bun install --frozen-lockfile, then run this check again.`,
    );
  }
  if (run.exitedDueToTimeout)
    fail(
      `fallow health at ${rev} did not finish within ${FALLOW_MS} ms. Repair: run fallow health by hand to see where it waits, then run this check again.`,
    );
  if (run.exitCode !== 0)
    fail(
      `fallow health at ${rev} exited ${run.exitCode}: ${run.stderr.toString().trim()}. Repair: run bun install --frozen-lockfile and verify .fallowrc.json, then run this check again.`,
    );
  return run.stdout.toString();
}

function checkoutTree(
  root: string,
  rev: string,
  tempDir: string,
  name: string,
) {
  const extra = { GIT_INDEX_FILE: join(tempDir, `${name}.index`) };
  const tree = join(tempDir, name);
  mkdirSync(tree, { recursive: true });
  mustGit(root, ["read-tree", rev], extra, `fetch ${rev} with full history`);
  mustGit(
    root,
    ["checkout-index", "-a", `--prefix=${tree}/`],
    extra,
    "run git fsck",
  );
  return tree;
}

function baseSettingsFile(baseTree: string, tempDir: string): string {
  for (const name of SETTINGS_FILES) {
    const path = join(baseTree, name);
    if (lstatSync(path, { throwIfNoEntry: false }) !== undefined) return path;
  }
  const empty = join(tempDir, ".fallowrc.json");
  writeFileSync(empty, "{}\n");
  return empty;
}

// Platform: Fallow skips files that .gitignore or .ignore name, even outside a
// git repository.
function removeIgnoreFiles(root: string, rev: string, tree: string): void {
  const paths = mustGit(
    root,
    ["ls-tree", "-r", "-z", "--name-only", rev],
    {},
    `fetch ${rev} with full history`,
  ).split("\0");
  for (const path of paths)
    if (IGNORE_FILES.has(basename(path)))
      rmSync(join(tree, path), { force: true });
}

// Platform: Fallow drops a finding that a fallow-ignore comment marks.
function makeInlineMarkersInert(root: string, rev: string, tree: string): void {
  const marked = runGit(root, [
    ..."grep -I -l -z -F -e".split(" "),
    INLINE_MARKER,
    rev,
  ]);
  if (marked.exitCode > 1)
    fail(
      `git grep failed at ${rev}: ${marked.stderr.trim() || `exit ${marked.exitCode}`}. Repair: run git fsck, then run this check again.`,
    );
  for (const entry of marked.stdout.split("\0")) {
    const path = join(tree, entry.slice(rev.length + 1));
    if (entry === "" || !lstatSync(path, { throwIfNoEntry: false })?.isFile())
      continue;
    const text = readFileSync(path, "utf8");
    writeFileSync(path, text.replaceAll(INLINE_MARKER, INERT_MARKER));
  }
}

function runInTree(
  options: MeasureOptions,
  rev: string,
  tree: string,
  settingsFile: string,
): string {
  removeIgnoreFiles(options.root, rev, tree);
  makeInlineMarkersInert(options.root, rev, tree);
  return runFallowHealth(options.fallow, tree, settingsFile, rev);
}

// Interface: runs fallow health on base and head under the base's settings
// file, with no ignore file or inline marker in either tree, so the change
// being judged cannot change what is measured.
export function runFallowHealthAtBaseSettings(
  options: MeasureOptions,
  baseSha: string,
  headSha: string,
): { readonly base: string; readonly head: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "recorded-health-sizes-"));
  try {
    const baseTree = checkoutTree(options.root, baseSha, tempDir, "base");
    const headTree = checkoutTree(options.root, headSha, tempDir, "head");
    const settingsFile = baseSettingsFile(baseTree, tempDir);
    return {
      base: runInTree(options, baseSha, baseTree, settingsFile),
      head: runInTree(options, headSha, headTree, settingsFile),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
