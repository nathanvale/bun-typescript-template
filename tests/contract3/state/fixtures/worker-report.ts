import { renameSync, writeFileSync } from "node:fs";

export function writeWorkerReport(
  report: string,
  value: Readonly<Record<string, unknown>>,
): void {
  const staged = `${report}.tmp`;
  writeFileSync(staged, JSON.stringify({ pid: process.pid, ...value }));
  renameSync(staged, report);
}

export function stayAlive(): void {
  setInterval(() => {}, 1_000_000);
}
