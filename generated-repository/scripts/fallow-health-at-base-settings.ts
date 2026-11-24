import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

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
const FALLOW_HEALTH_ARGS =
  "health --complexity --no-type-aware --report-only --format json --quiet --no-cache".split(
    " ",
  );
const FALLOW_SUPPRESSIONS_ARGS =
  "suppressions --no-type-aware --format json --quiet --no-cache".split(" ");
// Platform: Fallow loads the first of these settings files that a folder holds.
const SETTINGS_FILES = [
  ".fallowrc.json",
  ".fallowrc.jsonc",
  "fallow.toml",
  ".fallow.toml",
] as const;
const IGNORE_FILES = new Set([".gitignore", ".ignore"]);
const REGULAR_MODES = new Set(["100644", "100755"]);
const MARKER_REPLACEMENTS: readonly (readonly [string, string])[] = [
  ["fallow-ignore-next-line", "fallow-inert-next-line"],
  ["fallow-ignore-file", "fallow-inert-file"],
];
const PINNED_FALLOW_REPAIR =
  "Repair: install the pinned fallow with bun install --frozen-lockfile, then run this check again.";

function fail(message: string): never {
  throw new Error(message);
}

function spawnGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) {
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
    stdout: run.stdout,
    stderr: run.stderr.toString(),
  };
}

export function runGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
): GitResult {
  const res = spawnGit(root, args, extra);
  return {
    exitCode: res.exitCode,
    stdout: res.stdout.toString(),
    stderr: res.stderr,
  };
}

function mustGitBytes(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>>,
  repair: string,
): Uint8Array {
  const res = spawnGit(root, args, extra);
  if (res.exitCode !== 0)
    fail(
      `git ${args[0] ?? ""} failed: ${res.stderr.trim() || `exit ${res.exitCode}`}. Repair: ${repair}, then run this check again.`,
    );
  return res.stdout;
}

function mustGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>>,
  repair: string,
): string {
  return Buffer.from(mustGitBytes(root, args, extra, repair)).toString();
}

function runFallow(
  fallowBin: string,
  subcommandArgs: readonly string[],
  treeDir: string,
  settingsFile: string,
  rev: string,
): string {
  const command = subcommandArgs[0] ?? "health";
  let run: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    run = Bun.spawnSync(
      [
        fallowBin,
        ...subcommandArgs,
        "--config",
        settingsFile,
        "--root",
        treeDir,
      ],
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
      `fallow ${command} at ${rev} did not finish within ${FALLOW_MS} ms. Repair: run fallow ${command} by hand to see where it waits, then run this check again.`,
    );
  if (run.exitCode !== 0)
    fail(
      `fallow ${command} at ${rev} exited ${run.exitCode}: ${run.stderr.toString().trim()}. Repair: run bun install --frozen-lockfile and verify .fallowrc.json, then run this check again.`,
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

function baseSettingsFile(
  root: string,
  baseSha: string,
  tempDir: string,
): string {
  const listed = mustGit(
    root,
    ["ls-tree", "-z", baseSha, "--", ...SETTINGS_FILES],
    {},
    `fetch ${baseSha} with full history`,
  );
  const entries = new Map<
    string,
    { readonly mode: string; readonly oid: string }
  >();
  for (const line of listed.split("\0")) {
    const tab = line.indexOf("\t");
    if (tab === -1) continue;
    const [mode = "", , oid = ""] = line.slice(0, tab).split(" ");
    entries.set(line.slice(tab + 1), { mode, oid });
  }
  for (const name of SETTINGS_FILES) {
    const entry = entries.get(name);
    if (entry === undefined) continue;
    if (!REGULAR_MODES.has(entry.mode)) {
      const kind =
        entry.mode === "120000"
          ? "a symbolic link"
          : `not a regular file (git mode ${entry.mode})`;
      fail(
        `${name} at ${baseSha} is ${kind}, so the recorded health sizes check refuses to read it. Repair: commit ${name} as a regular file in the base revision, then run this check again.`,
      );
    }
    const bytes = mustGitBytes(
      root,
      ["cat-file", "blob", entry.oid],
      {},
      `run git fsck or fetch ${baseSha} with full history`,
    );
    const path = join(tempDir, name);
    writeFileSync(path, bytes);
    return path;
  }
  const empty = join(tempDir, ".fallowrc.json");
  writeFileSync(empty, "{}\n");
  return empty;
}

// Platform: Fallow skips files that .ignore names, and inside a git repository
// files that .gitignore names.
function removeIgnoreFiles(root: string, rev: string, tree: string): void {
  const paths = mustGit(
    root,
    ["ls-tree", "-r", "-z", "--full-tree", "--name-only", rev],
    {},
    `fetch ${rev} with full history`,
  ).split("\0");
  for (const path of paths)
    if (IGNORE_FILES.has(basename(path)))
      rmSync(join(tree, path), { force: true });
}

function ownRecord(
  value: unknown,
  where: string,
  shape: string,
): ReadonlyMap<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${where} is not ${shape}. ${PINNED_FALLOW_REPAIR}`);
  return new Map<string, unknown>(Object.entries(value));
}

function badSuppressionsField(where: string, field: string): never {
  fail(`${where} has invalid field "${field}". ${PINNED_FALLOW_REPAIR}`);
}

function parseSuppressionLine(item: unknown, where: string): number {
  const line = ownRecord(item, where, "a suppression").get("line");
  if (typeof line !== "number" || !Number.isSafeInteger(line) || line < 1)
    badSuppressionsField(where, "line");
  return line;
}

function parseFileSuppressions(
  entry: unknown,
  where: string,
): readonly [string, readonly number[]] {
  const record = ownRecord(entry, where, "a file suppression entry");
  const rel = record.get("path");
  const suppressions = record.get("suppressions");
  if (typeof rel !== "string" || rel === "")
    badSuppressionsField(where, "path");
  if (!Array.isArray(suppressions)) badSuppressionsField(where, "suppressions");
  return [rel, suppressions.map((item) => parseSuppressionLine(item, where))];
}

function parseReportedMarkers(
  stdout: string,
  rev: string,
): ReadonlyMap<string, ReadonlySet<number>> {
  const where = `fallow suppressions output at ${rev}`;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch (error) {
    fail(
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. ${PINNED_FALLOW_REPAIR}`,
    );
  }
  const files = ownRecord(parsed, where, '{ "files": [...] }').get("files");
  if (!Array.isArray(files)) badSuppressionsField(where, "files");
  const byFile = new Map<string, Set<number>>();
  for (const entry of files) {
    const [rel, lineNumbers] = parseFileSuppressions(entry, where);
    if (lineNumbers.length === 0) continue;
    let lines = byFile.get(rel);
    if (lines === undefined) {
      lines = new Set<number>();
      byFile.set(rel, lines);
    }
    for (const line of lineNumbers) lines.add(line);
  }
  return byFile;
}

function resolveInsideTree(realTree: string, rel: string, rev: string): string {
  if (rel.includes("\0"))
    fail(
      `fallow suppressions at ${rev} reported an invalid file path. ${PINNED_FALLOW_REPAIR}`,
    );
  const target = resolve(realTree, rel);
  if (!target.startsWith(`${realTree}${sep}`))
    fail(
      `fallow suppressions at ${rev} reported ${rel}, outside the measured tree. Repair: commit regular files inside the repository, then run this check again.`,
    );
  let parent: string;
  try {
    parent = realpathSync(dirname(target));
  } catch {
    fail(
      `fallow suppressions at ${rev} reported ${rel}, which does not exist in the measured tree. ${PINNED_FALLOW_REPAIR}`,
    );
  }
  if (parent !== realTree && !parent.startsWith(`${realTree}${sep}`))
    fail(
      `fallow suppressions at ${rev} reported ${rel}, through a symbolic link outside the measured tree. Repair: commit ${rel} as a regular file without a symbolic link, then run this check again.`,
    );
  if (!lstatSync(target, { throwIfNoEntry: false })?.isFile())
    fail(
      `fallow suppressions at ${rev} reported ${rel}, which is not a regular file. Repair: commit ${rel} as a regular file in the repository, then run this check again.`,
    );
  return target;
}

function inertMarkerOnLine(line: string): string {
  let updated = line;
  for (const [marker, inert] of MARKER_REPLACEMENTS)
    updated = updated.replaceAll(marker, inert);
  return updated;
}

function inertFileLines(
  target: string,
  rel: string,
  lineNumbers: ReadonlySet<number>,
  rev: string,
): void {
  const lines = readFileSync(target, "latin1").split("\n");
  for (const lineNumber of lineNumbers) {
    const current = lines[lineNumber - 1];
    if (current === undefined)
      fail(
        `fallow suppressions at ${rev} reported ${rel}:${lineNumber}, past the end of the file. ${PINNED_FALLOW_REPAIR}`,
      );
    const updated = inertMarkerOnLine(current);
    if (updated === current)
      fail(
        `fallow suppressions at ${rev} reported ${rel}:${lineNumber}, which holds no recognised fallow-ignore marker. Repair: update scripts/fallow-health-at-base-settings.ts for this marker, then run this check again.`,
      );
    lines[lineNumber - 1] = updated;
  }
  writeFileSync(target, lines.join("\n"), "latin1");
}

// Platform: Fallow drops a finding that an inline suppression comment marks,
// and fallow suppressions reports every active marker it recognises with file
// and line.
function makeReportedMarkersInert(
  fallowBin: string,
  rev: string,
  tree: string,
  settingsFile: string,
): void {
  const stdout = runFallow(
    fallowBin,
    FALLOW_SUPPRESSIONS_ARGS,
    tree,
    settingsFile,
    rev,
  );
  const reported = parseReportedMarkers(stdout, rev);
  if (reported.size === 0) return;
  const realTree = realpathSync(tree);
  for (const [rel, lineNumbers] of reported)
    inertFileLines(
      resolveInsideTree(realTree, rel, rev),
      rel,
      lineNumbers,
      rev,
    );
}

function runInTree(
  options: MeasureOptions,
  rev: string,
  tree: string,
  settingsFile: string,
): string {
  removeIgnoreFiles(options.root, rev, tree);
  makeReportedMarkersInert(options.fallow, rev, tree, settingsFile);
  return runFallow(options.fallow, FALLOW_HEALTH_ARGS, tree, settingsFile, rev);
}

// Interface: runs fallow health on base and head under the base's settings
// file, with no ignore file or Fallow-reported inline marker in either tree,
// so the change being judged cannot change what is measured.
export function runFallowHealthAtBaseSettings(
  options: MeasureOptions,
  baseSha: string,
  headSha: string,
): { readonly base: string; readonly head: string } {
  const tempDir = mkdtempSync(join(tmpdir(), "recorded-health-sizes-"));
  try {
    const settingsFile = baseSettingsFile(options.root, baseSha, tempDir);
    const baseTree = checkoutTree(options.root, baseSha, tempDir, "base");
    const headTree = checkoutTree(options.root, headSha, tempDir, "head");
    return {
      base: runInTree(options, baseSha, baseTree, settingsFile),
      head: runInTree(options, headSha, headTree, settingsFile),
    };
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
