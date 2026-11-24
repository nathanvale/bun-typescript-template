import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  hunksOf,
  patchText,
  place,
  quoted,
  replantRepair,
  type Source,
  sourceIn,
} from "./planted-fault-patch.ts";
import { judged, testRun, type Verdict } from "./planted-fault-verdict.ts";
import {
  runWithOwnTools,
  startChild,
  withoutRepositoryLocation,
} from "./process-runner.ts";

const recordsPath = "tests/planted-faults/fault-records.json";
const patchFolder = "tests/planted-faults/patches";

export type Fault = {
  id: string;
  patch: string;
  testFile: string;
  title: string;
  source: string;
  removesBound?: true;
};

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
const active: { stop?: () => void; stoppedBy?: (typeof signals)[number] } = {};
const stepLimitVariable = "FAULT_REPLAY_STEP_SECONDS";
const defaultStepLimitSeconds = 300;
const gitMilliseconds = 4_000;
const snapshotAuthor = {
  GIT_AUTHOR_NAME: "fault-replay",
  GIT_AUTHOR_EMAIL: "fault-replay@localhost",
  GIT_COMMITTER_NAME: "fault-replay",
  GIT_COMMITTER_EMAIL: "fault-replay@localhost",
};

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function git(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...withoutRepositoryLocation(process.env), ...extra },
    stdout: "pipe",
    stderr: "pipe",
    detached: true,
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${args.join(" ")} did not finish within ${gitMilliseconds / 1000} s. Repair: run it by hand in ${root} to see where it waits, then run this command again.`,
    );
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function gitOrThrow(
  root: string,
  args: readonly string[],
  extra?: Readonly<Record<string, string>>,
): string {
  const result = git(root, args, extra);
  if (!result.ok)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.trim()}`);
  return result.stdout;
}

const repairFor: { readonly [name in keyof Fault]: string } = {
  id: "name it <fix short sha>-<source file name>.",
  patch: `name the planted fault's patch under ${patchFolder}.`,
  testFile: "name a test file relative to the repository root.",
  title:
    "name the bun test -t pattern that selects the test that kills the planted fault.",
  source: "name it <fix short sha> <fix subject>.",
  removesBound:
    "write true for a fault whose only symptom is a timeout, or leave it out.",
};

function parseFault(entry: unknown, where: string, root: string): Fault {
  const own = new Map<string, unknown>(
    typeof entry === "object" && entry !== null ? Object.entries(entry) : [],
  );
  const field = (name: keyof Fault): string => {
    const value = own.get(name);
    if (typeof value !== "string" || value === "")
      throw new Error(
        `${where} needs a non-empty string ${name}. Repair: ${repairFor[name]}`,
      );
    return value;
  };
  const fault = {
    id: field("id"),
    patch: field("patch"),
    testFile: field("testFile"),
    title: field("title"),
    source: field("source"),
  };
  const removesBound = own.get("removesBound");
  if (removesBound !== undefined && removesBound !== true)
    throw new Error(
      `${where} has removesBound ${JSON.stringify(removesBound)}. Repair: ${repairFor.removesBound}`,
    );
  if (!existsSync(join(root, fault.testFile)))
    throw new Error(
      `${where} names testFile ${fault.testFile}, which does not exist. Repair: ${repairFor.testFile}`,
    );
  return removesBound === true ? { ...fault, removesBound } : fault;
}

export function readRecords(root: string): Fault[] {
  const path = join(root, recordsPath);
  if (!existsSync(path)) return [];
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed))
    throw new Error(
      `${recordsPath} must hold an array of fault records. Repair: make its top level one JSON array.`,
    );
  const faults = parsed.map((entry, index) =>
    parseFault(entry, `${recordsPath} record ${index}`, root),
  );
  const ids = new Set<string>();
  for (const { id } of faults) {
    if (ids.has(id))
      throw new Error(
        `${recordsPath} lists ${id} twice. Repair: remove one record, or give it another id.`,
      );
    ids.add(id);
  }
  return faults;
}

function commitWorkingTreeInScratchIndex(root: string): string {
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-index-"));
  try {
    const env = { GIT_INDEX_FILE: join(folder, "index") };
    gitOrThrow(root, ["read-tree", "HEAD"], env);
    gitOrThrow(root, ["add", "--all"], env);
    const tree = gitOrThrow(root, ["write-tree"], env).trim();
    if (tree === gitOrThrow(root, ["rev-parse", "HEAD^{tree}"]).trim())
      return gitOrThrow(root, ["rev-parse", "HEAD"]).trim();
    return gitOrThrow(
      root,
      ["commit-tree", tree, "-p", "HEAD", "-m", "fault-replay: working tree"],
      snapshotAuthor,
    ).trim();
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export function stepLimitMilliseconds(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const given = env[stepLimitVariable];
  if (given === undefined || given === "")
    return defaultStepLimitSeconds * 1000;
  const seconds = Number(given);
  if (!Number.isFinite(seconds) || seconds <= 0)
    throw new Error(
      `${stepLimitVariable} is ${quoted(given)}. Repair: set it to a positive number of seconds, or unset it for ${defaultStepLimitSeconds} s.`,
    );
  return seconds * 1000;
}

class StepTimedOut extends Error {
  constructor(readonly step: string) {
    super(`${step} did not finish within its limit.`);
  }
}

function haltIfStopped(id: string): void {
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while replaying ${id}, so it has no verdict.`,
    );
}

async function step(
  id: string,
  cwd: string,
  argv: readonly string[],
  limitMilliseconds: number,
) {
  const { exitCode, signalCode, timedOut, output } = await runWithOwnTools(
    argv,
    cwd,
    active,
    { limitMilliseconds },
  );
  haltIfStopped(id);
  const shown = argv.filter((arg) => !arg.startsWith("--reporter")).join(" ");
  if (timedOut) throw new StepTimedOut(shown);
  if (signalCode !== null)
    throw new Error(
      `${shown} was killed by ${signalCode} while replaying ${id}, so it has no verdict.`,
    );
  return { passed: exitCode === 0, output };
}

function testArgs(fault: Fault): string[] {
  return ["scripts/test-run.ts", `./${fault.testFile}`, "-t", fault.title];
}

function sourceAt(root: string, base: string): Source {
  return {
    read: (path) => {
      const shown = git(root, ["cat-file", "blob", `${base}:${path}`]);
      return shown.ok ? shown.stdout : undefined;
    },
    holding: (line) => {
      const found = git(root, ["grep", "-l", "-z", "-F", "-e", line, base]);
      if (found.exitCode === 1) return [];
      if (!found.ok)
        throw new Error(
          `git grep -l -F -e ${quoted(line)} ${base} failed: ${found.stderr.trim()}. Repair: run it by hand in ${root} to see why, then run this command again.`,
        );
      return found.stdout
        .split("\0")
        .filter((path) => path !== "")
        .map((path) => path.slice(base.length + 1));
    },
  };
}

async function removeWorktree(
  root: string,
  folder: string,
  dir: string,
  limitMilliseconds: number,
): Promise<void> {
  const worktree = (argv: readonly string[]) =>
    startChild(["git", "worktree", ...argv], { cwd: root, limitMilliseconds })
      .finished;
  const removed = await worktree(["remove", "--force", dir]);
  rmSync(folder, { recursive: true, force: true });
  if (removed.timedOut || removed.exitCode !== 0) await worktree(["prune"]);
}

export async function replay(
  root: string,
  fault: Fault,
  commit: string,
  limitMilliseconds: number,
): Promise<Verdict> {
  const patch = patchText(root, fault);
  const folder = mkdtempSync(join(tmpdir(), "fault-replay-"));
  const dir = join(folder, "tree");
  const gitInTree = (argv: readonly string[]) =>
    step(fault.id, dir, ["git", ...argv], limitMilliseconds);
  const bunInTree = (argv: readonly string[]) =>
    step(fault.id, dir, [process.execPath, ...argv], limitMilliseconds);
  try {
    const added = await step(
      fault.id,
      root,
      ["git", "worktree", "add", "--detach", "--quiet", dir, commit],
      limitMilliseconds,
    );
    if (!added.passed) throw new Error(added.output.trim());
    const listed = await gitInTree(["ls-files", "-z"]);
    if (!listed.passed) throw new Error(listed.output.trim());
    const tracked = new Set(listed.output.split("\0").filter((p) => p !== ""));
    const placement = place(fault.patch, patch, sourceIn(dir, tracked));
    if (placement.kind === "refused")
      return { kind: "STALE", output: placement.cause };
    const installed = await bunInTree(["install", "--frozen-lockfile"]);
    if (!installed.passed)
      throw new Error(
        `bun install --frozen-lockfile failed while replaying ${fault.id}:\n${installed.output}`,
      );
    const tested = async (name: string) => {
      const report = join(folder, `${name}.xml`);
      const args = ["--reporter=junit", `--reporter-outfile=${report}`];
      return testRun(await bunInTree([...testArgs(fault), ...args]), report);
    };
    const faulted = () => {
      for (const [path, text] of placement.files)
        writeFileSync(join(dir, path), text);
      return tested("patched");
    };
    return await judged(await tested("clean"), faulted, fault.removesBound);
  } catch (error) {
    if (error instanceof StepTimedOut)
      return { kind: "TIMEOUT", step: error.step };
    throw error;
  } finally {
    await removeWorktree(root, folder, dir, limitMilliseconds);
  }
}

export function report(
  fault: Fault,
  verdict: Verdict,
  seconds: number,
  limitMilliseconds: number,
): void {
  const took = `in ${seconds.toFixed(1)} s`;
  const shown = `bun test ./${fault.testFile} -t ${quoted(fault.title)}`;
  const done = `Done when bun run fault-replay ${fault.id} passes.`;
  switch (verdict.kind) {
    case "KILLED":
      print(
        `KILLED ${fault.id} ${took}. Failed: ${verdict.failing.join(" | ")}`,
      );
      return;
    case "SURVIVED":
      print(
        `SURVIVED ${fault.id} ${took}. ${shown} passed with ${fault.patch} applied, so no test catches this planted fault.`,
      );
      print(
        `Repair: change ${fault.testFile} so that test fails with the patch applied. ${done}`,
      );
      return;
    case "STALE":
      print(
        `STALE ${fault.id} ${took}. ${fault.patch} no longer applies at this head.`,
      );
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(replantRepair(fault));
      return;
    case "BROKEN":
      print(`BROKEN ${fault.id} ${took}. ${shown} ${verdict.cause}`);
      process.stdout.write(verdict.output.replace(/\n?$/, "\n"));
      print(
        `Repair: make that test pass without the patch, and fail by its own check with it, not by a timeout or a test file that does not load. ${done}`,
      );
      return;
    case "TIMEOUT":
      print(
        `TIMEOUT ${fault.id} ${took}. ${verdict.step} did not finish within ${limitMilliseconds / 1000} s, so the planted fault has no verdict.`,
      );
      print(
        `Repair: run that step by hand to see where it hangs, or raise ${stepLimitVariable}. ${done}`,
      );
      return;
  }
}

const recordFields = [
  "id",
  "patch",
  "testFile",
  "title",
  "source",
  "removesBound",
] as const;

function recordKey(entry: unknown): string {
  const own = new Map<string, unknown>(
    typeof entry === "object" && entry !== null ? Object.entries(entry) : [],
  );
  return JSON.stringify(recordFields.map((name) => own.get(name)));
}

export function faultsTouchedSince(root: string, base: string): string[] {
  if (!git(root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]).ok)
    throw new Error(
      `${base} is not a commit in this repository. Repair: pass a commit or branch, such as origin/main.`,
    );
  const changed = new Set(
    gitOrThrow(root, [
      "diff",
      "--name-only",
      "--no-renames",
      "-z",
      base,
      "HEAD",
    ])
      .split("\0")
      .filter((path) => path !== ""),
  );
  const recordsChanged = changed.has(recordsPath);
  const before = recordsChanged
    ? git(root, ["show", `${base}:${recordsPath}`])
    : undefined;
  const earlier: unknown = before?.ok ? JSON.parse(before.stdout) : [];
  const recordedBefore = new Set(
    (Array.isArray(earlier) ? earlier : []).map(recordKey),
  );
  const recordChanged = (fault: Fault): boolean =>
    recordsChanged && !recordedBefore.has(recordKey(fault));
  const atBase = sourceAt(root, base);
  const patched = (fault: Fault): string[] => {
    const text = patchText(root, fault);
    const placement = place(fault.patch, text, atBase);
    return [
      ...hunksOf(text).map(({ path }) => path),
      ...(placement.kind === "placed"
        ? placement.files.keys()
        : placement.candidates),
    ];
  };
  return readRecords(root)
    .filter(
      (fault) =>
        recordChanged(fault) ||
        changed.has(fault.patch) ||
        changed.has(fault.testFile) ||
        patched(fault).some((path) => changed.has(path)),
    )
    .map(({ id }) => id);
}

export async function replayAll(
  root: string,
  ids: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): Promise<number> {
  const faults = readRecords(root);
  const unknown = ids.filter((id) => !faults.some((fault) => fault.id === id));
  if (unknown.length > 0) {
    process.stderr.write(
      `No fault record ${unknown.join(", ")} in ${recordsPath}. Repair: pass an id that file lists.\n`,
    );
    return 2;
  }
  const chosen =
    ids.length === 0 ? faults : faults.filter(({ id }) => ids.includes(id));
  if (chosen.length === 0) {
    print(
      `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.`,
    );
    return 1;
  }
  const limitMilliseconds = stepLimitMilliseconds(env);
  const commit = commitWorkingTreeInScratchIndex(root);
  const started = performance.now();
  let killed = 0;
  for (const fault of chosen) {
    const begun = performance.now();
    const verdict = await replay(root, fault, commit, limitMilliseconds);
    haltIfStopped(fault.id);
    report(
      fault,
      verdict,
      (performance.now() - begun) / 1000,
      limitMilliseconds,
    );
    if (verdict.kind === "KILLED") killed += 1;
  }
  const seconds = (performance.now() - started) / 1000;
  print(
    `${killed} of ${chosen.length} planted faults KILLED in ${seconds.toFixed(1)} s, ${(seconds / chosen.length).toFixed(1)} s per fault, with Bun ${Bun.version}.`,
  );
  return killed === chosen.length ? 0 : 1;
}

export function add(root: string, argv: readonly string[]): number {
  const [sha, sourcePath, testFile, title] = argv;
  if (
    sha === undefined ||
    sourcePath === undefined ||
    testFile === undefined ||
    title === undefined
  ) {
    process.stderr.write(
      "Usage: bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
    );
    return 2;
  }
  const full = gitOrThrow(root, [
    "rev-parse",
    "--verify",
    `${sha}^{commit}`,
  ]).trim();
  const short = gitOrThrow(root, ["rev-parse", "--short", full]).trim();
  const subject = gitOrThrow(root, ["log", "-1", "--format=%s", full]).trim();
  const reverse = gitOrThrow(root, [
    "diff",
    full,
    `${full}^`,
    "--",
    sourcePath,
  ]);
  if (reverse === "") {
    process.stderr.write(
      `${short} does not change ${sourcePath}. Repair: pass a path that git diff --name-only ${short}^ ${short} lists.\n`,
    );
    return 2;
  }
  const id = `${short}-${basename(sourcePath).replace(/\.[^.]+$/, "")}`;
  const fault = parseFault(
    {
      id,
      patch: `${patchFolder}/${id}.patch`,
      testFile,
      title,
      source: `${short} ${subject}`,
    },
    "planted-fault:add",
    root,
  );
  const faults = readRecords(root);
  if (faults.some((each) => each.id === id)) {
    process.stderr.write(
      `${recordsPath} already lists ${id}. Repair: plant it again by hand, run git diff -- ${quoted(sourcePath)} > ${quoted(fault.patch)}, then undo the planted edit; or add the new record by hand under another id.\n`,
    );
    return 2;
  }
  mkdirSync(join(root, patchFolder), { recursive: true });
  writeFileSync(join(root, fault.patch), reverse);
  faults.push(fault);
  writeFileSync(
    join(root, recordsPath),
    `${JSON.stringify(faults, null, 2)}\n`,
  );
  print(`Added ${id}. Replay it: bun run fault-replay ${id}`);
  return 0;
}

function replayChangedSince(
  root: string,
  [, base, ...extra]: readonly string[],
): Promise<number> | number {
  if (base === undefined || extra.length > 0) {
    process.stderr.write(
      "Usage: bun run fault-replay --changed-since <base>\n",
    );
    return 2;
  }
  if (readRecords(root).length === 0) return replayAll(root, [], process.env);
  const ids = faultsTouchedSince(root, base);
  if (ids.length > 0) return replayAll(root, ids, process.env);
  const short = gitOrThrow(root, ["rev-parse", "--short", base]).trim();
  print(
    `No planted fault patches a file changed since ${short}, so there is nothing to replay.`,
  );
  return 0;
}

async function main(
  root: string,
  [command, ...rest]: readonly string[],
): Promise<number> {
  if (command === "replay" && rest[0] === "--changed-since")
    return replayChangedSince(root, rest);
  if (command === "replay") return replayAll(root, rest, process.env);
  if (command === "add") return add(root, rest);
  process.stderr.write(
    "Usage: bun run fault-replay [id ...] | bun run fault-replay --changed-since <base> | bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
  );
  return 2;
}

if (import.meta.main) {
  for (const signal of signals)
    process.on(signal, () => {
      active.stoppedBy ??= signal;
      process.exitCode = 128 + constants.signals[active.stoppedBy];
      active.stop?.();
    });

  let code: number;
  try {
    code = await main(join(import.meta.dir, ".."), process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    code = 2;
  }
  process.exitCode =
    active.stoppedBy === undefined
      ? code
      : 128 + constants.signals[active.stoppedBy];
}
