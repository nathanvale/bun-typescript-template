import type { EffectClass, Outcome, TransactionState } from "./model.ts";

export interface Station {
  causeCode: string;
  commandIdentity: string;
  effectClass: EffectClass;
  exitCode: number;
  failureClass: "domain" | "internal" | "schema" | "usage" | null;
  guidance:
    | { handoff: { owner: string; summary: string } }
    | { nextAction: string };
  outcome: Outcome;
  reachability: "required";
  repairAction: string | null;
  retryable: false;
  retryDelayPolicy: { kind: "none" };
  transactionState: TransactionState;
  trigger: string;
  unreachableRationale: null;
}

const STATIONS: Station[] = [
  {
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "example.status",
    effectClass: "inspect",
    exitCode: 0,
    failureClass: null,
    guidance: { nextAction: "No follow-up is required." },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "The current state is inspected.",
    unreachableRationale: null,
  },
  {
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    commandIdentity: "example.status",
    effectClass: "inspect",
    exitCode: 1,
    failureClass: "internal",
    guidance: {
      handoff: {
        owner: "operator",
        summary:
          "Inspect or repair the persisted state before another status run.",
      },
    },
    outcome: "failed",
    reachability: "required",
    repairAction: "Inspect or repair the persisted state schema.",
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "The persisted state does not match its schema.",
    unreachableRationale: null,
  },
  {
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "example.recover",
    effectClass: "inspect",
    exitCode: 0,
    failureClass: null,
    guidance: { nextAction: "No follow-up is required." },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "No journal intent is pending.",
    unreachableRationale: null,
  },
  {
    causeCode: "SUCCESS_COMPLETED",
    commandIdentity: "example.recover",
    effectClass: "inspect",
    exitCode: 0,
    failureClass: null,
    guidance: { nextAction: "Do not replay the completed effect." },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "completed",
    trigger: "A pending journal intent matches the observed state.",
    unreachableRationale: null,
  },
  {
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    commandIdentity: "example.recover",
    effectClass: "inspect",
    exitCode: 1,
    failureClass: "internal",
    guidance: {
      nextAction: "Inspect the state and journal, then hand off if unresolved.",
    },
    outcome: "failed",
    reachability: "required",
    repairAction: "Resolve the uncertain effect without replaying it.",
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unknown",
    trigger: "A pending journal intent cannot be reconciled to current state.",
    unreachableRationale: null,
  },
  {
    causeCode: "SUCCESS_UNCHANGED",
    commandIdentity: "example.set",
    effectClass: "repository-local",
    exitCode: 0,
    failureClass: null,
    guidance: {
      nextAction: "Apply without --preview when the proposed value is correct.",
    },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "A valid change is previewed.",
    unreachableRationale: null,
  },
  {
    causeCode: "SUCCESS_COMPLETED",
    commandIdentity: "example.set",
    effectClass: "repository-local",
    exitCode: 0,
    failureClass: null,
    guidance: { nextAction: "No follow-up is required." },
    outcome: "success",
    reachability: "required",
    repairAction: null,
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "completed",
    trigger: "A valid value is written and confirmed.",
    unreachableRationale: null,
  },
  {
    causeCode: "SCHEMA_INVALID_INPUT",
    commandIdentity: "example.set",
    effectClass: "repository-local",
    exitCode: 4,
    failureClass: "schema",
    guidance: {
      nextAction: "Pass a nonempty value of at most 128 characters.",
    },
    outcome: "refused",
    reachability: "required",
    repairAction: "Repair the input and retry.",
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unchanged",
    trigger: "The value is empty or longer than 128 characters.",
    unreachableRationale: null,
  },
  {
    causeCode: "DOMAIN_PRIOR_RUN_PENDING",
    commandIdentity: "example.set",
    effectClass: "repository-local",
    exitCode: 3,
    failureClass: "domain",
    guidance: {
      nextAction:
        "Run recover and inspect the pending effect before another set.",
    },
    outcome: "failed",
    reachability: "required",
    repairAction: "Inspect recovery state; do not replay the prior set.",
    retryable: false,
    retryDelayPolicy: { kind: "none" },
    transactionState: "unknown",
    trigger: "A prior set has an unresolved journal intent.",
    unreachableRationale: null,
  },
];

export function stationsFor(commandIdentity: string): Station[] {
  return STATIONS.filter(
    (station) => station.commandIdentity === commandIdentity,
  );
}
