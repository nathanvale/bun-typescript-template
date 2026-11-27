import { TrialRefusal } from "../scripts/kernel-trial.ts";
import { pinCauseCode } from "./causes.ts";
import { CliError } from "./cli-error.ts";
import { KernelRefusal } from "./kernel-reader.ts";
import { PinRefusal } from "./pin-move.ts";
import { RepositoryPinRefusal } from "./pin-move-branch.ts";
import {
  type PinRefusalCause,
  pinRefusalDefinitions,
} from "./pin-refusal-rows.ts";

export {
  moveRefusalRows,
  moveStateRows,
  pinCauseDefaults,
  pinMoveIdentity,
  pinPlanIdentity,
  type PinRefusalCause,
  pinVerifyIdentity,
  planRefusalRows,
  verifyRefusalRows,
} from "./pin-refusal-rows.ts";

export const pinNoChange = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const pinPathValue = {
  kind: "string",
  minLength: 1,
  maxLength: 4096,
  choices: null,
  pattern: null,
} as const;

export const commitArgument = {
  name: "commit",
  summary: "Full 40-character kernel commit identity.",
  required: true,
  value: {
    kind: "string",
    minLength: 1,
    maxLength: 128,
    choices: null,
    pattern: null,
  },
} as const;

export const kernelOption = {
  name: "--kernel",
  aliases: [],
  summary:
    "Path to the kernel repository clone. Defaults to the sibling clone beside the template.",
  required: false,
  repeatable: false,
  value: pinPathValue,
} as const;

export const verifyRefusalCauses = [
  "DOMAIN_PIN_PLACES_DISAGREE",
  "DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE",
  "DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT",
  "DOMAIN_PIN_KERNEL_HISTORY_UNREADABLE",
  "DOMAIN_PIN_KERNEL_BRANCH_UNREADABLE",
  "DOMAIN_PIN_KERNEL_REPOSITORY_MISSING",
  "DOMAIN_PIN_KERNEL_COMMIT_ABBREVIATED",
  "DOMAIN_PIN_KERNEL_COMMIT_MISSING",
  "DOMAIN_PIN_KERNEL_OBJECT_FORMAT_UNSUPPORTED",
  "DOMAIN_PIN_KERNEL_DECLARATION_MISSING",
  "DOMAIN_PIN_KERNEL_DECLARATION_INVALID",
  "DOMAIN_PIN_KERNEL_ENTRY_UNSUPPORTED",
] as const;

export const planRefusalCauses = [
  ...verifyRefusalCauses,
  "DOMAIN_PIN_REPOSITORY_GIT_FAILED",
  "DOMAIN_PIN_REPOSITORY_INVALID",
  "DOMAIN_PIN_REPOSITORY_PIN_MISSING",
  "DOMAIN_PIN_CHANGESET_INVALID",
  "DOMAIN_PIN_CHANGESETS_UNREADABLE",
  "DOMAIN_PIN_CHANGESET_CONFIG_INVALID",
  "DOMAIN_PIN_CHANGESET_PACKAGE_MISSING",
  "DOMAIN_PIN_CHANGESET_PREDATES_SWITCHOVER",
  "DOMAIN_PIN_SYMLINK_ANCESTOR",
  "DOMAIN_PIN_INVALID_UTF8",
  "DOMAIN_PIN_UNREADABLE_FILE",
  "DOMAIN_PIN_WORKTREE_STATUS_FAILED",
] as const;

const movePreWriteRefusalCauses = [
  ...planRefusalCauses,
  "DOMAIN_PIN_TRIAL_FAILED",
  "DOMAIN_PIN_TRIAL_STOPPED",
  "DOMAIN_PIN_REPOSITORY_DIRTY",
  "DOMAIN_PIN_REPOSITORY_BRANCH_EXISTS",
  "DOMAIN_PIN_REPOSITORY_PIN_UNCHANGED",
] as const;

const moveRestoredFailureCauses = [
  "DOMAIN_PIN_REPOSITORY_CHECK_FAILED",
  "DOMAIN_PIN_CHANGESET_ADD_FAILED",
  "DOMAIN_PIN_CHANGESET_ADD_UNEXPECTED_FILES",
] as const;

export type PreWriteMoveRefusalCause =
  (typeof movePreWriteRefusalCauses)[number];

export type RestoredMoveFailureCause =
  | (typeof moveRestoredFailureCauses)[number]
  | "DOMAIN_PIN_MOVE_FAILED_RESTORED";

export type MoveStateFailureCause =
  | "DOMAIN_PIN_MOVE_FAILED_UNCHANGED"
  | "DOMAIN_PIN_MOVE_FAILED_PARTIAL"
  | "DOMAIN_PIN_MOVE_FAILED_UNKNOWN";

export type MoveFailureState =
  | "before-write"
  | "restored"
  | "unchanged"
  | "partially-completed"
  | "unknown";

function isPinRefusalError(
  error: unknown,
): error is PinRefusal | KernelRefusal | TrialRefusal | RepositoryPinRefusal {
  return (
    error instanceof PinRefusal ||
    error instanceof KernelRefusal ||
    error instanceof TrialRefusal ||
    error instanceof RepositoryPinRefusal
  );
}

function refusalCodeAndMessage(
  error: unknown,
):
  | { readonly causeCode: PinRefusalCause; readonly message: string }
  | undefined {
  const raw = isPinRefusalError(error)
    ? { code: error.code, message: error.message }
    : error instanceof CliError
      ? {
          code: error.code,
          message: `${error.message} Repair: ${error.repair}`,
        }
      : undefined;
  if (raw === undefined) return undefined;
  const mapped = pinCauseCode(raw.code);
  if (mapped === undefined || !Object.hasOwn(pinRefusalDefinitions, mapped)) {
    return undefined;
  }
  return {
    causeCode: mapped as PinRefusalCause,
    message: raw.message,
  };
}

export function classifyRefusal<const Code extends PinRefusalCause>(
  error: unknown,
  allowed: readonly Code[],
): { readonly causeCode: Code; readonly message: string } | undefined {
  const parsed = refusalCodeAndMessage(error);
  if (parsed === undefined) return undefined;
  const match = allowed.find((code) => code === parsed.causeCode);
  if (match === undefined) return undefined;
  return { causeCode: match, message: parsed.message };
}

export function classifyMoveRefusal(
  error: unknown,
  state: "before-write",
):
  | { readonly causeCode: PreWriteMoveRefusalCause; readonly message: string }
  | undefined;
export function classifyMoveRefusal(
  error: unknown,
  state: "restored",
):
  | { readonly causeCode: RestoredMoveFailureCause; readonly message: string }
  | undefined;
export function classifyMoveRefusal(
  error: unknown,
  state: "unchanged" | "partially-completed" | "unknown",
):
  | {
      readonly causeCode: MoveStateFailureCause;
      readonly message: string;
    }
  | undefined;
export function classifyMoveRefusal(
  error: unknown,
  state: MoveFailureState,
):
  | {
      readonly causeCode:
        | PreWriteMoveRefusalCause
        | RestoredMoveFailureCause
        | MoveStateFailureCause;
      readonly message: string;
    }
  | undefined;
export function classifyMoveRefusal(
  error: unknown,
  state: MoveFailureState,
):
  | {
      readonly causeCode:
        | PreWriteMoveRefusalCause
        | RestoredMoveFailureCause
        | MoveStateFailureCause;
      readonly message: string;
    }
  | undefined {
  const parsed = refusalCodeAndMessage(error);
  if (parsed === undefined) return undefined;
  if (state === "before-write") {
    const match = movePreWriteRefusalCauses.find(
      (code) => code === parsed.causeCode,
    );
    return match === undefined
      ? undefined
      : { causeCode: match, message: parsed.message };
  }
  if (state === "restored") {
    const match = moveRestoredFailureCauses.find(
      (code) => code === parsed.causeCode,
    );
    return {
      causeCode: match ?? "DOMAIN_PIN_MOVE_FAILED_RESTORED",
      message: parsed.message,
    };
  }
  return {
    causeCode: moveFailedCause(state),
    message: parsed.message,
  };
}

export function stateRefusalCause(
  kind: string,
):
  | "DOMAIN_PIN_MOVE_HELD"
  | "DOMAIN_PIN_MOVE_UNRESOLVED"
  | "DOMAIN_PIN_STATE_UNAVAILABLE" {
  if (kind === "held-lock") return "DOMAIN_PIN_MOVE_HELD";
  if (kind === "unresolved-case") return "DOMAIN_PIN_MOVE_UNRESOLVED";
  return "DOMAIN_PIN_STATE_UNAVAILABLE";
}

export function moveFailedCause(
  transactionState: string,
): MoveStateFailureCause {
  if (transactionState === "unchanged")
    return "DOMAIN_PIN_MOVE_FAILED_UNCHANGED";
  if (transactionState === "partially-completed")
    return "DOMAIN_PIN_MOVE_FAILED_PARTIAL";
  return "DOMAIN_PIN_MOVE_FAILED_UNKNOWN";
}
