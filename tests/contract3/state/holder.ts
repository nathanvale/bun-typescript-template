import { dlopen, read } from "bun:ffi";
import { closeSync, constants, openSync } from "node:fs";

const linux = process.platform === "linux";
const darwin = process.platform === "darwin";
export const library = linux ? "libc.so.6" : "libSystem.B.dylib";
const lockExclusive = 2;
const lockNonBlocking = 4;
const testLock = 2;
const contention: readonly number[] = linux ? [11, 13] : [35, 13];

type Calls = {
  readonly flock: (fd: number, operation: number) => number;
  readonly lockf: (fd: number, command: number, length: bigint) => number;
  readonly errno: () => number;
};

function errnoReader(location: () => unknown): () => number {
  return () => {
    const pointer = location();
    return typeof pointer === "number" && pointer !== 0
      ? read.i32(pointer, 0)
      : -1;
  };
}

function bindCalls(
  symbols: Pick<Calls, "flock" | "lockf">,
  location: () => unknown,
): Calls {
  return {
    flock: (fd, operation) => symbols.flock(fd, operation),
    lockf: (fd, command, length) => symbols.lockf(fd, command, length),
    errno: errnoReader(location),
  };
}

function loadLinux(): Calls {
  const { symbols } = dlopen(library, {
    flock: { args: ["i32", "i32"], returns: "i32" },
    lockf: { args: ["i32", "i32", "i64"], returns: "i32" },
    __errno_location: { args: [], returns: "ptr" },
  });
  return bindCalls(symbols, () => symbols.__errno_location());
}

function loadDarwin(): Calls {
  const { symbols } = dlopen(library, {
    flock: { args: ["i32", "i32"], returns: "i32" },
    lockf: { args: ["i32", "i32", "i64"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
  });
  return bindCalls(symbols, () => symbols.__error());
}

function load(): Calls | undefined {
  try {
    if (linux) return loadLinux();
    if (darwin) return loadDarwin();
  } catch (error) {
    if (Reflect.get(Object(error), "code") !== "ERR_DLOPEN_FAILED") throw error;
  }
  return undefined;
}

const calls = load();

export const coordinationExpected: boolean =
  darwin ||
  (linux &&
    calls !== undefined &&
    calls.flock(-1, lockExclusive | lockNonBlocking) === -1 &&
    calls.errno() === 9);

export type Held = { readonly fd: number; readonly release: () => void };
export type Attempt =
  | { readonly kind: "acquired"; readonly held: Held }
  | { readonly kind: "refused"; readonly code: string }
  | { readonly kind: "error"; readonly code: string };

function codeOf(error: unknown): string {
  const code: unknown =
    typeof error === "object" && error !== null
      ? Reflect.get(error, "code")
      : undefined;
  return typeof code === "string" ? code : "UNKNOWN";
}

function held(fd: number): Held {
  let open = true;
  return {
    fd,
    release() {
      if (!open) return;
      open = false;
      closeSync(fd);
    },
  };
}

function fromCall(fd: number, result: number): Attempt {
  if (result === 0) return { kind: "acquired", held: held(fd) };
  const errno = calls?.errno() ?? -1;
  closeSync(fd);
  return contention.includes(errno)
    ? { kind: "refused", code: `errno-${errno}` }
    : { kind: "error", code: `errno-${errno}` };
}

const plainFlags = constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW;

export function attemptLock(path: string): Attempt {
  if (darwin) {
    try {
      const fd = openSync(
        path,
        plainFlags | constants.O_NONBLOCK | 0x20,
        0o600,
      );
      return { kind: "acquired", held: held(fd) };
    } catch (error) {
      const code = codeOf(error);
      return code === "EAGAIN" || code === "EWOULDBLOCK"
        ? { kind: "refused", code }
        : { kind: "error", code };
    }
  }
  if (!calls) return { kind: "error", code: "no-test-route" };
  const fd = openSync(path, plainFlags, 0o600);
  return fromCall(fd, calls.flock(fd, lockExclusive | lockNonBlocking));
}

export function attemptPosixLock(path: string): Attempt {
  if (!calls) return { kind: "error", code: "no-test-route" };
  const fd = openSync(path, plainFlags, 0o600);
  return fromCall(fd, calls.lockf(fd, testLock, 0n));
}

export function holdLock(path: string): () => void {
  const attempt = attemptLock(path);
  if (attempt.kind !== "acquired")
    throw new Error(`Test holder did not acquire ${path}: ${attempt.code}.`);
  return attempt.held.release;
}

export function lockFree(path: string): boolean {
  const attempt = attemptLock(path);
  if (attempt.kind === "acquired") attempt.held.release();
  return attempt.kind === "acquired";
}
