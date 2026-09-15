export type EffectClass = "inspect" | "repository-local";
export type Outcome = "failed" | "refused" | "success";
export type TransactionState = "completed" | "unchanged" | "unknown";

export interface OperationResult {
  causeCode: string;
  commandIdentity: string;
  data: unknown;
  effectClass: EffectClass;
  effects: {
    completed: string[];
    inventoryComplete: boolean;
    remaining: string[];
    uncertain: string[];
  };
  exitCode: 0 | 1 | 2 | 3 | 4;
  failureClass: "domain" | "internal" | "schema" | "usage" | null;
  handoff?: { owner: string; summary: string };
  message: string;
  nextAction?: string;
  outcome: Outcome;
  repairAction: string | null;
  retryable: false;
  transactionState: TransactionState;
}
