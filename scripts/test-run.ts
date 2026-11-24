import { dlopen, FFIType, ptr } from "bun:ffi";
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export const testRunFolderVariable = "TEST_RUN_FOLDER";
export const testRunProcessVariable = "TEST_RUN_PID";
export const teardownMark = ".test-run-teardown";
export const testRunProcessMark = ".test-run-process";

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
const stoppedCodes = new Set<unknown>(["ESRCH", "EPERM"]);
const missingCodes = new Set<unknown>(["ENOENT", "ENOTDIR"]);
const liveMarkPattern = new RegExp(
  `^${testRunProcessVariable}=([1-9]\\d*)\\n$`,
);
const markFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const darwinStates = ["", "I", "R", "S", "T"];
const [darwinShortInfo, darwinShortBytes, darwinZombie, darwinProcArgs] = [
  13, 64, 5, 49,
] as const;

export function insideFolder(path: string, folder: string): boolean {
  const way = relative(folder, path);
  return way === "" || (!way.startsWith("..") && !isAbsolute(way));
}

const processRow = (
  pid: number,
  parentPid: number,
  group: number,
  state: string,
): ProcessRow => ({
  pid,
  parentPid,
  group,
  text: `pid ${pid} (process group ${group}, state ${state})`,
});

function refusedList(detail: string, tool = "process listing") {
  return {
    ok: false as const,
    message: `${detail}, so the test run cannot list the processes its tests left. Repair: make ${tool} answer, then run the tests again.`,
  };
}

function refusedPs(detail: string) {
  return refusedList(`ps -A ${detail}`, "ps");
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

function psProcessRows(env: TestRunEnvironment) {
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
    .map(([pid, parent, group, state]) =>
      processRow(Number(pid), Number(parent), Number(group), state ?? ""),
    )
    .filter((row) => row.pid !== ps.pid);
  return { ok: true as const, rows };
}

function psCommandOf(pid: number, env: TestRunEnvironment): string {
  try {
    const ps = spawnPs(["-o", "args=", "-p", String(pid)], env);
    return ps.exitCode === 0 ? ps.stdout.toString().trim() : "";
  } catch {
    return "";
  }
}

const { i32, ptr: ffiPtr, u32, u64 } = FFIType;
const loadDarwinLib = () =>
  dlopen("libSystem.B.dylib", {
    proc_listallpids: { args: [ffiPtr, i32], returns: i32 },
    proc_pidinfo: { args: [i32, i32, u64, ffiPtr, i32], returns: i32 },
    sysctl: { args: [ffiPtr, u32, ffiPtr, ffiPtr, ffiPtr, u64], returns: i32 },
  });
let cachedDarwinLib: ReturnType<typeof loadDarwinLib> | undefined;
const darwinLib = () => (cachedDarwinLib ??= loadDarwinLib());

function darwinRowOf(pid: number, info: Uint8Array, view: DataView) {
  if (
    pid <= 0 ||
    darwinLib().symbols.proc_pidinfo(
      pid,
      darwinShortInfo,
      0n,
      ptr(info),
      darwinShortBytes,
    ) < darwinShortBytes
  )
    return undefined;
  const status = view.getUint32(12, true);
  if (status === darwinZombie) return undefined;
  return processRow(
    view.getUint32(0, true),
    view.getUint32(4, true),
    view.getUint32(8, true),
    darwinStates[status] || String(status),
  );
}

function darwinProcessRows() {
  try {
    const { proc_listallpids } = darwinLib().symbols;
    const estimate = proc_listallpids(null, 0);
    if (estimate <= 0)
      return refusedList("libproc proc_listallpids returned no processes");
    const pids = new Int32Array(Math.max(estimate * 2, 1024));
    const count = proc_listallpids(ptr(pids), pids.byteLength);
    if (count <= 0)
      return refusedList("libproc proc_listallpids could not read process ids");
    const info = new Uint8Array(darwinShortBytes);
    const view = new DataView(info.buffer);
    const rows = Array.from(pids.subarray(0, Math.min(count, pids.length)))
      .map((pid) => darwinRowOf(pid, info, view))
      .filter((row): row is ProcessRow => row !== undefined);
    if (rows.length === 0)
      return refusedList("libproc proc_pidinfo returned no readable processes");
    return { ok: true as const, rows };
  } catch (error) {
    return refusedList(
      `libproc failed (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function darwinCommandOf(pid: number): string {
  try {
    const { sysctl } = darwinLib().symbols;
    const [mib, size] = [
      new Int32Array([1, darwinProcArgs, pid]),
      new BigUint64Array([0n]),
    ];
    if (sysctl(ptr(mib), 3, null, ptr(size), null, 0n) !== 0) return "";
    const needed = Number(size[0]);
    if (needed < 4 || needed > 1_048_576) return "";
    const buffer = new Uint8Array(needed + 256);
    size[0] = BigInt(buffer.byteLength);
    if (sysctl(ptr(mib), 3, ptr(buffer), ptr(size), null, 0n) !== 0) return "";
    const argc = Math.max(0, new DataView(buffer.buffer).getInt32(0, true));
    const raw = new TextDecoder("utf-8", { ignoreBOM: true }).decode(
      buffer.subarray(4, Math.min(Number(size[0]), buffer.byteLength)),
    );
    const end = raw.indexOf("\0");
    return end === -1
      ? ""
      : raw
          .slice(end)
          .replace(/^\0+/, "")
          .split("\0")
          .slice(0, argc)
          .join(" ")
          .trim();
  } catch {
    return "";
  }
}

function linuxRowOf(pid: number, processFolder: string) {
  let text: string;
  try {
    text = readFileSync(join(processFolder, String(pid), "stat"), "utf8");
  } catch {
    return undefined;
  }
  const close = text.lastIndexOf(")");
  const [state, parent, group] =
    close === -1 ? [] : text.slice(close + 2).split(" ");
  if (state === undefined || state === "Z" || state === "X") return undefined;
  const [parentPid, groupId] = [Number(parent), Number(group)];
  return Number.isInteger(parentPid) && Number.isInteger(groupId)
    ? processRow(pid, parentPid, groupId, state)
    : undefined;
}

function linuxProcessRows(processFolder: string) {
  try {
    const rows = readdirSync(processFolder)
      .filter((name) => /^[1-9]\d*$/.test(name))
      .map((name) => linuxRowOf(Number(name), processFolder))
      .filter((row): row is ProcessRow => row !== undefined);
    if (rows.length === 0)
      return refusedList(`${processFolder} yielded no readable processes`);
    return { ok: true as const, rows };
  } catch (error) {
    return refusedList(
      `${processFolder} could not be read (${error instanceof Error ? error.message : String(error)})`,
    );
  }
}

function linuxCommandOf(pid: number, processFolder: string): string {
  try {
    return readFileSync(join(processFolder, String(pid), "cmdline"), "utf8")
      .replace(/\0+$/, "")
      .replaceAll("\0", " ")
      .trim();
  } catch {
    return "";
  }
}

export function processRows(
  env: TestRunEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  processFolder = "/proc",
):
  | { readonly ok: true; readonly rows: ProcessRow[] }
  | { readonly ok: false; readonly message: string } {
  const native =
    platform === "darwin"
      ? darwinProcessRows()
      : platform === "linux"
        ? linuxProcessRows(processFolder)
        : undefined;
  if (native?.ok) return native;
  const fallback = psProcessRows(env);
  if (fallback.ok || native === undefined) return fallback;
  return {
    ok: false,
    message: `${native.message} Fallback: ${fallback.message}`,
  };
}

export function commandOf(
  pid: number,
  env: TestRunEnvironment = process.env,
  platform: NodeJS.Platform = process.platform,
  processFolder = "/proc",
): string {
  if (platform === "darwin") return darwinCommandOf(pid);
  if (platform === "linux") return linuxCommandOf(pid, processFolder);
  return psCommandOf(pid, env);
}

export function childProcessRows(
  listed: ReturnType<typeof processRows>,
  rootPid: number = process.pid,
): {
  readonly pid: number;
  readonly group: number;
  readonly row: ProcessRow;
}[] {
  if (!listed.ok) throw new Error(listed.message);
  const own = listed.rows.find((row) => row.pid === rootPid)?.group;
  const family = new Set([rootPid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of listed.rows)
      if (!family.has(row.pid) && family.has(row.parentPid)) {
        family.add(row.pid);
        grew = true;
      }
  }
  return listed.rows
    .filter((row) => row.pid !== rootPid && family.has(row.pid))
    .map((row) => ({
      pid: row.pid,
      group: row.group === own ? 0 : row.group,
      row,
    }));
}

function stopChildTree(rootPid: number, env: TestRunEnvironment): void {
  const listed = processRows(env);
  if (!listed.ok) return;
  for (const child of childProcessRows(listed, rootPid))
    stopProcess(child.group === 0 ? child.pid : child.group, child.group !== 0);
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

function readProcessMark(folder: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(join(folder, testRunProcessMark), markFlags);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = new Uint8Array(64);
    const bytes = readSync(fd, buffer, 0, 64, 0);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer.subarray(0, bytes));
    const pid = Number(liveMarkPattern.exec(text)?.[1]);
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function isLiveRunFolder(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
  } catch (error) {
    return missingCodes.has(Reflect.get(Object(error), "code"));
  }
  const pid = readProcessMark(path);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

function leftoversOf(
  folders: readonly string[],
  before: ReadonlyMap<string, Set<string>>,
  runFolder: string,
): string[] {
  return folders.flatMap((folder) =>
    [...namesIn(folder)]
      .filter((name) => !before.get(folder)?.has(name))
      .map((name) => join(folder, name))
      .filter((path) => path !== runFolder && !isLiveRunFolder(path)),
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
  options: TestRunOptions,
): Promise<number> {
  const killAll = () => {
    stopChildTree(child.pid, options.env);
    stopProcess(child.pid, true, "SIGKILL");
  };
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let forwarded = false;
  const forward = (signal: NodeJS.Signals) => {
    if (forwarded) {
      clearTimeout(escalation);
      killAll();
      return;
    }
    forwarded = true;
    stopProcess(child.pid, true, signal);
    escalation = setTimeout(killAll, signalGraceMilliseconds);
  };
  const limit =
    options.limitMilliseconds === undefined
      ? undefined
      : setTimeout(killAll, options.limitMilliseconds);
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

export function leftoverProcessProblems(
  group: number,
  listed: ReturnType<typeof processRows>,
  env: TestRunEnvironment = process.env,
): string[] {
  if (!listed.ok) return [listed.message];
  const left = listed.rows.filter((row) => row.group === group);
  if (left.length === 0) return [];
  return [
    `Tests left ${left.length} process(es) running after bun test exited, and they were stopped:\n${described(left, env)}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
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
  writeFileSync(
    join(runFolder, testRunProcessMark),
    `${testRunProcessVariable}=${process.pid}\n`,
  );
  const child = startBunTest(args, options, runFolder);
  const problems: string[] = [];
  let code: number;
  let marked: boolean;
  try {
    code = await finished(child, options);
    if (child.signalCode === null)
      problems.push(
        ...leftoverProcessProblems(
          child.pid,
          processRows(options.env),
          options.env,
        ),
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
