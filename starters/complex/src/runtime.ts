import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { StateDocument } from "./command-contract.ts";
import { appendJournal, pendingJournalIntent, valueHash } from "./journal.ts";

export async function inspectState(path: string): Promise<string | null> {
  try {
    const parsed = StateDocument.safeParse(
      JSON.parse(await readFile(path, "utf8")),
    );
    if (!parsed.success) {
      return null;
    }
    return parsed.data.value;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function setState(path: string, value: string): Promise<string> {
  const effectId = "effect.set-state";
  const runId = randomUUID();
  const expectedValueHash = valueHash(value);
  await mkdir(dirname(path), { recursive: true });
  await appendJournal(path, {
    effectId,
    expectedValueHash,
    journalVersion: 1,
    phase: "intent",
    runId,
  });
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
  return effectId;
}

export async function inspectRecovery(path: string) {
  const pending = await pendingJournalIntent(path);
  if (pending === null) return { effectId: null, state: "none" as const };
  const value = await inspectState(path);
  if (value !== null && valueHash(value) === pending.expectedValueHash) {
    return { effectId: pending.effectId, state: "completed" as const };
  }
  return { effectId: pending.effectId, state: "unknown" as const };
}
