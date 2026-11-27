import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { changing, type StateCapability, station } from "agent-cli-kernel";
import type {
  stateAddon,
  TransactionResult,
} from "agent-cli-kernel/addons/state";
import { kernelTrial, type TrialActive } from "../scripts/kernel-trial.ts";
import { pinMoveReportText } from "../scripts/pin-move-report.ts";
import { cliCauses } from "./causes.ts";
import {
  type KernelPin,
  readKernelPin,
  siblingKernelPath,
} from "./kernel-pin.ts";
import type { KernelSeam } from "./kernel-reader.ts";
import {
  movePin,
  pinBranchCommitHeld,
  verifyPin,
  withStopSignals,
} from "./pin-move.ts";
import { RepositoryPinRefusal } from "./pin-move-branch.ts";
import {
  moveRepositoryPin,
  type RepositoryPinMoveOutcome,
} from "./pin-move-repository.ts";
import {
  classifyMoveRefusal,
  commitArgument,
  kernelOption,
  moveFailedCause,
  moveRefusalRows,
  moveStateRows,
  pinCauseDefaults,
  pinMoveIdentity,
  pinNoChange,
  pinPathValue,
  type PreWriteMoveRefusalCause,
  type RestoredMoveFailureCause,
  stateRefusalCause,
} from "./pin-refusals.ts";

type FrontDoorState = ReturnType<typeof stateAddon>;

type PinMoveEffect = "pin.move";
type MoveTransaction = TransactionResult<PinMoveEffect>;
type AppliedRepositoryOutcome = Extract<
  RepositoryPinMoveOutcome,
  { readonly planOnly: false }
>;

const optionalRepositoryOption = {
  name: "--repository",
  aliases: [],
  summary:
    "Path to a generated repository checkout. Omit to move the template's own pin.",
  required: false,
  repeatable: false,
  value: pinPathValue,
} as const;

function placeholderOutcome(
  repository: string,
  commit: string,
): RepositoryPinMoveOutcome {
  return {
    planOnly: true,
    repository,
    from: commit,
    to: commit,
    report: {
      from: commit,
      to: commit,
      added: [],
      changed: [],
      removed: [],
      log: [],
    },
    reportText: "",
    message: "",
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function handleMoveTransactionFailure<Result>(
  tx: MoveTransaction,
  capturedError: Error | undefined,
  completedValue: unknown,
  onResult: {
    readonly stateRefused: (
      causeCode: ReturnType<typeof stateRefusalCause>,
      kind: string,
    ) => Result;
    readonly domainRefused: (
      causeCode: PreWriteMoveRefusalCause,
      message: string,
    ) => Result;
    readonly restoredFailed: (
      causeCode: RestoredMoveFailureCause,
      message: string,
      proof: Extract<MoveTransaction, { readonly kind: "ran" }>["proof"],
    ) => Result;
    readonly failed: (
      causeCode: ReturnType<typeof moveFailedCause>,
      message: string,
      proof: Extract<MoveTransaction, { readonly kind: "ran" }>["proof"],
    ) => Result;
  },
): Result | undefined {
  if (tx.kind !== "ran") {
    return onResult.stateRefused(stateRefusalCause(tx.kind), tx.kind);
  }
  if (
    tx.proof.transactionState === "unchanged" &&
    capturedError !== undefined
  ) {
    const refused = classifyMoveRefusal(capturedError, "before-write");
    if (refused !== undefined) {
      return onResult.domainRefused(refused.causeCode, refused.message);
    }
    throw capturedError;
  }
  if (
    tx.proof.transactionState === "completed" &&
    completedValue === undefined &&
    capturedError !== undefined
  ) {
    const restoredFailure = classifyMoveRefusal(capturedError, "restored");
    if (restoredFailure !== undefined) {
      return onResult.restoredFailed(
        restoredFailure.causeCode,
        restoredFailure.message,
        tx.proof,
      );
    }
  }
  if (
    tx.proof.transactionState !== "completed" ||
    completedValue === undefined
  ) {
    return onResult.failed(
      moveFailedCause(tx.proof.transactionState),
      capturedError instanceof Error
        ? capturedError.message
        : "Pin move did not complete.",
      tx.proof,
    );
  }
  return undefined;
}

async function executeRepositoryMove(
  kernel: KernelSeam,
  pin: KernelPin,
  targetRepository: string,
  active: TrialActive,
  state: FrontDoorState,
  stateContext: StateCapability<PinMoveEffect>,
): Promise<{
  readonly tx: MoveTransaction;
  readonly movedOutcome: AppliedRepositoryOutcome | undefined;
  readonly capturedError: Error | undefined;
}> {
  let movedOutcome: AppliedRepositoryOutcome | undefined;
  let capturedError: Error | undefined;
  let completedFailure: RepositoryPinRefusal | undefined;
  let txOutcome: MoveTransaction | undefined;
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
        runWrite: async (resolvedRepository, prepare) => {
          const tx = await state.transaction(
            stateContext,
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
              let apply: () => Promise<RepositoryPinMoveOutcome>;
              try {
                ({ apply } = prepare());
              } catch (error) {
                const failure = toError(error);
                capturedError = failure;
                throw failure;
              }
              await transaction.record(
                "pin.move",
                async () => {
                  try {
                    const result = await apply();
                    if (result.planOnly) {
                      throw new Error("Unexpected plan-only result.");
                    }
                    movedOutcome = result;
                  } catch (error) {
                    const failure = toError(error);
                    capturedError = failure;
                    if (
                      error instanceof RepositoryPinRefusal &&
                      error.restored &&
                      classifyMoveRefusal(error, "restored") !== undefined
                    ) {
                      completedFailure = error;
                      return;
                    }
                    throw failure;
                  }
                },
                () =>
                  Promise.resolve(
                    movedOutcome !== undefined ||
                      completedFailure !== undefined,
                  ),
              );
            },
          );
          txOutcome = tx;
          return (
            movedOutcome ??
            placeholderOutcome(resolvedRepository, kernel.commit)
          );
        },
      },
    ),
  );
  if (txOutcome === undefined) {
    throw new Error("Pin move did not start a state transaction.");
  }
  return { tx: txOutcome, movedOutcome, capturedError };
}

async function executeTemplateMove(
  root: string,
  kernel: KernelSeam,
  pin: KernelPin,
  active: TrialActive,
  state: FrontDoorState,
  stateContext: StateCapability<PinMoveEffect>,
): Promise<{
  readonly tx: MoveTransaction;
  readonly moved: ReturnType<typeof movePin> | undefined;
  readonly capturedError: Error | undefined;
}> {
  const branchCommit = pinBranchCommitHeld(pin, kernel.repository);
  verifyPin(kernel, pin, branchCommit);
  const scopeKey = existsSync(root) ? realpathSync(root) : resolve(root);
  let moved: ReturnType<typeof movePin> | undefined;
  let capturedError: Error | undefined;
  const tx = await state.transaction(
    stateContext,
    {
      command: pinMoveIdentity,
      scope: { resources: [{ resource: "template", key: scopeKey }] },
      facts: { commit: kernel.commit },
    },
    async (transaction) => {
      const folder = mkdtempSync(join(tmpdir(), "kernel-trial-"));
      try {
        let trial: Awaited<ReturnType<typeof kernelTrial>>;
        try {
          trial = await withStopSignals(active, () =>
            kernelTrial({ kernel, folder, active }),
          );
        } catch (error) {
          const failure = toError(error);
          capturedError = failure;
          throw failure;
        }
        await transaction.record(
          "pin.move",
          () => {
            try {
              moved = movePin(trial, root, branchCommit);
              return Promise.resolve();
            } catch (error) {
              const failure = toError(error);
              capturedError = failure;
              return Promise.reject(failure);
            }
          },
          () => Promise.resolve(moved !== undefined),
        );
      } finally {
        rmSync(folder, { recursive: true, force: true });
      }
    },
  );
  return { tx, moved, capturedError };
}

function moveResultData(moved: ReturnType<typeof movePin>) {
  return {
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
  };
}

function repositoryResultData(movedOutcome: AppliedRepositoryOutcome) {
  return {
    repository: movedOutcome.repository,
    from: movedOutcome.from,
    to: movedOutcome.to,
    branch: movedOutcome.branch,
    commit: movedOutcome.commit,
    written: [...movedOutcome.written],
  };
}

function createAbortHandler(signal: AbortSignal, active: TrialActive) {
  const onAbort = () => {
    active.stoppedBy ??= "SIGTERM";
    active.stop?.();
  };
  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

export function pinMoveCommand(
  root: string,
  state: ReturnType<typeof stateAddon>,
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
        ...pinCauseDefaults,
        commandIdentity: pinMoveIdentity,
        causeCode: "SUCCESS_COMPLETED",
        trigger: "The kernel Pin was moved and verified.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${pinMoveIdentity}:moved`,
      }),
      ...moveRefusalRows(pinMoveIdentity),
      ...moveStateRows(),
    ],
    run: async (input, context) => {
      const active: TrialActive = {};
      const detachAbort = createAbortHandler(context.signal, active);

      const failureHandlers = {
        stateRefused: (
          causeCode: ReturnType<typeof stateRefusalCause>,
          kind: string,
        ) => {
          context.diagnostics.record(
            "pin.move.refused",
            { causeCode, kind },
            "warning",
          );
          return context.result(
            { commandIdentity: pinMoveIdentity, causeCode },
            {
              message: `Pin move could not acquire state coordination (${kind}).`,
              data: null,
              effects: pinNoChange,
            },
          );
        },
        domainRefused: (
          causeCode: PreWriteMoveRefusalCause,
          message: string,
        ) => {
          context.diagnostics.record(
            "pin.move.refused",
            { causeCode },
            "warning",
          );
          return context.result(
            { commandIdentity: pinMoveIdentity, causeCode },
            { message, data: null, effects: pinNoChange },
          );
        },
        restoredFailed: (
          causeCode: RestoredMoveFailureCause,
          message: string,
          proof: Extract<MoveTransaction, { readonly kind: "ran" }>["proof"],
        ) => {
          context.diagnostics.record(
            "pin.move.failed",
            { causeCode, transactionState: proof.transactionState },
            "error",
          );
          return context.result(
            { commandIdentity: pinMoveIdentity, causeCode },
            { message, data: null, transaction: proof },
          );
        },
        failed: (
          causeCode: ReturnType<typeof moveFailedCause>,
          message: string,
          proof: Extract<MoveTransaction, { readonly kind: "ran" }>["proof"],
        ) => {
          context.diagnostics.record(
            "pin.move.failed",
            { causeCode, transactionState: proof.transactionState },
            "error",
          );
          return context.result(
            { commandIdentity: pinMoveIdentity, causeCode },
            { message, data: null, transaction: proof },
          );
        },
      };

      const finishRepository = async (
        targetRepository: string,
        pin: KernelPin,
        kernel: KernelSeam,
      ) => {
        const { tx, movedOutcome, capturedError } = await executeRepositoryMove(
          kernel,
          pin,
          resolve(targetRepository),
          active,
          state,
          context.state,
        );
        const failure = handleMoveTransactionFailure(
          tx,
          capturedError,
          movedOutcome,
          failureHandlers,
        );
        if (failure !== undefined) return failure;
        if (tx.kind !== "ran" || movedOutcome === undefined) {
          throw new Error("Pin move did not complete.");
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
          { commandIdentity: pinMoveIdentity, causeCode: "SUCCESS_COMPLETED" },
          {
            message: movedOutcome.message,
            data: repositoryResultData(movedOutcome),
            transaction: tx.proof,
          },
        );
      };

      const finishTemplate = async (pin: KernelPin, kernel: KernelSeam) => {
        const { tx, moved, capturedError } = await executeTemplateMove(
          root,
          kernel,
          pin,
          active,
          state,
          context.state,
        );
        const failure = handleMoveTransactionFailure(
          tx,
          capturedError,
          moved,
          failureHandlers,
        );
        if (failure !== undefined) return failure;
        if (tx.kind !== "ran" || moved === undefined) {
          throw new Error("Pin move did not complete.");
        }
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
          { commandIdentity: pinMoveIdentity, causeCode: "SUCCESS_COMPLETED" },
          {
            message: `${pinMoveReportText(moved.report, moved.written)}Moved template Pin from ${moved.report.from} to ${moved.report.to}.`,
            data: moveResultData(moved),
            transaction: tx.proof,
          },
        );
      };

      try {
        const pin = readKernelPin(root);
        const kernel: KernelSeam = {
          repository: input["--kernel"] ?? siblingKernelPath(root, pin),
          commit: input.commit,
        };
        return input["--repository"] !== undefined
          ? await finishRepository(input["--repository"], pin, kernel)
          : await finishTemplate(pin, kernel);
      } catch (error) {
        const refused = classifyMoveRefusal(error, "before-write");
        if (refused === undefined) throw error;
        return failureHandlers.domainRefused(
          refused.causeCode,
          refused.message,
        );
      } finally {
        detachAbort();
      }
    },
  });
}
