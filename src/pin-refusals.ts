import { station } from "agent-cli-kernel";
import { TrialRefusal } from "../scripts/kernel-trial.ts";
import { cliCauses, pinCauseCode } from "./causes.ts";
import { CliError } from "./cli-error.ts";
import { KernelRefusal } from "./kernel-reader.ts";
import { PinRefusal } from "./pin-move.ts";
import { RepositoryPinRefusal } from "./pin-move-branch.ts";

export const pinVerifyIdentity = "bun-typescript-template.pin.verify" as const;
export const pinPlanIdentity = "bun-typescript-template.pin.plan" as const;
export const pinMoveIdentity = "bun-typescript-template.pin.move" as const;

export const pinNoChange = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

export const pinCauseDefaults = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
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

const pinRefusalDefinitions = {
  DOMAIN_PIN_PLACES_DISAGREE: {
    trigger:
      "kernel-pin.json, package.json, and bun.lock do not name the same kernel commit.",
    repair:
      "Edit package.json's agent-cli-kernel dependency to match kernel-pin.json's commit and run bun install (bun run pin:move writes both places once updated).",
  },
  DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE: {
    trigger:
      "The kernel commit is not reachable from the pin's branch on the pin's remote.",
    repair:
      "Give a commit that branch reaches on the pin's remote. Push the commit there first if it is only local.",
  },
  DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT: {
    trigger:
      "The kernel commit does not have the carry-out commit as an ancestor.",
    repair:
      "Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.",
  },
  DOMAIN_PIN_KERNEL_HISTORY_UNREADABLE: {
    trigger:
      "git could not check commit ancestry in the given kernel repository.",
    repair:
      "Give a full clone of the kernel repository that holds both commits: run git fetch --unshallow origin, or git fetch origin <branch>, there, then run this again.",
  },
  DOMAIN_PIN_KERNEL_BRANCH_UNREADABLE: {
    trigger: "The pin's branch could not be read from the pin's remote.",
    repair:
      "Check that the network reaches the pin's remote and that it serves the pin's branch, then run this again.",
  },
  DOMAIN_PIN_KERNEL_REPOSITORY_MISSING: {
    trigger: "No git repository was found at the kernel repository path.",
    repair:
      "Put a clone of the kernel repository at that path, or give the path of one that is there.",
  },
  DOMAIN_PIN_KERNEL_COMMIT_ABBREVIATED: {
    trigger: "The given commit is not a full 40-character lowercase hex SHA.",
    repair:
      "Give the commit's full identity, as `git rev-parse <commit>` prints it in the kernel repository.",
  },
  DOMAIN_PIN_KERNEL_COMMIT_MISSING: {
    trigger: "The given commit or one of its objects is absent from the clone.",
    repair:
      "Give a commit that clone holds with all its files. Fetch one with `git fetch origin <commit>`, and in a partial clone also run `git fetch --refetch --no-filter origin`. Then run this again.",
  },
  DOMAIN_PIN_KERNEL_OBJECT_FORMAT_UNSUPPORTED: {
    trigger: "The kernel repository does not use git's sha1 object format.",
    repair: "Give a kernel repository that uses git's sha1 object format.",
  },
  DOMAIN_PIN_KERNEL_DECLARATION_MISSING: {
    trigger:
      "The kernel commit holds no kernel declaration at the expected path.",
    repair:
      "Give a commit that holds the kernel declaration, or the path the kernel declaration has at that commit.",
  },
  DOMAIN_PIN_KERNEL_DECLARATION_INVALID: {
    trigger: "The kernel declaration in the given commit is not valid.",
    repair:
      "Correct the kernel declaration in the kernel repository, then give the commit that holds the correction.",
  },
  DOMAIN_PIN_KERNEL_ENTRY_UNSUPPORTED: {
    trigger: "A kernel root contains an unsupported git entry.",
    repair:
      "Make that entry a plain file with its own name in the kernel repository, then give the commit that holds the change.",
  },
  DOMAIN_PIN_TRIAL_FAILED: {
    trigger: "The kernel trial failed to install or pass its check command.",
    repair:
      "Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.",
  },
  DOMAIN_PIN_TRIAL_STOPPED: {
    trigger: "The kernel trial or repository pin move was stopped by a signal.",
    repair:
      "Nothing was written, and nothing is wrong with the kernel commit. Run the kernel trial, or the pin move, again when it can run to its end.",
  },
  DOMAIN_PIN_REPOSITORY_GIT_FAILED: {
    trigger: "A git command failed in the generated repository.",
    repair:
      "Fix the git failure reported in the message, then run bun run pin:move again.",
  },
  DOMAIN_PIN_REPOSITORY_DIRTY: {
    trigger: "The generated repository has uncommitted or untracked changes.",
    repair:
      "Commit or remove local changes in the repository so git status is clean, then run bun run pin:move again.",
  },
  DOMAIN_PIN_REPOSITORY_INVALID: {
    trigger: "The given path is not a valid generated git repository.",
    repair:
      "Give the root folder of a clean git checkout created from this template.",
  },
  DOMAIN_PIN_REPOSITORY_PIN_MISSING: {
    trigger:
      "The generated repository's package.json pins no valid kernel commit.",
    repair:
      'Set dependencies["agent-cli-kernel"] in package.json to a valid kernel pin and commit it before running bun run pin:move.',
  },
  DOMAIN_PIN_REPOSITORY_CHECK_FAILED: {
    trigger:
      "Installing, regenerating, or checking the generated repository failed.",
    repair:
      "Fix the failure reported by the step, then run bun run pin:move again.",
  },
  DOMAIN_PIN_REPOSITORY_BRANCH_EXISTS: {
    trigger: "The target pin-move branch already exists in the repository.",
    repair:
      "Inspect the existing branch: merge it if it holds the Pin move you want, or rename it, then run bun run pin:move again.",
  },
  DOMAIN_PIN_REPOSITORY_PIN_UNCHANGED: {
    trigger: "The generated repository already pins the given kernel commit.",
    repair: "Give a different kernel commit to move the pin.",
  },
  DOMAIN_PIN_CHANGESET_INVALID: {
    trigger: "A kernel or repository changeset could not be parsed.",
    repair:
      "Fix the malformed changeset reported in the message, then run this again.",
  },
  DOMAIN_PIN_CHANGESETS_UNREADABLE: {
    trigger: "Changesets could not be read from the repository.",
    repair:
      "Fix the unreadable changesets reported in the message, then run this again.",
  },
  DOMAIN_PIN_CHANGESET_CONFIG_INVALID: {
    trigger: "The repository's changeset configuration is invalid.",
    repair:
      "Fix the changeset configuration reported in the message, then run bun run pin:move again.",
  },
  DOMAIN_PIN_CHANGESET_PACKAGE_MISSING: {
    trigger: "The repository's package name is missing for changeset creation.",
    repair:
      "Fix the package manifest reported in the message, then run bun run pin:move again.",
  },
  DOMAIN_PIN_CHANGESET_ADD_FAILED: {
    trigger: "Adding the pin-move changeset failed.",
    repair:
      "Fix the changeset error reported in the message, then run bun run pin:move again.",
  },
  DOMAIN_PIN_CHANGESET_ADD_UNEXPECTED_FILES: {
    trigger: "Changeset creation produced unexpected files.",
    repair:
      "Inspect the unexpected files reported in the message, then run bun run pin:move again.",
  },
  DOMAIN_PIN_CHANGESET_PREDATES_SWITCHOVER: {
    trigger: "The commit range predates the changesets switchover.",
    repair:
      "Choose commits at or after the changesets switchover, then run this again.",
  },
} as const;

export type PinRefusalCause = keyof typeof pinRefusalDefinitions;

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
] as const;

export const moveRefusalCauses = [
  ...planRefusalCauses,
  "DOMAIN_PIN_TRIAL_FAILED",
  "DOMAIN_PIN_TRIAL_STOPPED",
  "DOMAIN_PIN_REPOSITORY_DIRTY",
  "DOMAIN_PIN_REPOSITORY_CHECK_FAILED",
  "DOMAIN_PIN_REPOSITORY_BRANCH_EXISTS",
  "DOMAIN_PIN_REPOSITORY_PIN_UNCHANGED",
  "DOMAIN_PIN_CHANGESET_ADD_FAILED",
  "DOMAIN_PIN_CHANGESET_ADD_UNEXPECTED_FILES",
] as const;

function refusalFields<const Identity extends string>(
  identity: Identity,
  causeCode: PinRefusalCause,
) {
  const def = pinRefusalDefinitions[causeCode];
  return {
    ...pinCauseDefaults,
    commandIdentity: identity,
    trigger: def.trigger,
    repairAction: def.repair,
    guidance: { next: { kind: "instruction", text: def.repair } },
    independentObservable: `${identity}:${causeCode.toLowerCase()}`,
  } as const;
}

export function verifyRefusalRows<const Identity extends string>(
  identity: Identity,
) {
  return [
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_PLACES_DISAGREE"),
      causeCode: "DOMAIN_PIN_PLACES_DISAGREE",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE"),
      causeCode: "DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT"),
      causeCode: "DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_HISTORY_UNREADABLE"),
      causeCode: "DOMAIN_PIN_KERNEL_HISTORY_UNREADABLE",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_BRANCH_UNREADABLE"),
      causeCode: "DOMAIN_PIN_KERNEL_BRANCH_UNREADABLE",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_REPOSITORY_MISSING"),
      causeCode: "DOMAIN_PIN_KERNEL_REPOSITORY_MISSING",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_COMMIT_ABBREVIATED"),
      causeCode: "DOMAIN_PIN_KERNEL_COMMIT_ABBREVIATED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_COMMIT_MISSING"),
      causeCode: "DOMAIN_PIN_KERNEL_COMMIT_MISSING",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_OBJECT_FORMAT_UNSUPPORTED"),
      causeCode: "DOMAIN_PIN_KERNEL_OBJECT_FORMAT_UNSUPPORTED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_DECLARATION_MISSING"),
      causeCode: "DOMAIN_PIN_KERNEL_DECLARATION_MISSING",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_DECLARATION_INVALID"),
      causeCode: "DOMAIN_PIN_KERNEL_DECLARATION_INVALID",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_KERNEL_ENTRY_UNSUPPORTED"),
      causeCode: "DOMAIN_PIN_KERNEL_ENTRY_UNSUPPORTED",
    }),
  ] as const;
}

export function planRefusalRows<const Identity extends string>(
  identity: Identity,
) {
  return [
    ...verifyRefusalRows(identity),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_GIT_FAILED"),
      causeCode: "DOMAIN_PIN_REPOSITORY_GIT_FAILED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_INVALID"),
      causeCode: "DOMAIN_PIN_REPOSITORY_INVALID",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_PIN_MISSING"),
      causeCode: "DOMAIN_PIN_REPOSITORY_PIN_MISSING",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESET_INVALID"),
      causeCode: "DOMAIN_PIN_CHANGESET_INVALID",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESETS_UNREADABLE"),
      causeCode: "DOMAIN_PIN_CHANGESETS_UNREADABLE",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESET_CONFIG_INVALID"),
      causeCode: "DOMAIN_PIN_CHANGESET_CONFIG_INVALID",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESET_PACKAGE_MISSING"),
      causeCode: "DOMAIN_PIN_CHANGESET_PACKAGE_MISSING",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESET_PREDATES_SWITCHOVER"),
      causeCode: "DOMAIN_PIN_CHANGESET_PREDATES_SWITCHOVER",
    }),
  ] as const;
}

export function moveRefusalRows<const Identity extends string>(
  identity: Identity,
) {
  return [
    ...planRefusalRows(identity),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_TRIAL_FAILED"),
      causeCode: "DOMAIN_PIN_TRIAL_FAILED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_TRIAL_STOPPED"),
      causeCode: "DOMAIN_PIN_TRIAL_STOPPED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_DIRTY"),
      causeCode: "DOMAIN_PIN_REPOSITORY_DIRTY",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_CHECK_FAILED"),
      causeCode: "DOMAIN_PIN_REPOSITORY_CHECK_FAILED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_BRANCH_EXISTS"),
      causeCode: "DOMAIN_PIN_REPOSITORY_BRANCH_EXISTS",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_REPOSITORY_PIN_UNCHANGED"),
      causeCode: "DOMAIN_PIN_REPOSITORY_PIN_UNCHANGED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESET_ADD_FAILED"),
      causeCode: "DOMAIN_PIN_CHANGESET_ADD_FAILED",
    }),
    station(cliCauses, {
      ...refusalFields(identity, "DOMAIN_PIN_CHANGESET_ADD_UNEXPECTED_FILES"),
      causeCode: "DOMAIN_PIN_CHANGESET_ADD_UNEXPECTED_FILES",
    }),
  ] as const;
}

const inspectPinState = {
  owner: "operator",
  reason: "Inspect the repository and pin state before retrying pin move.",
  inspect: [
    {
      kind: "instruction",
      text: "Run bun run pin:verify and check git status.",
    },
  ],
} as const;

export function moveStateRows() {
  return [
    station(cliCauses, {
      ...pinCauseDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_HELD",
      trigger: "Another pin move process is changing this target now.",
      repairAction: "Wait for that pin move to finish, then try again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:held`,
    }),
    station(cliCauses, {
      ...pinCauseDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_UNRESOLVED",
      trigger: "An earlier pin move on this target never finished.",
      repairAction:
        "Run bun run pin:verify and inspect git status before trying again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:unresolved`,
    }),
    station(cliCauses, {
      ...pinCauseDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_STATE_UNAVAILABLE",
      trigger: "The front door state folder cannot accept this change.",
      repairAction:
        "Check permissions on the XDG_STATE_HOME state folder, then run bun run pin:move again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:state-unavailable`,
    }),
    station(cliCauses, {
      ...pinCauseDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_FAILED_UNCHANGED",
      trigger: "The pin move failed before changing any tracked pin file.",
      repairAction:
        "Fix the failure reported in the message, then run bun run pin:move again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:failed-unchanged`,
    }),
    station(cliCauses, {
      ...pinCauseDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_FAILED_PARTIAL",
      trigger: "The pin move failed after partial writes.",
      repairAction:
        "Inspect git status and run bun run pin:verify before retrying.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:failed-partial`,
    }),
    station(cliCauses, {
      ...pinCauseDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_FAILED_UNKNOWN",
      trigger: "The pin move could not confirm whether its writes completed.",
      repairAction:
        "Inspect git status and run bun run pin:verify before retrying.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:failed-unknown`,
    }),
  ] as const;
}

export function classifyRefusal<const Code extends PinRefusalCause>(
  error: unknown,
  allowed: readonly Code[],
): { readonly causeCode: Code; readonly message: string } | undefined {
  if (
    error instanceof PinRefusal ||
    error instanceof KernelRefusal ||
    error instanceof TrialRefusal ||
    error instanceof RepositoryPinRefusal
  ) {
    const mapped = pinCauseCode(error.code);
    const match = allowed.find((code) => code === mapped);
    if (match !== undefined) {
      return {
        causeCode: match,
        message: error.message,
      };
    }
  }
  if (error instanceof CliError) {
    const mapped = pinCauseCode(error.code);
    const match = allowed.find((code) => code === mapped);
    if (match !== undefined) {
      return {
        causeCode: match,
        message: `${error.message} Repair: ${error.repair}`,
      };
    }
  }
  return undefined;
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
):
  | "DOMAIN_PIN_MOVE_FAILED_UNCHANGED"
  | "DOMAIN_PIN_MOVE_FAILED_PARTIAL"
  | "DOMAIN_PIN_MOVE_FAILED_UNKNOWN" {
  if (transactionState === "unchanged")
    return "DOMAIN_PIN_MOVE_FAILED_UNCHANGED";
  if (transactionState === "partially-completed")
    return "DOMAIN_PIN_MOVE_FAILED_PARTIAL";
  return "DOMAIN_PIN_MOVE_FAILED_UNKNOWN";
}
