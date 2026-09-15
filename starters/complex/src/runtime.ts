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

export async function setState(
  path: string,
  value: string,
): Promise<
  | { effectId: string; status: "blocked" }
  | { effectId: string; status: "completed" }
> {
  const effectId = "effect.set-state";
  const pending = await pendingJournalIntent(path);
  if (pending !== null) {
    return { effectId: pending.effectId, status: "blocked" };
  }
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
  if (process.env.NODE_ENV === "test") {
    const readyPath = process.env.CLI_EXAMPLE_TEST_AFTER_INTENT_READY_PATH;
    if (readyPath !== undefined) await writeFile(readyPath, "intent-written\n");
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
