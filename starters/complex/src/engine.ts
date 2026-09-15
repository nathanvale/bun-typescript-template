import { SetInput } from "./command-contract.ts";
import type { OperationResult } from "./model.ts";

function emptyEffects() {
  return {
    completed: [],
    inventoryComplete: true,
    remaining: [],
    uncertain: [],
  };
}

export function validateSetInput(value: string, preview: boolean) {
  return SetInput.safeParse({ preview, value });
}

export function inspected(value: string | null): OperationResult {
  return {
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "example.status",
    data: { value },
    effectClass: "inspect",
    effects: emptyEffects(),
    exitCode: 0,
    failureClass: null,
    message: "State inspected.",
    outcome: "success",
    repairAction: null,
    retryable: false,
    transactionState: "unchanged",
  };
}

export function previewed(value: string): OperationResult {
  return {
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "example.set",
    data: { preview: true, value },
    effectClass: "repository-local",
    effects: emptyEffects(),
    exitCode: 0,
    failureClass: null,
    message: "Change previewed.",
    outcome: "success",
    repairAction: null,
    retryable: false,
    transactionState: "unchanged",
  };
}

export function completed(value: string, effectId: string): OperationResult {
  return {
    causeCode: "SUCCESS_COMPLETED",
    commandIdentity: "example.set",
    data: { preview: false, value },
    effectClass: "repository-local",
    effects: {
      completed: [effectId],
      inventoryComplete: true,
      remaining: [],
      uncertain: [],
    },
    exitCode: 0,
    failureClass: null,
    message: "State updated.",
    outcome: "success",
    repairAction: null,
    retryable: false,
    transactionState: "completed",
  };
}

export function invalidInput(message: string): OperationResult {
  return {
    causeCode: "SCHEMA_INVALID_INPUT",
    commandIdentity: "example.set",
    data: null,
    effectClass: "repository-local",
    effects: emptyEffects(),
    exitCode: 4,
    failureClass: "schema",
    message,
    nextAction: "Pass a nonempty value of at most 128 characters.",
    outcome: "refused",
    repairAction: "Repair the input and retry.",
    retryable: false,
    transactionState: "unchanged",
  };
}
