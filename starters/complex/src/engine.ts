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

export function priorRunPending(effectId: string): OperationResult {
  return {
    causeCode: "DOMAIN_PRIOR_RUN_PENDING",
    commandIdentity: "example.set",
    data: { pendingEffect: effectId },
    effectClass: "repository-local",
    effects: {
      completed: [],
      inventoryComplete: true,
      remaining: [],
      uncertain: [effectId],
    },
    exitCode: 3,
    failureClass: "domain",
    handoff: {
      owner: "operator",
      summary: "Run recover and inspect the pending effect before another set.",
    },
    message: "A prior set may still have effects.",
    outcome: "refused",
    repairAction: "Inspect recovery state; do not replay the prior set.",
    retryable: false,
    transactionState: "unchanged",
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

export function recovered(
  observation:
    | { effectId: null; state: "none" }
    | { effectId: string; state: "completed" | "unknown" },
): OperationResult {
  if (observation.state === "unknown") {
    return {
      causeCode: "INTERNAL_RESULT_UNKNOWN",
      commandIdentity: "example.recover",
      data: null,
      effectClass: "inspect",
      effects: {
        completed: [],
        inventoryComplete: true,
        remaining: [],
        uncertain: [observation.effectId],
      },
      exitCode: 1,
      failureClass: "internal",
      handoff: {
        owner: "operator",
        summary:
          "Inspect the state and journal before choosing another action.",
      },
      message: "Recovery could not establish the pending effect.",
      outcome: "failed",
      repairAction: "Resolve the uncertain effect without replaying it.",
      retryable: false,
      transactionState: "unknown",
    };
  }
  const completedEffects =
    observation.state === "completed" ? [observation.effectId] : [];
  return {
    causeCode:
      observation.state === "completed"
        ? "SUCCESS_COMPLETED"
        : "SUCCESS_UNCHANGED",
    commandIdentity: "example.recover",
    data: { pendingEffect: observation.effectId },
    effectClass: "inspect",
    effects: {
      completed: completedEffects,
      inventoryComplete: true,
      remaining: [],
      uncertain: [],
    },
    exitCode: 0,
    failureClass: null,
    message:
      observation.state === "completed"
        ? "The pending effect is already present; it was not replayed."
        : "No pending effect requires recovery.",
    outcome: "success",
    repairAction: null,
    retryable: false,
    transactionState:
      observation.state === "completed" ? "completed" : "unchanged",
  };
}
