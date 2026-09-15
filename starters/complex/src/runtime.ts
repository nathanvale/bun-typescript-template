import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StateDocument } from "./command-contract.ts";
import {
  acquireJournalLock,
  appendJournal,
  JournalLockHeld,
  pendingJournalIntent,
  valueHash,
} from "./journal.ts";

export class InvalidStateDocumentError extends Error {
  constructor() {
    super("persisted state does not match the state schema");
  }
}

export async function inspectState(path: string): Promise<string | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch {
    throw new InvalidStateDocumentError();
  }
  const parsed = StateDocument.safeParse(document);
  if (!parsed.success) throw new InvalidStateDocumentError();
  return parsed.data.value;
}

export async function setState(
  path: string,
  value: string,
): Promise<
  | { effectId: string; status: "blocked" }
  | { effectId: string; status: "completed" }
> {
  const effectId = "effect.set-state";
  const runId = randomUUID();
  const barrierDirectory =
    process.env.NODE_ENV === "test"
      ? (process.env.CLI_EXAMPLE_TEST_LOCK_BARRIER_PATH ?? null)
      : null;
  let release: () => void;
  try {
    release = acquireJournalLock(path, runId, barrierDirectory);
  } catch (error) {
    if (error instanceof JournalLockHeld) {
      return { effectId, status: "blocked" };
    }
    throw error;
  }
  try {
    const pending = await pendingJournalIntent(path);
    if (pending !== null) {
      return { effectId: pending.effectId, status: "blocked" };
    }
    const expectedValueHash = valueHash(value);
    await mkdir(dirname(path), { recursive: true });
    await appendJournal(path, {
      effectId,
      expectedValueHash,
      journalVersion: 1,
      phase: "intent",
      runId,
    });
    if (process.env.NODE_ENV === "test") {
      const readyPath = process.env.CLI_EXAMPLE_TEST_AFTER_INTENT_READY_PATH;
      if (readyPath !== undefined) {
        await writeFile(readyPath, "intent-written\n");
      }
      const milliseconds = Number(
        process.env.CLI_EXAMPLE_TEST_AFTER_INTENT_DELAY_MS ?? "0",
      );
      if (Number.isSafeInteger(milliseconds) && milliseconds > 0) {
        await Bun.sleep(milliseconds);
      }
    }
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ value })}\n`, { flag: "wx" });
    await rename(temporary, path);
    await appendJournal(path, {
      effectId,
      expectedValueHash,
      journalVersion: 1,
      phase: "completed",
      runId,
    });
    return { effectId, status: "completed" };
  } finally {
    release();
  }
}

export async function inspectRecovery(path: string) {
  const pending = await pendingJournalIntent(path);
  if (pending === null) return { effectId: null, state: "none" as const };
  let value: string | null;
  try {
    value = await inspectState(path);
  } catch (error) {
    if (error instanceof InvalidStateDocumentError) {
      return { effectId: pending.effectId, state: "unknown" as const };
    }
    throw error;
  }
  if (value !== null && valueHash(value) === pending.expectedValueHash) {
    return { effectId: pending.effectId, state: "completed" as const };
  }
  return { effectId: pending.effectId, state: "unknown" as const };
}
