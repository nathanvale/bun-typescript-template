import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";

const JournalRecordSchema = z.strictObject({
  effectId: z.string().min(1),
  expectedValueHash: z.string().regex(/^[0-9a-f]{64}$/),
  journalVersion: z.literal(1),
  phase: z.enum(["intent", "completed"]),
  runId: z.string().min(1),
});

export type JournalRecord = z.infer<typeof JournalRecordSchema>;

function journalPath(statePath: string): string {
  return `${statePath}.journal.jsonl`;
}

export function valueHash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function appendJournal(
  statePath: string,
  record: JournalRecord,
): Promise<void> {
  const parsed = JournalRecordSchema.parse(record);
  const path = journalPath(statePath);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(parsed)}\n`, { encoding: "utf8" });
}

async function readJournal(statePath: string): Promise<JournalRecord[]> {
  let text: string;
  try {
    text = await readFile(journalPath(statePath), "utf8");
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JournalRecordSchema.parse(JSON.parse(line)));
}

export async function pendingJournalIntent(
  statePath: string,
): Promise<JournalRecord | null> {
  const records = await readJournal(statePath);
  const completed = new Set(
    records
      .filter((record) => record.phase === "completed")
      .map((record) => `${record.runId}:${record.effectId}`),
  );
  return (
    records.findLast(
      (record) =>
        record.phase === "intent" &&
        !completed.has(`${record.runId}:${record.effectId}`),
    ) ?? null
  );
}
