import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { changing, command, station } from "agent-cli-kernel";
import type { stateAddon } from "agent-cli-kernel/addons/state";
import {
  kernelTrial,
  type TrialActive,
  TrialRefusal,
} from "../scripts/kernel-trial.ts";
import { pinMoveReportText } from "../scripts/pin-move-report.ts";
import { cliCauses, pinCauseCode } from "./causes.ts";
import { CliError } from "./cli-error.ts";
import { readKernelPin, siblingKernelPath } from "./kernel-pin.ts";
import { KernelRefusal } from "./kernel-reader.ts";
import {
  movePin,
  pinBranchCommitHeld,
  PinRefusal,
  verifyPin,
  withStopSignals,
} from "./pin-move.ts";
import { RepositoryPinRefusal } from "./pin-move-branch.ts";
import { moveRepositoryPin } from "./pin-move-repository.ts";
import { verifyKernelPin } from "./pin-verification.ts";

export type FrontDoorState = ReturnType<typeof stateAddon>;

export const pinVerifyIdentity = "bun-typescript-template.pin.verify" as const;
export const pinPlanIdentity = "bun-typescript-template.pin.plan" as const;
export const pinMoveIdentity = "bun-typescript-template.pin.move" as const;

const noEffects = {
  completed: [],
  remaining: [],
  uncertain: [],
  inventoryComplete: true,
} as const;

const stationDefaults = {
  retryDelayPolicy: { kind: "none" },
  reachability: "required",
  unreachableRationale: null,
} as const;

const stringPathValue = {
  kind: "string",
  minLength: 1,
  maxLength: 4096,
  choices: null,
  pattern: null,
} as const;

const commitArgument = {
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

const kernelOption = {
  name: "--kernel",
  aliases: [],
  summary:
    "Path to the kernel repository clone. Defaults to the sibling clone beside the template.",
  required: false,
  repeatable: false,
  value: stringPathValue,
} as const;

const optionalRepositoryOption = {
  name: "--repository",
  aliases: [],
  summary:
    "Path to a generated repository checkout. Omit to move the template's own pin.",
  required: false,
  repeatable: false,
  value: stringPathValue,
} as const;

const requiredRepositoryOption = {
  name: "--repository",
  aliases: [],
  summary: "Path to a generated repository checkout.",
  required: true,
  repeatable: false,
  value: stringPathValue,
} as const;

export function frontDoorStateRoot(
  environment: Readonly<Record<string, string | undefined>>,
): string {
  const xdg = environment.XDG_STATE_HOME;
  const base =
    xdg !== undefined && isAbsolute(xdg)
      ? xdg
      : join(environment.HOME ?? homedir(), ".local", "state");
  return join(base, "my-agent-dojo", "bun-typescript-template", "state");
}

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

type RefusalStationCause = keyof typeof pinRefusalDefinitions;

const verifyRefusalCauses = [
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

const planRefusalCauses = [
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

const moveRefusalCauses = [
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
  causeCode: RefusalStationCause,
) {
  const def = pinRefusalDefinitions[causeCode];
  return {
    ...stationDefaults,
    commandIdentity: identity,
    trigger: def.trigger,
    repairAction: def.repair,
    guidance: { next: { kind: "instruction", text: def.repair } },
    independentObservable: `${identity}:${causeCode.toLowerCase()}`,
  } as const;
}

function verifyRefusalStations<const Identity extends string>(
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

function planRefusalStations<const Identity extends string>(
  identity: Identity,
) {
  return [
    ...verifyRefusalStations(identity),
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

function moveRefusalStations<const Identity extends string>(
  identity: Identity,
) {
  return [
    ...planRefusalStations(identity),
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

function moveStateStations() {
  return [
    station(cliCauses, {
      ...stationDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_HELD",
      trigger: "Another pin move process is changing this target now.",
      repairAction: "Wait for that pin move to finish, then try again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:held`,
    }),
    station(cliCauses, {
      ...stationDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_UNRESOLVED",
      trigger: "An earlier pin move on this target never finished.",
      repairAction:
        "Run bun run pin:verify and inspect git status before trying again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:unresolved`,
    }),
    station(cliCauses, {
      ...stationDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_STATE_UNAVAILABLE",
      trigger: "The front door state folder cannot accept this change.",
      repairAction:
        "Check permissions on the XDG_STATE_HOME state folder, then run bun run pin:move again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:state-unavailable`,
    }),
    station(cliCauses, {
      ...stationDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_FAILED_UNCHANGED",
      trigger: "The pin move failed before changing any tracked pin file.",
      repairAction:
        "Fix the failure reported in the message, then run bun run pin:move again.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:failed-unchanged`,
    }),
    station(cliCauses, {
      ...stationDefaults,
      commandIdentity: pinMoveIdentity,
      causeCode: "DOMAIN_PIN_MOVE_FAILED_PARTIAL",
      trigger: "The pin move failed after partial writes.",
      repairAction:
        "Inspect git status and run bun run pin:verify before retrying.",
      guidance: { handoff: inspectPinState },
      independentObservable: `${pinMoveIdentity}:failed-partial`,
    }),
    station(cliCauses, {
      ...stationDefaults,
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

function classifyRefusal<const Code extends RefusalStationCause>(
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

function stateRefusalCause(
  kind: string,
):
  | "DOMAIN_PIN_MOVE_HELD"
  | "DOMAIN_PIN_MOVE_UNRESOLVED"
  | "DOMAIN_PIN_STATE_UNAVAILABLE" {
  if (kind === "held-lock") return "DOMAIN_PIN_MOVE_HELD";
  if (kind === "unresolved-case") return "DOMAIN_PIN_MOVE_UNRESOLVED";
  return "DOMAIN_PIN_STATE_UNAVAILABLE";
}

function failedTransactionCause(
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

export function pinVerifyCommand(root: string) {
  return command({
    identity: pinVerifyIdentity,
    route: ["pin", "verify"],
    summary:
      "Verify that kernel-pin.json, package.json, and bun.lock agree and that the pinned commit is reachable from the pin's branch.",
    input: {
      arguments: [],
      options: [kernelOption],
      constraints: [],
      deadlineSupported: false,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: { diagnostics: true },
    stations: [
      station(cliCauses, {
        ...stationDefaults,
        commandIdentity: pinVerifyIdentity,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "The pin places agree and the pinned commit is verified.",
        repairAction: null,
        guidance: {
          next: {
            kind: "instruction",
            text: "Check git status and kernel-pin.json if an earlier pin move was interrupted.",
          },
        },
        independentObservable: `${pinVerifyIdentity}:verified`,
      }),
      ...verifyRefusalStations(pinVerifyIdentity),
    ],
    run: (input, context) => {
      try {
        const pin = readKernelPin(root);
        const kernel = input["--kernel"] ?? siblingKernelPath(root, pin);
        const verified = verifyKernelPin(root, kernel).trimEnd();
        context.diagnostics.record(
          "pin.verify.passed",
          { commit: pin.commit, branch: pin.branch },
          "info",
        );
        return context.result(
          {
            commandIdentity: pinVerifyIdentity,
            causeCode: "SUCCESS_UNCHANGED",
          },
          {
            message: verified,
            data: {
              commit: pin.commit,
              branch: pin.branch,
              remote: pin.remote,
              carryOutIdentity: pin.carryOutIdentity,
            },
            effects: noEffects,
          },
        );
      } catch (error) {
        const refused = classifyRefusal(error, verifyRefusalCauses);
        if (refused === undefined) throw error;
        context.diagnostics.record(
          "pin.verify.refused",
          { causeCode: refused.causeCode },
          "warning",
        );
        return context.result(
          { commandIdentity: pinVerifyIdentity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: noEffects },
        );
      }
    },
  });
}

export function pinPlanCommand(root: string, machineOutput: boolean) {
  return command({
    identity: pinPlanIdentity,
    route: ["pin", "plan"],
    summary:
      "Preview a kernel Pin move for a generated repository without writing any file or branch.",
    input: {
      arguments: [commitArgument],
      options: [kernelOption, requiredRepositoryOption],
      constraints: [],
      deadlineSupported: false,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: { diagnostics: true },
    stations: [
      station(cliCauses, {
        ...stationDefaults,
        commandIdentity: pinPlanIdentity,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "The repository pin move plan was built with no writes.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${pinPlanIdentity}:planned`,
      }),
      ...planRefusalStations(pinPlanIdentity),
    ],
    run: async (input, context) => {
      const pin = readKernelPin(root);
      const kernel = {
        repository: input["--kernel"] ?? siblingKernelPath(root, pin),
        commit: input.commit,
      };
      const active: TrialActive = {};
      try {
        const outcome = await moveRepositoryPin(
          kernel,
          pin,
          resolve(input["--repository"]),
          true,
          active,
          (seam, currentPin) =>
            verifyPin(
              seam,
              currentPin,
              pinBranchCommitHeld(currentPin, seam.repository),
            ),
          { quiet: machineOutput },
        );
        if (!outcome.planOnly) {
          throw new Error("Expected plan-only outcome from pin plan.");
        }
        context.diagnostics.record(
          "pin.plan.completed",
          {
            repository: outcome.repository,
            from: outcome.from,
            to: outcome.to,
          },
          "info",
        );
        return context.result(
          { commandIdentity: pinPlanIdentity, causeCode: "SUCCESS_UNCHANGED" },
          {
            message: outcome.message,
            data: {
              planOnly: true,
              repository: outcome.repository,
              from: outcome.from,
              to: outcome.to,
              ...(outcome.changeset === undefined
                ? {}
                : { changeset: outcome.changeset }),
              report: {
                from: outcome.report.from,
                to: outcome.report.to,
                added: [...outcome.report.added],
                changed: [...outcome.report.changed],
                removed: [...outcome.report.removed],
                log: [...outcome.report.log],
              },
            },
            effects: noEffects,
          },
        );
      } catch (error) {
        const refused = classifyRefusal(error, planRefusalCauses);
        if (refused === undefined) throw error;
        context.diagnostics.record(
          "pin.plan.refused",
          { causeCode: refused.causeCode },
          "warning",
        );
        return context.result(
          { commandIdentity: pinPlanIdentity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: noEffects },
        );
      }
    },
  });
}

export function pinMoveCommand(
  root: string,
  state: FrontDoorState,
  machineOutput: boolean,
) {
  return changing({
    identity: pinMoveIdentity,
    route: ["pin", "move"],
    summary:
      "Move the kernel Pin in the template or in a generated repository after running its checks.",
    input: {
      arguments: [commitArgument],
      options: [kernelOption, optionalRepositoryOption],
      constraints: [],
      deadlineSupported: false,
      additionalArguments: false,
      additionalOptions: false,
    },
    capabilities: { diagnostics: true },
    effectClass: "repository-local",
    effects: ["pin.move"],
    ifNoResult: state.descriptor.ifNoResult,
    heldLockCause: "DOMAIN_PIN_MOVE_HELD",
    unresolvedCaseCause: "DOMAIN_PIN_MOVE_UNRESOLVED",
    stations: [
      station(cliCauses, {
        ...stationDefaults,
        commandIdentity: pinMoveIdentity,
        causeCode: "SUCCESS_COMPLETED",
        trigger: "The kernel Pin was moved and verified.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${pinMoveIdentity}:moved`,
      }),
      ...moveRefusalStations(pinMoveIdentity),
      ...moveStateStations(),
    ],
    run: async (input, context) => {
      const pin = readKernelPin(root);
      const kernel = {
        repository: input["--kernel"] ?? siblingKernelPath(root, pin),
        commit: input.commit,
      };
      const active: TrialActive = {};
      const onAbort = () => {
        active.stoppedBy ??= "SIGTERM";
        active.stop?.();
      };
      context.signal.addEventListener("abort", onAbort, { once: true });
      try {
        if (input["--repository"] !== undefined) {
          const targetRepository = resolve(input["--repository"]);
          let movedOutcome:
            | Extract<
                Awaited<ReturnType<typeof moveRepositoryPin>>,
                { readonly planOnly: false }
              >
            | undefined;
          let capturedError: Error | undefined;
          let txOutcome:
            | Awaited<ReturnType<FrontDoorState["transaction"]>>
            | undefined;
          await withStopSignals(active, () =>
            moveRepositoryPin(
              kernel,
              pin,
              targetRepository,
              false,
              active,
              (seam, currentPin) =>
                verifyPin(
                  seam,
                  currentPin,
                  pinBranchCommitHeld(currentPin, seam.repository),
                ),
              {
                quiet: machineOutput,
                runWrite: async (resolvedRepository, apply) => {
                  const tx = await state.transaction(
                    context.state,
                    {
                      command: pinMoveIdentity,
                      scope: {
                        resources: [
                          { resource: "repository", key: resolvedRepository },
                        ],
                      },
                      facts: {
                        repository: resolvedRepository,
                        commit: kernel.commit,
                      },
                    },
                    async (transaction) => {
                      await transaction.record(
                        "pin.move",
                        async () => {
                          try {
                            const result = await apply();
                            if (result.planOnly)
                              throw new Error("Unexpected plan-only result.");
                            movedOutcome = result;
                          } catch (error) {
                            const failure =
                              error instanceof Error
                                ? error
                                : new Error(String(error));
                            capturedError = failure;
                            throw failure;
                          }
                        },
                        () => Promise.resolve(movedOutcome !== undefined),
                      );
                    },
                  );
                  txOutcome = tx;
                  return (
                    movedOutcome ?? {
                      planOnly: true,
                      repository: resolvedRepository,
                      from: kernel.commit,
                      to: kernel.commit,
                      report: {
                        from: kernel.commit,
                        to: kernel.commit,
                        added: [],
                        changed: [],
                        removed: [],
                        log: [],
                      },
                      reportText: "",
                      message: "",
                    }
                  );
                },
              },
            ),
          );
          if (txOutcome === undefined) {
            throw new Error("Pin move did not start a state transaction.");
          }
          const tx = txOutcome;
          if (tx.kind !== "ran") {
            const causeCode = stateRefusalCause(tx.kind);
            context.diagnostics.record(
              "pin.move.refused",
              { causeCode, kind: tx.kind },
              "warning",
            );
            return context.result(
              { commandIdentity: pinMoveIdentity, causeCode },
              {
                message: `Pin move could not acquire state coordination (${tx.kind}).`,
                data: null,
                effects: noEffects,
              },
            );
          }
          if (capturedError !== undefined) {
            const refused = classifyRefusal(capturedError, moveRefusalCauses);
            if (
              refused !== undefined &&
              tx.proof.transactionState === "unchanged"
            ) {
              context.diagnostics.record(
                "pin.move.refused",
                { causeCode: refused.causeCode },
                "warning",
              );
              return context.result(
                {
                  commandIdentity: pinMoveIdentity,
                  causeCode: refused.causeCode,
                },
                { message: refused.message, data: null, effects: noEffects },
              );
            }
            if (refused === undefined) throw capturedError;
          }
          if (
            tx.proof.transactionState !== "completed" ||
            movedOutcome === undefined
          ) {
            const causeCode = failedTransactionCause(tx.proof.transactionState);
            context.diagnostics.record(
              "pin.move.failed",
              { causeCode, transactionState: tx.proof.transactionState },
              "error",
            );
            return context.result(
              { commandIdentity: pinMoveIdentity, causeCode },
              {
                message:
                  capturedError instanceof Error
                    ? capturedError.message
                    : "Pin move did not complete.",
                data: null,
                transaction: tx.proof,
              },
            );
          }
          context.diagnostics.record(
            "pin.move.completed",
            {
              repository: movedOutcome.repository,
              branch: movedOutcome.branch,
              from: movedOutcome.from,
              to: movedOutcome.to,
            },
            "info",
          );
          return context.result(
            {
              commandIdentity: pinMoveIdentity,
              causeCode: "SUCCESS_COMPLETED",
            },
            {
              message: movedOutcome.message,
              data: {
                repository: movedOutcome.repository,
                from: movedOutcome.from,
                to: movedOutcome.to,
                branch: movedOutcome.branch,
                commit: movedOutcome.commit,
                written: [...movedOutcome.written],
              },
              transaction: tx.proof,
            },
          );
        }

        const folder = mkdtempSync(join(tmpdir(), "kernel-trial-"));
        try {
          const { branchCommit, trial } = await withStopSignals(
            active,
            async () => {
              const branchCommit = pinBranchCommitHeld(pin, kernel.repository);
              verifyPin(kernel, pin, branchCommit);
              const trial = await kernelTrial({ kernel, folder, active });
              return { branchCommit, trial };
            },
          );
          let moved: ReturnType<typeof movePin> | undefined;
          let capturedError: Error | undefined;
          const tx = await state.transaction(
            context.state,
            {
              command: pinMoveIdentity,
              scope: { resources: [{ resource: "template", key: root }] },
              facts: { commit: kernel.commit },
            },
            async (transaction) => {
              await transaction.record(
                "pin.move",
                () => {
                  try {
                    moved = movePin(trial, root, branchCommit);
                    return Promise.resolve();
                  } catch (error) {
                    const failure =
                      error instanceof Error ? error : new Error(String(error));
                    capturedError = failure;
                    return Promise.reject(failure);
                  }
                },
                () => Promise.resolve(moved !== undefined),
              );
            },
          );
          if (tx.kind !== "ran") {
            const causeCode = stateRefusalCause(tx.kind);
            context.diagnostics.record(
              "pin.move.refused",
              { causeCode, kind: tx.kind },
              "warning",
            );
            return context.result(
              { commandIdentity: pinMoveIdentity, causeCode },
              {
                message: `Pin move could not acquire state coordination (${tx.kind}).`,
                data: null,
                effects: noEffects,
              },
            );
          }
          if (capturedError !== undefined) {
            const refused = classifyRefusal(capturedError, moveRefusalCauses);
            if (
              refused !== undefined &&
              tx.proof.transactionState === "unchanged"
            ) {
              context.diagnostics.record(
                "pin.move.refused",
                { causeCode: refused.causeCode },
                "warning",
              );
              return context.result(
                {
                  commandIdentity: pinMoveIdentity,
                  causeCode: refused.causeCode,
                },
                { message: refused.message, data: null, effects: noEffects },
              );
            }
            if (refused === undefined) throw capturedError;
          }
          if (
            tx.proof.transactionState !== "completed" ||
            moved === undefined
          ) {
            const causeCode = failedTransactionCause(tx.proof.transactionState);
            context.diagnostics.record(
              "pin.move.failed",
              { causeCode, transactionState: tx.proof.transactionState },
              "error",
            );
            return context.result(
              { commandIdentity: pinMoveIdentity, causeCode },
              {
                message:
                  capturedError instanceof Error
                    ? capturedError.message
                    : "Pin move did not complete.",
                data: null,
                transaction: tx.proof,
              },
            );
          }
          const reportText = pinMoveReportText(moved.report, moved.written);
          if (!machineOutput) process.stdout.write(reportText);
          context.diagnostics.record(
            "pin.move.completed",
            {
              from: moved.report.from,
              to: moved.report.to,
              written: [...moved.written],
            },
            "info",
          );
          return context.result(
            {
              commandIdentity: pinMoveIdentity,
              causeCode: "SUCCESS_COMPLETED",
            },
            {
              message: `Moved template Pin from ${moved.report.from} to ${moved.report.to}.`,
              data: {
                from: moved.report.from,
                to: moved.report.to,
                written: [...moved.written],
                report: {
                  from: moved.report.from,
                  to: moved.report.to,
                  added: [...moved.report.added],
                  changed: [...moved.report.changed],
                  removed: [...moved.report.removed],
                  log: [...moved.report.log],
                },
              },
              transaction: tx.proof,
            },
          );
        } finally {
          rmSync(folder, { recursive: true, force: true });
        }
      } catch (error) {
        const refused = classifyRefusal(error, moveRefusalCauses);
        if (refused === undefined) throw error;
        context.diagnostics.record(
          "pin.move.refused",
          { causeCode: refused.causeCode },
          "warning",
        );
        return context.result(
          { commandIdentity: pinMoveIdentity, causeCode: refused.causeCode },
          { message: refused.message, data: null, effects: noEffects },
        );
      } finally {
        context.signal.removeEventListener("abort", onAbort);
      }
    },
  });
}
