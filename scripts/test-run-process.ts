import { dlopen, FFIType, ptr } from "bun:ffi";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type TestRunEnvironment = Readonly<Record<string, string | undefined>>;

export type ProcessRow = {
  readonly pid: number;
  readonly parentPid: number;
  readonly group: number;
  readonly text: string;
};

const psMilliseconds = 10_000;
const stoppedCodes = new Set<unknown>(["ESRCH", "EPERM"]);
const darwinStates = ["", "I", "R", "S", "T"];
const [darwinShortInfo, darwinShortBytes, darwinZombie, darwinProcArgs] = [
  13, 64, 5, 49,
] as const;

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
