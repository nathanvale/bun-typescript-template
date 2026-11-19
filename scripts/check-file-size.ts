import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, join } from "node:path";
import { get_encoding } from "tiktoken";

const limit = 5_000;
const check = "check:file-size";
const gitTimeout = 4_000;
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

const recordedHitsFile = "scripts/file-size-recorded-hits.json";
type RecordedHit = { lifetime: "standing" | "temporary"; reason: string };
type RecordedHits = ReadonlyMap<string, RecordedHit>;

function objectFields(value: unknown): Map<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error(
      `${recordedHitsFile} must contain an object keyed by path.`,
    );
  return new Map(Object.entries(value));
}

function readRecordedHits(bytes: Uint8Array | undefined): RecordedHits {
  if (bytes === undefined)
    throw new Error(`${recordedHitsFile} is missing from the staged files.`);
  const records: unknown = JSON.parse(decoder.decode(bytes));
  const hits = new Map<string, RecordedHit>();
  for (const [path, record] of objectFields(records)) {
    if (excluded(path))
      throw new Error(
        `${recordedHitsFile} names excluded path ${JSON.stringify(path)}. Remove its entry.`,
      );
    const fields = objectFields(record);
    const lifetime = fields.get("lifetime");
    const reason = fields.get("reason");
    if (
      (lifetime !== "standing" && lifetime !== "temporary") ||
      typeof reason !== "string" ||
      reason.trim() === ""
    )
      throw new Error(
        `${recordedHitsFile}: ${JSON.stringify(path)} needs a standing or temporary lifetime and a reason.`,
      );
    hits.set(path, { lifetime, reason });
  }
  return hits;
}

const generatedHooks = new Set([
  ".claude/hooks/fallow-gate.sh",
  ".codex/hooks/fallow-gate.sh",
]);

function excluded(path: string): boolean {
  return (
    basename(path) === "bun.lock" ||
    generatedHooks.has(path) ||
    path.split("/").slice(0, -1).includes("vendor")
  );
}

function git(
  root: string,
  args: readonly string[],
  stdin?: Uint8Array,
): Uint8Array {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    stdin: stdin ?? "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitTimeout,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(`git ${args.join(" ")} timed out after ${gitTimeout} ms.`);
  if (result.exitCode !== 0)
    throw new Error(
      `git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`,
    );
  return result.stdout;
}

function gitFields(root: string, ...args: string[]): string[] {
  const fields = decoder.decode(git(root, args)).split("\0");
  fields.pop();
  return fields;
}

type ReadBytes = () => Uint8Array | undefined;
type Files = Map<string, ReadBytes | undefined>;

function workingBytes(file: string): Uint8Array | undefined {
  try {
    if (lstatSync(file).isFile() && realpathSync(file) === file)
      return readFileSync(file);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
  }
  return undefined;
}

function workingFiles(root: string): Files {
  return new Map(
    gitFields(root, "ls-files", "--cached", "--deduplicate", "-z").map(
      (path) => [path, () => workingBytes(join(root, path))],
    ),
  );
}

function stagedEntries(root: string): Map<string, string | undefined> {
  const fields = gitFields(
    root,
    "diff",
    "--cached",
    "--raw",
    "--no-abbrev",
    "--no-renames",
    "--no-ext-diff",
    "--no-textconv",
    "--no-relative",
    "--ita-invisible-in-index",
    "-z",
    "--",
  );
  const entries = new Map<string, string | undefined>();
  for (let index = 0; index < fields.length; index += 2) {
    const [, mode, , object] = fields[index]?.split(" ") ?? [];
    const path = fields[index + 1];
    if (path === undefined || object === undefined)
      throw new Error("git diff returned an incomplete staged file record.");
    if (excluded(path)) continue;
    const regular = mode === "100644" || mode === "100755";
    entries.set(path, regular ? object : undefined);
  }
  return entries;
}

function batchBlobSize(header: string, object: string): number {
  if (header === `${object} missing`)
    throw new Error(`git cat-file could not read staged blob ${object}.`);
  const match = /^([0-9a-f]+) blob (0|[1-9][0-9]*)$/.exec(header);
  const size = Number(match?.[2]);
  if (match?.[1] !== object || !Number.isSafeInteger(size))
    throw new Error(`git cat-file returned an invalid header for ${object}.`);
  return size;
}

function stagedBlobs(root: string, objects: readonly string[]) {
  const blobs = new Map<string, Uint8Array>();
  if (objects.length === 0) return blobs;
  if (objects.some((object) => !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(object)))
    throw new Error("git diff returned an invalid staged blob ID.");
  const input = new TextEncoder().encode(`${objects.join("\n")}\n`);
  const output = git(
    root,
    ["--no-replace-objects", "cat-file", "--batch"],
    input,
  );
  const lineFeed = 10;
  let offset = 0;
  for (const object of objects) {
    const headerEnd = output.indexOf(lineFeed, offset);
    if (headerEnd < 0)
      throw new Error(
        `git cat-file returned an incomplete header for ${object}.`,
      );
    const size = batchBlobSize(
      decoder.decode(output.subarray(offset, headerEnd)),
      object,
    );
    // Platform: Git puts a line feed after exactly the advertised number of blob bytes.
    const start = headerEnd + 1;
    const end = start + size;
    if (output[end] !== lineFeed)
      throw new Error(
        `git cat-file returned an incomplete payload for ${object}.`,
      );
    blobs.set(object, output.subarray(start, end));
    offset = end + 1;
  }
  if (offset !== output.length)
    throw new Error("git cat-file returned extra staged blob data.");
  return blobs;
}

function stagedScanInputs(root: string) {
  const entries = stagedEntries(root);
  const policy = decoder
    .decode(git(root, ["rev-parse", "--verify", `:${recordedHitsFile}`]))
    .trim();
  const objects = new Set(
    [...entries.values()].filter((object) => object !== undefined),
  );
  objects.add(policy);
  const blobs = stagedBlobs(root, [...objects]);
  const files: Files = new Map(
    [...entries].map(([path, object]) => [
      path,
      object === undefined ? undefined : () => blobs.get(object),
    ]),
  );
  return { files, recordedHits: readRecordedHits(blobs.get(policy)) };
}

function workingScanInputs(root: string) {
  return {
    files: workingFiles(root),
    recordedHits: readRecordedHits(readFileSync(join(root, recordedHitsFile))),
  };
}

function textOf(bytes: Uint8Array | undefined): string | undefined {
  if (bytes === undefined || bytes.includes(0)) return undefined;
  try {
    return decoder.decode(bytes);
  } catch {
    return undefined;
  }
}

function tokenCount(
  read: ReadBytes | undefined,
  encoding: ReturnType<typeof get_encoding>,
) {
  const text = textOf(read?.());
  return text === undefined ? undefined : encoding.encode_ordinary(text).length;
}

type Verdict = { kind: "record" | "problem"; message: string };

function verdict(
  path: string,
  count: number | undefined,
  hit: RecordedHit | undefined,
): Verdict | undefined {
  const label = JSON.stringify(path);
  const oversized = count !== undefined && count > limit;
  if (hit?.lifetime === "temporary" && !oversized)
    return {
      kind: "problem",
      message: `${label}: stale temporary recorded hit (${count === undefined ? "no tracked UTF-8 text" : `${count} tokens`}, limit ${limit}). Repair: remove its entry from ${recordedHitsFile}.`,
    };
  if (count === undefined) return undefined;
  if (hit !== undefined)
    return {
      kind: "record",
      message: `${label}: ${count} tokens (limit ${limit}), ${hit.lifetime} recorded hit. ${hit.reason}`,
    };
  if (oversized)
    return {
      kind: "problem",
      message: `${label}: ${count} tokens exceeds the ${limit}-token limit. Repair: shorten or split the file.`,
    };
  return undefined;
}

function scan(files: Files, recordedHits: RecordedHits, staged: boolean) {
  const notices: Record<Verdict["kind"], string[]> = {
    record: [],
    problem: [],
  };
  let examined = 0;
  const encoding = get_encoding("o200k_base");
  try {
    for (const [path, read] of files) {
      if (excluded(path)) continue;
      const count = tokenCount(read, encoding);
      if (count !== undefined) examined += 1;
      const notice = verdict(path, count, recordedHits.get(path));
      if (notice !== undefined) notices[notice.kind].push(notice.message);
    }
  } finally {
    encoding.free();
  }
  if (examined === 0 && !staged)
    notices.problem.push(
      "no tracked UTF-8 text files to scan. Repair: run the gate in a populated template checkout.",
    );
  return {
    stdout: [
      `${check}: scanned ${examined} ${staged ? "staged" : "tracked"} UTF-8 text files (limit ${limit} tokens).`,
      ...notices.record,
      "",
    ].join("\n"),
    stderr: notices.problem.map((problem) => `${check}: ${problem}\n`).join(""),
    code: notices.problem.length === 0 ? 0 : 1,
  };
}

export function runFileSizeCheck(args: readonly string[], root: string) {
  const [option, ...rest] = args;
  const staged = option === "--staged";
  if (args.length > 0 && (!staged || rest.length > 0))
    return {
      stdout: "",
      stderr: `Usage: bun run ${check} [--staged]\n`,
      code: 2,
    };

  try {
    const tree = realpathSync(root);
    const { files, recordedHits } = staged
      ? stagedScanInputs(tree)
      : workingScanInputs(tree);
    if (!staged) {
      for (const [path, hit] of recordedHits)
        if (hit.lifetime === "temporary" && !files.has(path))
          files.set(path, undefined);
    }
    return scan(files, recordedHits, staged);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      stdout: "",
      stderr: `${check}: ${reason} Repair: resolve the Git or filesystem error and run the gate again.\n`,
      code: 2,
    };
  }
}

if (import.meta.main) {
  const { stdout, stderr, code } = runFileSizeCheck(
    process.argv.slice(2),
    join(import.meta.dir, ".."),
  );
  process.stdout.write(stdout);
  process.stderr.write(stderr);
  process.exitCode = code;
}
