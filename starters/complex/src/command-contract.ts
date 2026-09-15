import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { OperationResult } from "./model.ts";

export const SetInput = z.strictObject({
  preview: z.boolean(),
  value: z.string().trim().min(1).max(128),
});

export const StateDocument = z.strictObject({
  value: z.string(),
});

export function envelope(result: OperationResult) {
  return {
    availablePaths: [
      "example.command-discovery",
      "example.discovery",
      "example.help",
      "example.set",
      "example.status",
    ],
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    message: result.message,
    result: {
      causeCode: result.causeCode,
      commandIdentity: result.commandIdentity,
      data: result.data,
      effectClass: result.effectClass,
      effects: result.effects,
      exitCode: result.exitCode,
      failureClass: result.failureClass,
      nextAction: result.nextAction ?? "No follow-up is required.",
      outcome: result.outcome,
      repairAction: result.repairAction,
      retryable: result.retryable,
      runId: randomUUID(),
      transactionState: result.transactionState,
    },
  };
}
