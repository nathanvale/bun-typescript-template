import { existsSync, readdirSync, readFileSync, readlinkSync } from "node:fs";
import { type Child, startChild } from "../../scripts/process-runner.ts";

const exitBound = 20_000;
const psMilliseconds = 10_000;

// Interface: once `ledger` holds the line `line`, `signal` goes to the child
// alone, as a terminal or CI runner would send it.
export type SignalAt = {
  readonly ledger: string;
  readonly line: string;
  readonly signal: "SIGTERM" | "SIGINT" | "SIGHUP";
};

// Interface: `reached` resolves once the ledger holds the line, and rejects
// naming both once the bound passes first. `stop` ends the wait unsettled.
export type LedgerWatch = {
  readonly reached: Promise<void>;
  readonly stop: () => void;
};

function holdsLine(ledger: string, line: string): boolean {
  return (
    existsSync(ledger) &&
    readFileSync(ledger, "utf8").split("\n").includes(line)
  );
}

// Interface: whether a process with `pid` still exists, alive or a zombie
// its parent has not reaped.
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function watchLedger(
  ledger: string,
  line: string,
  boundMilliseconds: number,
): LedgerWatch {
  const started = Date.now();
  let poll: ReturnType<typeof setInterval> | undefined;
  const reached = new Promise<void>((resolve, reject) => {
    poll = setInterval(() => {
      if (holdsLine(ledger, line)) resolve();
      else if (Date.now() - started >= boundMilliseconds)
        reject(
          new Error(
            `${ledger} did not hold the line "${line}" within ${boundMilliseconds} ms.`,
          ),
        );
      else return;
      clearInterval(poll);
    }, 5);
  });
  return { reached, stop: () => clearInterval(poll) };
}

function signalOnLine(
  child: Child,
  barrier: SignalAt,
  boundMilliseconds: number,
): LedgerWatch {
  const watch = watchLedger(barrier.ledger, barrier.line, boundMilliseconds);
  watch.reached.then(
    () => child.signal(barrier.signal),
    () => {},
  );
  return watch;
}

type ProcessRow = {
  readonly pid: number;
  readonly parent: number;
  readonly group: number;
  readonly text: string;
};

const psColumns = ["pid=", "ppid=", "pgid=", "stat=", "etime=", "args="];

async function processRows(): Promise<ProcessRow[] | undefined> {
  try {
    const ps = Bun.spawn(
      ["ps", "-A", ...psColumns.flatMap((column) => ["-o", column])],
      {
        env: process.env,
        stdout: "pipe",
        stderr: "ignore",
        timeout: psMilliseconds,
        killSignal: "SIGKILL",
      },
    );
    const [text, code] = await Promise.all([
      new Response(ps.stdout).text(),
      ps.exited,
    ]);
    if (code !== 0) return undefined;
    return text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "")
      .map((line) => {
        const [pid, parent, group] = line.split(/\s+/).map(Number);
        return {
          pid: pid ?? 0,
          parent: parent ?? 0,
          group: group ?? 0,
          text: line,
        };
      });
  } catch {
    return undefined;
  }
}

function familyOf(rows: readonly ProcessRow[], root: number): Set<number> {
  const family = new Set([root]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (
        !family.has(row.pid) &&
        (family.has(row.parent) || row.group === root)
      ) {
        family.add(row.pid);
        grew = true;
      }
  }
  return family;
}

function pipesOf(pid: number): string[] {
  const folder = `/proc/${pid}/fd`;
  try {
    return readdirSync(folder).flatMap((name) => {
      try {
        const target = readlinkSync(`${folder}/${name}`);
        return target.startsWith("pipe:") ? [target] : [];
      } catch {
        return [];
      }
    });
  } catch {
    return [];
  }
}

// Platform: Linux lists each process's open files under /proc, so a process that
// still holds the write end of a pipe this test reads can be named. macOS has
// no such listing; there the family rows alone show who is left.
function pipeHolders(rows: readonly ProcessRow[]): string[] {
  if (process.platform !== "linux") return [];
  const ancestors = new Set<number>();
  for (
    let pid = process.pid;
    pid > 1 && !ancestors.has(pid);
    pid = rows.find((row) => row.pid === pid)?.parent ?? 1
  )
    ancestors.add(pid);
  const read = new Set(pipesOf(process.pid));
  return rows
    .filter((row) => !ancestors.has(row.pid))
    .flatMap((row) => {
      const held = [...new Set(pipesOf(row.pid))].filter((pipe) =>
        read.has(pipe),
      );
      return held.length === 0 ? [] : [`${held.join(" ")} held by ${row.text}`];
    });
}

// Interface: what was left of a child when its bound passed, for the failure
// that names the bound: one `ps` row (pid, parent, group, state, elapsed,
// command) for the child and each process it started, or a line saying the
// child had exited, then on Linux each process holding a pipe this test reads.
// When ps cannot start or does not answer, it says so rather than naming no one.
async function stuckProcesses(pid: number): Promise<string> {
  const rows = await processRows();
  if (rows === undefined)
    return `Processes left when the bound passed: unknown, because ps could not start or did not answer within ${psMilliseconds} ms.`;
  const family = familyOf(rows, pid);
  const left = rows.filter((row) => family.has(row.pid));
  const child = left.some((row) => row.pid === pid)
    ? []
    : [`${pid} had exited`];
  return [
    "Processes left when the bound passed:",
    ...child,
    ...left.map((row) => row.text),
    ...pipeHolders(rows),
  ].join("\n");
}

function freeze(pid: number, group: boolean): void {
  try {
    process.kill(group ? -pid : pid, "SIGSTOP");
  } catch (error) {
    if (
      !["ESRCH", "EPERM"].includes(String(Reflect.get(Object(error), "code")))
    )
      throw error;
  }
}

// Interface: a run that outlives its bound is frozen at once with SIGSTOP (its
// whole group with `processGroup`), listed, then killed with SIGKILL, and
// fails naming the bound and the processes left, so a hung case does no more
// work, leaves no fixture process behind and says what it was waiting on.
export async function spawnBounded(
  argv: readonly string[],
  options: {
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly boundMilliseconds?: number;
    readonly signalAt?: SignalAt | undefined;
    readonly processGroup?: boolean;
  } = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const bound = options.boundMilliseconds ?? exitBound;
  const child = startChild(argv, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    ownGroup: options.processGroup === true,
    graceMilliseconds: 0,
  });
  const watch =
    options.signalAt === undefined
      ? undefined
      : signalOnLine(child, options.signalAt, bound);
  let left: string | undefined;
  const limit = setTimeout(() => {
    left = "Processes left when the bound passed: unknown.";
    try {
      freeze(child.pid, options.processGroup === true);
    } catch {
      child.stop();
      return;
    }
    void stuckProcesses(child.pid)
      .then((found) => {
        left = found;
      })
      .finally(() => child.stop());
  }, bound);
  try {
    const run = await child.finished;
    if (left !== undefined)
      throw new Error(
        `${argv.join(" ")} did not exit within ${bound} ms.\n${left}`,
      );
    return { stdout: run.stdout, stderr: run.stderr, exit: run.exitCode };
  } finally {
    clearTimeout(limit);
    watch?.stop();
  }
}

export function processWatchdog(runs: number): number {
  return runs * exitBound + 10_000;
}
