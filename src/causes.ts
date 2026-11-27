import { commonCauses } from "agent-cli-kernel";
import type { CauseTable } from "agent-cli-kernel";

const refusedNext = {
  outcome: "refused",
  transactionState: "unchanged",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "next",
} as const;

const refusedHandoff = { ...refusedNext, guidance: "handoff" } as const;

const failedCompleted = {
  outcome: "failed",
  transactionState: "completed",
  failureClass: "domain",
  exitCode: 3,
  retryable: false,
  guidance: "handoff",
} as const;

const doctorCauses = {
  DOMAIN_DOCTOR_CHECK_FAILED: {
    ...refusedNext,
    carriesData: true,
  },
} as const satisfies CauseTable;

export const pinCauses = {
  DOMAIN_PIN_PLACES_DISAGREE: refusedNext,
  DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE: refusedNext,
  DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT: refusedNext,
  DOMAIN_PIN_KERNEL_HISTORY_UNREADABLE: refusedNext,
  DOMAIN_PIN_KERNEL_BRANCH_UNREADABLE: refusedNext,
  DOMAIN_PIN_KERNEL_REPOSITORY_MISSING: refusedNext,
  DOMAIN_PIN_KERNEL_COMMIT_ABBREVIATED: refusedNext,
  DOMAIN_PIN_KERNEL_COMMIT_MISSING: refusedNext,
  DOMAIN_PIN_KERNEL_OBJECT_FORMAT_UNSUPPORTED: refusedNext,
  DOMAIN_PIN_KERNEL_DECLARATION_MISSING: refusedNext,
  DOMAIN_PIN_KERNEL_DECLARATION_INVALID: refusedNext,
  DOMAIN_PIN_KERNEL_ENTRY_UNSUPPORTED: refusedNext,
  DOMAIN_PIN_TRIAL_FAILED: refusedNext,
  DOMAIN_PIN_TRIAL_STOPPED: refusedNext,
  DOMAIN_PIN_REPOSITORY_GIT_FAILED: refusedNext,
  DOMAIN_PIN_REPOSITORY_DIRTY: refusedNext,
  DOMAIN_PIN_REPOSITORY_INVALID: refusedNext,
  DOMAIN_PIN_REPOSITORY_PIN_MISSING: refusedNext,
  DOMAIN_PIN_REPOSITORY_CHECK_FAILED: failedCompleted,
  DOMAIN_PIN_REPOSITORY_BRANCH_EXISTS: refusedNext,
  DOMAIN_PIN_REPOSITORY_PIN_UNCHANGED: refusedNext,
  DOMAIN_PIN_CHANGESET_INVALID: refusedNext,
  DOMAIN_PIN_CHANGESETS_UNREADABLE: refusedNext,
  DOMAIN_PIN_CHANGESET_CONFIG_INVALID: refusedNext,
  DOMAIN_PIN_CHANGESET_PACKAGE_MISSING: refusedNext,
  DOMAIN_PIN_CHANGESET_ADD_FAILED: failedCompleted,
  DOMAIN_PIN_CHANGESET_ADD_UNEXPECTED_FILES: failedCompleted,
  DOMAIN_PIN_CHANGESET_PREDATES_SWITCHOVER: refusedNext,
  DOMAIN_PIN_SYMLINK_ANCESTOR: refusedNext,
  DOMAIN_PIN_INVALID_UTF8: refusedNext,
  DOMAIN_PIN_UNREADABLE_FILE: refusedNext,
  DOMAIN_PIN_WORKTREE_STATUS_FAILED: refusedNext,
  DOMAIN_PIN_MOVE_HELD: refusedHandoff,
  DOMAIN_PIN_MOVE_UNRESOLVED: refusedHandoff,
  DOMAIN_PIN_STATE_UNAVAILABLE: refusedHandoff,
  DOMAIN_PIN_MOVE_FAILED_RESTORED: failedCompleted,
  DOMAIN_PIN_MOVE_FAILED_UNCHANGED: {
    outcome: "failed",
    transactionState: "unchanged",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_PIN_MOVE_FAILED_PARTIAL: {
    outcome: "failed",
    transactionState: "partially-completed",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
  DOMAIN_PIN_MOVE_FAILED_UNKNOWN: {
    outcome: "failed",
    transactionState: "unknown",
    failureClass: "domain",
    exitCode: 3,
    retryable: false,
    guidance: "handoff",
  },
} as const satisfies CauseTable;

export type PinCauseCode = keyof typeof pinCauses;

export const cliCauses = {
  ...commonCauses,
  ...doctorCauses,
  ...pinCauses,
} as const satisfies CauseTable;

export function pinCauseCode(rawCode: string): PinCauseCode | undefined {
  const normalized = rawCode.replace(/^pin_/, "").toUpperCase();
  const candidate = `DOMAIN_PIN_${normalized}`;
  return Object.hasOwn(pinCauses, candidate)
    ? (candidate as PinCauseCode)
    : undefined;
}
