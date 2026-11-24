import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

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
const REGULAR_MODES = new Set(["100644", "100755"]);
const CODE_EXTS = new Set(
  ".ts .tsx .mts .cts .js .jsx .mjs .cjs .css .scss .sass .less .jsonc".split(
    " ",
  ),
);
const MARKUP_EXTS = new Set([".html", ".htm", ".vue", ".svelte", ".astro"]);
const REGEX_PREV_CHARS = new Set([..."([{:;,=!&|?+-*%^~<>}"]);
const REGEX_PREV_KEYWORDS = new Set(
  "return case throw in of typeof void delete await yield new else do default".split(
    " ",
  ),
);
const COND_KEYWORDS = new Set(["if", "while", "for", "with"]);

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

type CodeState = {
  canStartRegex: boolean;
  prevCond: boolean;
  readonly braces: number[];
  readonly condParens: boolean[];
  nextIndex: number;
};

const TEMPLATE_TAIL = /(?:\\(?:\r\n|[\s\S])|\$(?!\{)|[^`\\$])*(?:\$\{|`|$)/y;
const REGEX_TAIL = /(?:\\.|\[(?:\\.|[^\]\\\n\r])*(?:\]|$)|[^[/\\\n\r])*\/?/y;

function pushTemplate(interpolated: boolean, state: CodeState): void {
  if (interpolated) state.braces.push(0);
  state.canStartRegex = interpolated;
  state.prevCond = false;
}

function stepCodeBrace(text: string, tok: string, state: CodeState): void {
  if (tok === "{") {
    if (state.braces.length > 0)
      state.braces[state.braces.length - 1] = (state.braces.at(-1) ?? 0) + 1;
    state.canStartRegex = true;
    state.prevCond = false;
    return;
  }
  const depth = state.braces.at(-1) ?? 0;
  if (depth > 0) {
    state.braces[state.braces.length - 1] = depth - 1;
    state.canStartRegex = true;
    state.prevCond = false;
    return;
  }
  state.braces.pop();
  TEMPLATE_TAIL.lastIndex = state.nextIndex;
  const tail = TEMPLATE_TAIL.exec(text);
  if (tail !== null) state.nextIndex = TEMPLATE_TAIL.lastIndex;
  pushTemplate(tail !== null && tail[0].endsWith("${"), state);
}

function stepCodeToken(text: string, tok: string, state: CodeState): void {
  if (tok.startsWith('"') || tok.startsWith("'")) {
    state.canStartRegex = false;
    state.prevCond = false;
    return;
  }
  if (tok.startsWith("`")) {
    pushTemplate(tok.endsWith("${"), state);
    return;
  }
  if (tok === "/" && state.canStartRegex) {
    REGEX_TAIL.lastIndex = state.nextIndex;
    if (REGEX_TAIL.exec(text) !== null) state.nextIndex = REGEX_TAIL.lastIndex;
    state.canStartRegex = false;
    state.prevCond = false;
    return;
  }
  if (tok === "{" || (tok === "}" && state.braces.length > 0)) {
    stepCodeBrace(text, tok, state);
    return;
  }
  if (tok === "(") {
    state.condParens.push(state.prevCond);
    state.canStartRegex = true;
    state.prevCond = false;
    return;
  }
  if (tok === ")") {
    state.canStartRegex = state.condParens.pop() ?? false;
    state.prevCond = false;
    return;
  }
  state.canStartRegex =
    REGEX_PREV_CHARS.has(tok) || REGEX_PREV_KEYWORDS.has(tok);
  state.prevCond = COND_KEYWORDS.has(tok);
}

function inertCodeComments(text: string): string {
  const state: CodeState = {
    canStartRegex: true,
    prevCond: false,
    braces: [],
    condParens: [],
    nextIndex: 0,
  };
  const parts: string[] = [];
  let copied = 0;
  const scanner =
    /\/\/[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|"(?:\\(?:\r\n|[\s\S])|[^"\\\n\r])*"?|'(?:\\(?:\r\n|[\s\S])|[^'\\\n\r])*'?|`(?:\\(?:\r\n|[\s\S])|\$(?!\{)|[^`\\$])*(?:\$\{|`|$)|<\/|[A-Za-z0-9_$]+|\+\+|--|[(){}]|\/|\S/g;
  for (let m = scanner.exec(text); m !== null; m = scanner.exec(text)) {
    const tok = m[0];
    if (tok.startsWith("//") || tok.startsWith("/*")) {
      if (tok.includes(INLINE_MARKER)) {
        parts.push(
          text.slice(copied, m.index),
          tok.replaceAll(INLINE_MARKER, INERT_MARKER),
        );
        copied = scanner.lastIndex;
      }
      continue;
    }
    state.nextIndex = scanner.lastIndex;
    stepCodeToken(text, tok, state);
    scanner.lastIndex = state.nextIndex;
  }
  if (parts.length === 0) return text;
  parts.push(text.slice(copied));
  return parts.join("");
}

function inertMarkupComments(text: string): string {
  return text.replace(
    /<!--[\s\S]*?(?:-->|$)|(<(script|style)(?=[\s/>])(?:[^<>"']|"[^"]*"|'[^']*')*(?<!\/)>)([\s\S]*?)(<\/\2\s*>|$)|<\/?(?:[^<>"']|"[^"]*"|'[^']*')*>/gi,
    (match, open?: string, _tag?: string, body?: string, close?: string) => {
      if (match.startsWith("<!--"))
        return match.replaceAll(INLINE_MARKER, INERT_MARKER);
      if (open === undefined || body === undefined) return match;
      return `${open}${inertCodeComments(body)}${close ?? ""}`;
    },
  );
}

function makeCommentMarkersInert(source: string, filePath: string): string {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".astro") {
    const front = /^(---\r?\n)([\s\S]*?)(\r?\n---(?=\r?\n|$))/.exec(source);
    if (front !== null) {
      const head = `${front[1] ?? ""}${inertCodeComments(front[2] ?? "")}${front[3] ?? ""}`;
      return `${head}${inertMarkupComments(source.slice(front[0].length))}`;
    }
  }
  if (MARKUP_EXTS.has(ext)) return inertMarkupComments(source);
  if (CODE_EXTS.has(ext)) return inertCodeComments(source);
  return source;
}

// Platform: Fallow drops a finding that a fallow-ignore comment marks.
function makeInlineMarkersInert(root: string, rev: string, tree: string): void {
  const marked = runGit(root, [
    ..."grep -l -z --full-name -F -e".split(" "),
    INLINE_MARKER,
    rev,
    "--",
    ":/",
  ]);
  if (marked.exitCode > 1)
    fail(
      `git grep failed at ${rev}: ${marked.stderr.trim() || `exit ${marked.exitCode}`}. Repair: run git fsck, then run this check again.`,
    );
  for (const entry of marked.stdout.split("\0")) {
    if (entry === "") continue;
    const rel = entry.slice(rev.length + 1);
    const path = join(tree, rel);
    if (!lstatSync(path, { throwIfNoEntry: false })?.isFile()) continue;
    const bytes = readFileSync(path, "latin1");
    const updated = makeCommentMarkersInert(bytes, rel);
    if (updated !== bytes) writeFileSync(path, updated, "latin1");
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
