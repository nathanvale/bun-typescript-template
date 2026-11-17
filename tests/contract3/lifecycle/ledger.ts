import { appendFileSync } from "node:fs";

export const ledgerPath = process.env.FX_LEDGER;

export function ledger(line: string): void {
  if (ledgerPath) appendFileSync(ledgerPath, `${line}\n`);
}

export function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
