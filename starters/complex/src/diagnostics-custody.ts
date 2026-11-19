import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  type Stats,
} from "node:fs";
import { hostname } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const RUN_BYTES = 1_000_000;
const TOTAL_BYTES = 10_000_000;
const FILES = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const HOST = createHash("sha256").update(hostname()).digest("hex").slice(0, 16);
const OWNER = /^owner-([1-9][0-9]{0,9})-([0-9a-f]{16})$/;
const RESIDUE =
  /^\.allocation-lock\.(?:pending|retiring)-([1-9][0-9]{0,9})-([0-9a-f]{16})-[0-9]+$/;
let sequence = 0;

export interface DiagnosticFile {
  fd: number;
  file: string;
  close(): void;
}

function existing(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function trustedDirectory(path: string): void {
  const info = lstatSync(path);
  const uid = process.getuid?.();
  if (!info.isDirectory() || (info.uid !== uid && info.uid !== 0))
    throw new Error("untrusted directory");
  const writableByOthers = (info.mode & 0o022) !== 0;
  const rootOwnedSticky = info.uid === 0 && (info.mode & 0o1000) !== 0;
  if (writableByOthers && !rootOwnedSticky)
    throw new Error("writable ancestor");
}

function ensureTree(path: string): void {
  const parent = dirname(path);
  if (parent !== path) ensureTree(parent);
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  trustedDirectory(path);
}

function stateDirectory(env: Record<string, string | undefined>): string {
  const xdg = env.XDG_STATE_HOME;
  const home = env.HOME;
  const base =
    xdg && isAbsolute(xdg)
      ? xdg
      : home && isAbsolute(home)
        ? join(home, ".local", "state")
        : null;
  if (base === null) throw new Error("private state unavailable");
  return join(resolve(base), "example", "diagnostics");
}

function closedMarker(file: string, info: Stats): string {
  return `${file}.closed-${info.dev}-${info.ino}-${info.size}-${info.mtimeMs}`;
}

interface Allocation {
  file: string;
  info: Stats;
  closed: string | null;
  reserved: number;
}
function inspectAllocation(directory: string, name: string): Allocation {
  const file = join(directory, name);
  const info = lstatSync(file);
  if (!info.isFile() || info.nlink !== 1 || info.uid !== process.getuid?.())
    throw new Error("ambiguous diagnostics entry");
  const marker = closedMarker(file, info);
  const proof = existing(marker);
  const closed =
    proof?.isDirectory() === true &&
    proof.uid === info.uid &&
    (proof.mode & 0o777) === 0o700
      ? marker
      : null;
  return {
    file,
    info,
    closed,
    reserved: closed === null ? Math.max(RUN_BYTES, info.size) : info.size,
  };
}

function removeOrphanedClosureProofs(directory: string, names: string[]): void {
  for (const name of names) {
    const match = /^([a-zA-Z0-9_-]{1,128}\.jsonl)\.closed-[0-9.-]+$/.exec(name);
    if (
      match?.[1] === undefined ||
      existing(join(directory, match[1])) !== null
    )
      continue;
    const marker = join(directory, name);
    const proof = lstatSync(marker);
    if (
      proof.isDirectory() &&
      proof.uid === process.getuid?.() &&
      (proof.mode & 0o777) === 0o700
    )
      rmdirSync(marker);
  }
}

function prune(directory: string): void {
  const names = readdirSync(directory);
  removeOrphanedClosureProofs(directory, names);
  const allocations = names
    .filter((name) => name.endsWith(".jsonl"))
    .map((name) => inspectAllocation(directory, name));
  let bytes = allocations.reduce((sum, item) => sum + item.reserved, 0);
  let count = allocations.length;
  for (const item of allocations.sort(
    (a, b) => a.info.mtimeMs - b.info.mtimeMs,
  )) {
    if (item.closed === null) continue;
    if (
      Date.now() - item.info.mtimeMs <= WEEK_MS &&
      bytes + RUN_BYTES <= TOTAL_BYTES &&
      count < FILES
    )
      continue;
    if (closedMarker(item.file, lstatSync(item.file)) !== item.closed)
      throw new Error("changed diagnostics entry");
    unlinkSync(item.file);
    rmdirSync(item.closed);
    bytes -= item.reserved;
    count -= 1;
  }
  if (bytes + RUN_BYTES > TOTAL_BYTES || count >= FILES)
    throw new Error("capacity");
}

function allocate(directory: string, runIdentity: string): DiagnosticFile {
  const file = join(directory, `${runIdentity}.jsonl`);
  const fd = openSync(
    file,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      constants.O_NONBLOCK,
    0o600,
  );
  const info = fstatSync(fd);
  if (!info.isFile() || info.nlink !== 1 || (info.mode & 0o777) !== 0o600) {
    closeSync(fd);
    throw new Error("unsafe diagnostic file");
  }
  let closed = false;
  return {
    fd,
    file,
    close() {
      if (closed) return;
      const final = fstatSync(fd);
      closeSync(fd);
      closed = true;
      const current = lstatSync(file);
      if (current.dev !== final.dev || current.ino !== final.ino)
        throw new Error("replaced diagnostics file");
      mkdirSync(closedMarker(file, final), { mode: 0o700 });
    },
  };
}

const NO_SUCH_PROCESS = "ESRCH";

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== NO_SUCH_PROCESS;
  }
}

function discard(entry: string): void {
  if (!lstatSync(entry).isDirectory()) {
    unlinkSync(entry);
    return;
  }
  for (const name of readdirSync(entry)) unlinkSync(join(entry, name));
  rmdirSync(entry);
}

function sweepResidue(directory: string): void {
  for (const name of readdirSync(directory)) {
    const match = RESIDUE.exec(name);
    const pid = Number(match?.[1]);
    if (match?.[2] !== HOST || pid === process.pid || alive(pid)) continue;
    if (lstatSync(join(directory, name)).uid === process.getuid?.())
      discard(join(directory, name));
  }
}

function stageAllocationLock(staging: string): string {
  const marker = `owner-${process.pid}-${HOST}`;
  if (existing(staging) !== null) discard(staging);
  mkdirSync(staging, { mode: 0o700 });
  closeSync(
    openSync(
      join(staging, marker),
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW,
      0o600,
    ),
  );
  return marker;
}

function recoverStaleLock(lock: string): void {
  const info = lstatSync(lock);
  if (!info.isDirectory() || info.uid !== process.getuid?.())
    throw new Error("capacity");
  const entries = readdirSync(lock);
  if (entries.length === 1) {
    const name = entries[0] as string;
    const match = OWNER.exec(name);
    const pid = Number(match?.[1]);
    if (match?.[2] !== HOST || pid === process.pid || alive(pid))
      throw new Error("capacity");
    const marker = lstatSync(join(lock, name));
    if (!marker.isFile() || marker.uid !== info.uid)
      throw new Error("capacity");
    try {
      unlinkSync(join(lock, name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  } else if (entries.length !== 0) throw new Error("capacity");
  rmdirSync(lock);
}

function acquireAllocationLock(directory: string): () => void {
  const lock = join(directory, ".allocation-lock");
  sequence += 1;
  const staging = `${lock}.pending-${process.pid}-${HOST}-${sequence}`;
  const retiring = `${lock}.retiring-${process.pid}-${HOST}-${sequence}`;
  sweepResidue(directory);
  if (existing(retiring) !== null) discard(retiring);
  const marker = stageAllocationLock(staging);
  // Platform: rename(2) replaces a directory only when it is empty, so a
  // populated lock that a live holder owns is never displaced.
  try {
    try {
      renameSync(staging, lock);
    } catch {
      recoverStaleLock(lock);
      renameSync(staging, lock);
    }
  } catch {
    discard(staging);
    throw new Error("capacity");
  }
  return () => {
    renameSync(lock, retiring);
    unlinkSync(join(retiring, marker));
    rmdirSync(retiring);
  };
}

export function openDiagnosticFile(
  env: Record<string, string | undefined>,
  runIdentity: string,
): DiagnosticFile {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(runIdentity))
    throw new Error("invalid run identity");
  const directory = stateDirectory(env);
  ensureTree(dirname(directory));
  const info = existing(directory);
  if (info !== null) {
    if (!info.isDirectory() || info.uid !== process.getuid?.())
      throw new Error("unsafe diagnostics directory");
    chmodSync(directory, 0o700);
  } else mkdirSync(directory, { mode: 0o700 });
  trustedDirectory(directory);
  const release = acquireAllocationLock(directory);
  let allocated: DiagnosticFile | null = null;
  let operationFailed = false;
  let operationError: unknown;
  try {
    prune(directory);
    allocated = allocate(directory, runIdentity);
  } catch (error) {
    operationFailed = true;
    operationError = error;
  }
  try {
    release();
  } catch (error) {
    try {
      allocated?.close();
    } catch {
      throw error;
    }
    throw error;
  }
  if (operationFailed) throw operationError;
  if (allocated === null) throw new Error("diagnostic allocation failed");
  return allocated;
}
