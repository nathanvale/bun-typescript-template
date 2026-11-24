import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const testRunFolderVariable = "TEST_RUN_FOLDER";
export const testRunProcessVariable = "TEST_RUN_PID";
export const teardownMark = ".test-run-teardown";

export type TestRunEnvironment = Readonly<Record<string, string | undefined>>;

export type ProcessRow = {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
  readonly text: string;
};

const psMilliseconds = 10_000;
const signalGraceMilliseconds = 2_000;
const runFolderPrefix = "test-run-";
const listingWarningMark = ".test-run-listing-warning";
const stoppedCodes = new Set<unknown>(["ESRCH", "EPERM"]);
const missingCodes = new Set<unknown>(["ENOENT", "ENOTDIR"]);

export function insideFolder(path: string, folder: string): boolean {
  const way = relative(folder, path);
  return way === "" || (!way.startsWith("..") && !isAbsolute(way));
}

function refusedPs(detail: string) {
  return {
    ok: false as const,
    message: `ps -A ${detail}, so the test run cannot list the processes its tests left. Repair: make ps answer, then run the tests again.`,
  };
}

function spawnPs(args: readonly string[], env: TestRunEnvironment) {
  return Bun.spawnSync(["ps", ...args], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: psMilliseconds,
    killSignal: "SIGKILL",
  });
}

export function processRows(
  env: TestRunEnvironment = process.env,
):
  | { readonly ok: true; readonly rows: ProcessRow[] }
  | { readonly ok: false; readonly message: string } {
  let ps: ReturnType<typeof spawnPs>;
  try {
    ps = spawnPs(
      ["-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="],
      env,
    );
  } catch (error) {
    return refusedPs(
      `could not start (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  if (ps.exitedDueToTimeout)
    return refusedPs(`did not answer within ${psMilliseconds} ms`);
  if (ps.exitCode !== 0) {
    const stderr = ps.stderr.toString().trim();
    return refusedPs(
      `exited ${String(ps.exitCode)}${stderr === "" ? "" : ` (${stderr})`} within ${psMilliseconds} ms`,
    );
  }
  const rows = ps.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim().split(/\s+/))
    .filter(([, , , state]) => state !== undefined && !state.startsWith("Z"))
    .map(([pid, parent, group, state]) => ({
      pid: Number(pid),
      parentPid: Number(parent),
      group: Number(group),
      text: `pid ${pid} (process group ${group}, state ${state})`,
    }))
    .filter((row) => row.pid !== ps.pid);
  return { ok: true, rows };
}

export function commandOf(
  pid: number,
  env: TestRunEnvironment = process.env,
): string {
  try {
    const ps = spawnPs(["-o", "args=", "-p", String(pid)], env);
    return ps.exitCode === 0 ? ps.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

export function reportProcessRows(
  runFolder: string,
  message: string,
  report: (line: string) => void,
): void {
  try {
    closeSync(openSync(join(runFolder, listingWarningMark), "wx"));
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "EEXIST") return;
    if (!missingCodes.has(code)) throw error;
  }
  report(
    `Warning: process listing is unavailable, so leftover process names cannot be shown (${message}). Still stopping process groups.`,
  );
}

export function stopProcess(
  pid: number,
  group: boolean,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (!stoppedCodes.has(Reflect.get(Object(error), "code"))) throw error;
  }
}

function described(
  rows: readonly ProcessRow[],
  env: TestRunEnvironment,
): string {
  return rows
    .map((row) => `  ${row.text}: ${commandOf(row.pid, env) || "(exited)"}`)
    .join("\n");
}

function namesIn(folder: string): Set<string> {
  try {
    return new Set(readdirSync(folder));
  } catch (error) {
    if (missingCodes.has(Reflect.get(Object(error), "code"))) return new Set();
    throw error;
  }
}

function realFolder(path: string): string {
  return realpathSync.native(path);
}

function bareTemp(bun: string = process.execPath): string {
  const child = Bun.spawnSync(
    [bun, "-e", "process.stdout.write(require('node:os').tmpdir())"],
    {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
      timeout: psMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  if (child.exitedDueToTimeout || child.exitCode !== 0) {
    const why = child.exitedDueToTimeout
      ? `timed out after ${psMilliseconds} ms`
      : `exited ${String(child.exitCode)}: ${child.stderr.toString().trim() || "(no output)"}`;
    throw new Error(
      `Reading the bare system temp folder with ${bun} ${why}. Repair: check that Bun starts cleanly, then run the tests again.`,
    );
  }
  return child.stdout.toString();
}

export function leftoverFolders(
  env: TestRunEnvironment,
  bun: string = process.execPath,
): string[] {
  if (env[testRunFolderVariable] !== undefined) return [];
  const folders = [env.TMPDIR || tmpdir(), bareTemp(bun)]
    .filter((folder) => folder !== "" && existsSync(folder))
    .map(realFolder);
  return [...new Set(folders)];
}

export type TestRunOptions = {
  readonly cwd: string;
  readonly env: TestRunEnvironment;
  readonly leftoverFolders: readonly string[];
  readonly strict: boolean;
  readonly report: (line: string) => void;
  readonly limitMilliseconds?: number;
};

function leftoversOf(
  folders: readonly string[],
  before: ReadonlyMap<string, Set<string>>,
  runFolder: string,
): string[] {
  return folders.flatMap((folder) =>
    [...namesIn(folder)]
      .filter(
        (name) =>
          !before.get(folder)?.has(name) && !name.startsWith(runFolderPrefix),
      )
      .map((name) => join(folder, name))
      .filter((path) => path !== runFolder),
  );
}

export type TestRunResult = {
  readonly exitCode: number;
  readonly signalCode: NodeJS.Signals | null;
};

function startBunTest(
  args: readonly string[],
  options: TestRunOptions,
  runFolder: string,
) {
  return Bun.spawn([process.execPath, "test", ...args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      TMPDIR: runFolder,
      [testRunFolderVariable]: runFolder,
      [testRunProcessVariable]: String(process.pid),
    },
    stdio: ["inherit", "inherit", "inherit"],
    detached: true,
  });
}

async function finished(
  child: ReturnType<typeof startBunTest>,
  limitMilliseconds: number | undefined,
): Promise<number> {
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let forwarded = false;
  const forward = (signal: NodeJS.Signals) => {
    if (forwarded) {
      clearTimeout(escalation);
      stopProcess(child.pid, true, "SIGKILL");
      return;
    }
    forwarded = true;
    stopProcess(child.pid, true, signal);
    escalation = setTimeout(
      () => stopProcess(child.pid, true, "SIGKILL"),
      signalGraceMilliseconds,
    );
  };
  const limit =
    limitMilliseconds === undefined
      ? undefined
      : setTimeout(() => stopProcess(child.pid, true), limitMilliseconds);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, forward);
  try {
    return await child.exited;
  } finally {
    clearTimeout(limit);
    clearTimeout(escalation);
    for (const signal of signals) process.off(signal, forward);
  }
}

function leftoverProblems(
  leftovers: readonly string[],
  options: TestRunOptions,
): string[] {
  if (leftovers.length === 0) return [];
  const message = `Tests left ${leftovers.length} entry(ies) in the system temp folder, outside the test run folder:\n${leftovers.map((path) => `  ${path}`).join("\n")}\nRepair: make temporary files under os.tmpdir() (testFolder in tests/support/test-folder.ts) and pass process.env to each child, so they land in the test run folder; write no fixed temp path. Then remove the entries above.`;
  if (options.strict) return [message];
  options.report(
    `Warning (another program on this machine may have made these): ${message}`,
  );
  return [];
}

function runningProcessProblems(
  group: number,
  runFolder: string,
  options: TestRunOptions,
): string[] {
  const listed = processRows(options.env);
  if (!listed.ok) {
    if (options.strict) return [listed.message];
    reportProcessRows(runFolder, listed.message, options.report);
    return [];
  }
  const left = listed.rows.filter((row) => row.group === group);
  if (left.length === 0) return [];
  return [
    `Tests left ${left.length} process(es) running after bun test exited, and they were stopped:\n${described(left, options.env)}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
  ];
}

function testRunResult(
  code: number,
  rawSignal: NodeJS.Signals | number | null,
  problemCount: number,
): TestRunResult {
  const signalCode = typeof rawSignal === "string" ? rawSignal : null;
  if (code !== 0 || signalCode !== null) return { exitCode: code, signalCode };
  return { exitCode: problemCount > 0 ? 1 : 0, signalCode };
}

export async function runTests(
  args: readonly string[],
  options: TestRunOptions,
): Promise<TestRunResult> {
  const before = new Map(
    options.leftoverFolders.map((folder) => [folder, namesIn(folder)]),
  );
  const parent = realFolder(options.env.TMPDIR || tmpdir());
  const runFolder = realFolder(mkdtempSync(join(parent, runFolderPrefix)));
  const child = startBunTest(args, options, runFolder);
  const problems: string[] = [];
  let code: number;
  let marked: boolean;
  try {
    code = await finished(child, options.limitMilliseconds);
    if (child.signalCode === null)
      problems.push(...runningProcessProblems(child.pid, runFolder, options));
  } finally {
    stopProcess(child.pid, true);
    marked = existsSync(join(runFolder, teardownMark));
    rmSync(runFolder, { recursive: true, force: true });
  }
  if (code === 0 && !marked)
    problems.push(
      `bun test did not load tests/support/test-run-folder.ts, so nothing stopped a child process left at teardown. Repair: add preload = ["./tests/support/test-run-folder.ts"] under [test] in bunfig.toml.`,
    );
  problems.push(
    ...leftoverProblems(
      leftoversOf(options.leftoverFolders, before, runFolder),
      options,
    ),
  );
  for (const problem of problems) options.report(problem);
  return testRunResult(code, child.signalCode, problems.length);
}

if (import.meta.main) {
  const result = await runTests(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    leftoverFolders: leftoverFolders(process.env),
    strict: process.env.CI === "true",
    report: (line) => process.stderr.write(`${line}\n`),
  });
  if (result.signalCode !== null) process.kill(process.pid, result.signalCode);
  process.exitCode = result.exitCode;
}
