import { dlopen } from "bun:ffi";
import { closeSync, constants, openSync, readFileSync } from "node:fs";
import { resolveCoordination } from "../../../../starters/contract3/src/addons/state/coordination.ts";
import { attemptLock, attemptPosixLock, library } from "../holder.ts";
import type { Attempt } from "../holder.ts";
import { stayAlive, writeWorkerReport } from "./worker-report.ts";

const [route = "", mode = "", file = "", report = "", option = ""] =
  process.argv.slice(2);

type Outcome = {
  readonly result: "acquired" | "refused" | "error";
  readonly code: string;
  readonly fd: number | null;
};

function viaAddon(path: string): { outcome: Outcome; keep: () => void } {
  const coordination = resolveCoordination();
  if (!coordination.available)
    return {
      outcome: { result: "error", code: coordination.reason, fd: null },
      keep: () => {},
    };
  const attempt = coordination.tryLock(path);
  if (attempt.kind === "held")
    return {
      outcome: { result: "acquired", code: "none", fd: null },
      keep: () => attempt.release,
    };
  return {
    outcome: {
      result: attempt.kind === "busy" ? "refused" : "error",
      code: attempt.kind === "busy" ? "busy" : attempt.code,
      fd: null,
    },
    keep: () => {},
  };
}

function fromTest(attempt: Attempt): { outcome: Outcome; keep: () => void } {
  return attempt.kind === "acquired"
    ? {
        outcome: { result: "acquired", code: "none", fd: attempt.held.fd },
        keep: () => attempt.held.release,
      }
    : {
        outcome: { result: attempt.kind, code: attempt.code, fd: null },
        keep: () => {},
      };
}

function take(path: string): { outcome: Outcome; keep: () => void } {
  switch (route) {
    case "addon":
      return viaAddon(path);
    case "posix-control":
      return fromTest(attemptPosixLock(path));
    case "shared-control":
      return fromTest(attemptLock(path));
    default:
      throw new Error(`Unknown route ${route}.`);
  }
}

function writeReport(value: Readonly<Record<string, unknown>>): void {
  writeWorkerReport(report, value);
}

const retained: unknown[] = [];

function spawnChild(fd: number | null): number {
  const sharing = route === "shared-control" && fd !== null;
  const child = Bun.spawn(
    [process.execPath, "-e", "setInterval(() => {}, 1000000)"],
    {
      stdin: sharing ? fd : "ignore",
      stdout: "ignore",
      stderr: "ignore",
    },
  );
  child.unref();
  return child.pid;
}

// system() starts the shell with every descriptor that is not close-on-exec,
// so this child holds the lock unless the route set the flag itself
// (accepted decision BN-03, 17 November 2026).
function spawnNativeChild(): number {
  const pidFile = `${report}.child`;
  const quoted = `'${pidFile.replaceAll("'", "'\\''")}'`;
  const { symbols } = dlopen(library, {
    system: { args: ["cstring"], returns: "i32" },
  });
  const command = `/bin/sleep 60 </dev/null >/dev/null 2>&1 & echo $! > ${quoted}`;
  const status = symbols.system(Buffer.from(`${command}\0`));
  if (status !== 0)
    throw new Error(`native-child: system() returned ${status}`);
  return Number(readFileSync(pidFile, "utf8").trim());
}

function hold(): void {
  const taken = take(file);
  retained.push(taken.keep());
  if (option === "other-descriptor" && taken.outcome.result === "acquired") {
    const second = openSync(
      file,
      constants.O_RDWR | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(second);
  }
  const acquired = taken.outcome.result === "acquired";
  const child = !acquired
    ? null
    : option === "child"
      ? spawnChild(taken.outcome.fd)
      : option === "native-child"
        ? spawnNativeChild()
        : null;
  writeReport({ ...taken.outcome, child });
  stayAlive();
}

function tryOnce(): void {
  const started = performance.now();
  const taken = take(file);
  const elapsedMs = performance.now() - started;
  writeReport({ ...taken.outcome, elapsedMs });
}

function sameProcess(): void {
  const first = take(file);
  retained.push(first.keep());
  const second = take(file);
  retained.push(second.keep());
  writeReport({ first: first.outcome.result, ...second.outcome });
}

try {
  if (mode === "hold") hold();
  else if (mode === "try") tryOnce();
  else if (mode === "same-process") sameProcess();
  else throw new Error(`Unknown mode ${mode}.`);
} catch (error) {
  writeReport({
    result: "error",
    code: error instanceof Error ? error.message : String(error),
    fd: null,
  });
}
