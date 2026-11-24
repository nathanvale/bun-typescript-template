import {
  existsSync,
  mkdtempSync,
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
const stoppedCodes = new Set<unknown>(["ESRCH", "EPERM"]);

export function insideFolder(path: string, folder: string): boolean {
  const way = relative(folder, path);
  return way === "" || (!way.startsWith("..") && !isAbsolute(way));
}

export function processRows(): ProcessRow[] {
  const ps = Bun.spawnSync(
    ["ps", "-A", "-o", "pid=", "-o", "ppid=", "-o", "pgid=", "-o", "stat="],
    {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: psMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  if (ps.exitCode !== 0)
    throw new Error(
      `ps -A exited ${String(ps.exitCode)} within ${psMilliseconds} ms, so the test run cannot list the processes its tests left. Repair: make ps answer, then run the tests again.`,
    );
  return ps.stdout
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
}

export function commandOf(pid: number): string {
  const ps = Bun.spawnSync(["ps", "-o", "args=", "-p", String(pid)], {
    env: process.env,
    stdout: "pipe",
    stderr: "ignore",
    timeout: psMilliseconds,
    killSignal: "SIGKILL",
  });
  return ps.stdout.toString().trim();
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

function described(rows: readonly ProcessRow[]): string {
  return rows
    .map((row) => `  ${row.text}: ${commandOf(row.pid) || "(exited)"}`)
    .join("\n");
}

function namesIn(folder: string): Set<string> {
  try {
    return new Set(readdirSync(folder));
  } catch {
    return new Set();
  }
}

function realFolder(path: string): string {
  return realpathSync.native(path);
}

function bareTemp(): string {
  const child = Bun.spawnSync(
    [
      process.execPath,
      "-e",
      "process.stdout.write(require('node:os').tmpdir())",
    ],
    { env: {}, stdout: "pipe", stderr: "pipe", timeout: psMilliseconds },
  );
  return child.stdout.toString();
}

export function leftoverFolders(env: TestRunEnvironment): string[] {
  if (env[testRunFolderVariable] !== undefined) return [];
  const folders = [env.TMPDIR || tmpdir(), bareTemp()]
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
      .filter((name) => !before.get(folder)?.has(name))
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
  const forward = (signal: NodeJS.Signals) =>
    stopProcess(child.pid, true, signal);
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

export async function runTests(
  args: readonly string[],
  options: TestRunOptions,
): Promise<TestRunResult> {
  const before = new Map(
    options.leftoverFolders.map((folder) => [folder, namesIn(folder)]),
  );
  const parent = realFolder(options.env.TMPDIR || tmpdir());
  const runFolder = realFolder(mkdtempSync(join(parent, "test-run-")));
  const child = startBunTest(args, options, runFolder);
  const problems: string[] = [];
  let code: number;
  let marked: boolean;
  try {
    code = await finished(child, options.limitMilliseconds);
    const left = processRows().filter((row) => row.group === child.pid);
    if (left.length > 0)
      problems.push(
        `Tests left ${left.length} process(es) running after bun test exited, and they were stopped:\n${described(left)}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
      );
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
  const signalCode =
    typeof child.signalCode === "string" ? child.signalCode : null;
  if (code !== 0 || signalCode !== null) return { exitCode: code, signalCode };
  return { exitCode: problems.length > 0 ? 1 : 0, signalCode };
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
