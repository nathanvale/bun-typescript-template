import { dlopen, ptr, read } from "bun:ffi";
import { Database } from "bun:sqlite";
import { closeSync, constants, existsSync, openSync } from "node:fs";
import { stayAlive, writeWorkerReport } from "./worker-report.ts";

const [candidate = "", mode = "", file = "", report = "", extra = "", go = ""] =
  process.argv.slice(2);
const linux = process.platform === "linux";

type Attempt = {
  readonly result: "acquired" | "refused" | "error" | "unsupported";
  readonly code: string;
};
type Handle = {
  readonly tryLock: () => Attempt;
  readonly close: () => void;
  readonly fd: () => number | null;
};

const libraryPath = linux ? "libc.so.6" : "libSystem.B.dylib";
const locks = dlopen(libraryPath, {
  flock: { args: ["i32", "i32"], returns: "i32" },
  fcntl: { args: ["i32", "i32", "ptr"], returns: "i32" },
});
// Platform: errno is read right after a failed call; both libraries are loaded before
// any lock call so nothing in between can overwrite it.
const errnoLocation: () => unknown = linux
  ? dlopen(libraryPath, { __errno_location: { args: [], returns: "ptr" } })
      .symbols.__errno_location
  : dlopen(libraryPath, { __error: { args: [], returns: "ptr" } }).symbols
      .__error;
function errnoName(): string {
  const pointer = errnoLocation();
  const value =
    typeof pointer === "number" && pointer !== 0 ? read.i32(pointer, 0) : -1;
  const names: Record<number, string> = linux
    ? { 11: "EAGAIN", 13: "EACCES", 9: "EBADF", 22: "EINVAL", 37: "ENOLCK" }
    : { 35: "EAGAIN", 13: "EACCES", 9: "EBADF", 22: "EINVAL", 77: "ENOLCK" };
  return names[value] ?? `errno-${value}`;
}
function contended(code: string): boolean {
  return code === "EAGAIN" || code === "EACCES" || code === "EWOULDBLOCK";
}
function message(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 160) : String(error);
}
function errorCode(error: unknown): string {
  const value: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof value === "string" ? value : "";
}

const openFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;

function fromCall(result: number): Attempt {
  if (result === 0) return { result: "acquired", code: "none" };
  const code = errnoName();
  return { result: contended(code) ? "refused" : "error", code };
}

function flockHandle(path: string): Handle {
  const fd = openSync(path, openFlags, 0o600);
  return {
    fd: () => fd,
    tryLock: () => fromCall(locks.symbols.flock(fd, 2 | 4)),
    close: () => closeSync(fd),
  };
}

// Platform: struct flock on Linux x86_64 and aarch64: short l_type, short l_whence,
// (pad), off_t l_start, off_t l_len, pid_t l_pid: 32 bytes, zero = whole file.
function fcntlHandle(path: string, command: number, name: string): Handle {
  if (!linux)
    return {
      fd: () => null,
      tryLock: () => ({
        result: "unsupported",
        code: `${name}-not-called-on-${process.platform}-variadic-fcntl-abi`,
      }),
      close: () => {},
    };
  const fd = openSync(path, openFlags, 0o600);
  const lock = new Uint8Array(32);
  new DataView(lock.buffer).setInt16(0, 1, true);
  return {
    fd: () => fd,
    tryLock: () => fromCall(locks.symbols.fcntl(fd, command, ptr(lock))),
    close: () => closeSync(fd),
  };
}

function sqliteHandle(path: string): Handle {
  const db = new Database(path, { create: true });
  db.exec("PRAGMA busy_timeout = 0");
  return {
    fd: () => null,
    tryLock() {
      try {
        db.exec("BEGIN EXCLUSIVE");
        return { result: "acquired", code: "none" };
      } catch (error) {
        const code = errorCode(error) || message(error);
        return {
          result: /BUSY|LOCKED|locked|busy/.test(code) ? "refused" : "error",
          code,
        };
      }
    },
    close: () => db.close(),
  };
}

function exlockHandle(path: string): Handle {
  let fd: number | null = null;
  return {
    fd: () => fd,
    tryLock() {
      if (linux)
        return {
          result: "unsupported",
          code: "O_EXLOCK-has-no-lock-meaning-on-linux",
        };
      try {
        fd = openSync(path, openFlags | constants.O_NONBLOCK | 0x20, 0o600);
        return { result: "acquired", code: "none" };
      } catch (error) {
        const code = errorCode(error);
        return { result: contended(code) ? "refused" : "error", code };
      }
    },
    close: () => {
      if (fd !== null) closeSync(fd);
    },
  };
}

function open(path: string): Handle {
  switch (candidate) {
    case "flock-ffi":
      return flockHandle(path);
    case "ofd-ffi":
      return fcntlHandle(path, 37, "F_OFD_SETLK");
    case "posix-ffi":
      return fcntlHandle(path, 6, "F_SETLK");
    case "sqlite":
      return sqliteHandle(path);
    case "o-exlock":
      return exlockHandle(path);
    default:
      throw new Error(`Unknown candidate ${candidate}.`);
  }
}

function writeReport(value: Readonly<Record<string, unknown>>): void {
  writeWorkerReport(report, value);
}

const retained: Handle[] = [];

function hold(): void {
  const handle = open(file);
  retained.push(handle);
  const attempt = handle.tryLock();
  if (extra === "other-descriptor" && attempt.result === "acquired") {
    const second = open(file);
    retained.push(second);
    second.close();
  }
  let child: number | null = null;
  if (extra === "child" && attempt.result === "acquired") {
    const spawned = Bun.spawn(
      [process.execPath, "-e", "setInterval(() => {}, 1000000)"],
      { stdin: "ignore", stdout: "ignore", stderr: "ignore" },
    );
    spawned.unref();
    child = spawned.pid;
  }
  writeReport({ ...attempt, fd: handle.fd(), child });
  stayAlive();
}

function tryOnce(): void {
  const handle = open(file);
  const started = performance.now();
  const attempt = handle.tryLock();
  const elapsedMs = Math.round((performance.now() - started) * 10) / 10;
  handle.close();
  writeReport({ ...attempt, elapsedMs });
}

function sameProcess(): void {
  const first = open(file);
  const firstAttempt = first.tryLock();
  const second = open(file);
  const secondAttempt = second.tryLock();
  writeReport({
    first: firstAttempt.result,
    result: secondAttempt.result,
    code: secondAttempt.code,
  });
  second.close();
  first.close();
}

function holdThenTry(): void {
  const handle = open(file);
  retained.push(handle);
  writeReport({ phase: "holding", ...handle.tryLock() });
  const poll = setInterval(() => {
    if (!existsSync(go)) return;
    clearInterval(poll);
    const other = open(extra);
    retained.push(other);
    writeReport({ phase: "attempted", ...other.tryLock() });
    stayAlive();
  }, 5);
}

try {
  if (mode === "hold") hold();
  else if (mode === "try") tryOnce();
  else if (mode === "same-process") sameProcess();
  else if (mode === "hold-then-try") holdThenTry();
  else throw new Error(`Unknown mode ${mode}.`);
} catch (error) {
  writeReport({ result: "error", code: message(error) });
}
