import type { EffectClass, Outcome, TransactionState } from "./model.ts";

export interface Station {
  causeCode: string;
  commandIdentity: string;
  effectClass: EffectClass;
  exitCode: number;
  failureClass: "internal" | "schema" | "usage" | null;
  guidance: { nextAction: string };
  outcome: Outcome;
  reachability: "required";
  repairAction: string | null;
  retryable: false;
  retryDelayPolicy: { kind: "none" };
  transactionState: TransactionState;
  trigger: string;
  unreachableRationale: null;
}

export const STATIONS: Station[] = [
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
];

export function stationsFor(commandIdentity: string): Station[] {
  return STATIONS.filter(
    (station) => station.commandIdentity === commandIdentity,
  );
}
