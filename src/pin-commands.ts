import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { command, station } from "agent-cli-kernel";
import type { TrialActive } from "../scripts/kernel-trial.ts";
import { cliCauses } from "./causes.ts";
import { readKernelPin, siblingKernelPath } from "./kernel-pin.ts";
import { pinBranchCommitHeld, verifyPin } from "./pin-move.ts";
import { moveRepositoryPin } from "./pin-move-repository.ts";
import {
  classifyRefusal,
  commitArgument,
  kernelOption,
  pinCauseDefaults,
  pinNoChange,
  pinPathValue,
  pinPlanIdentity,
  pinVerifyIdentity,
  planRefusalCauses,
  planRefusalRows,
  verifyRefusalCauses,
  verifyRefusalRows,
} from "./pin-refusals.ts";
import { verifyKernelPin } from "./pin-verification.ts";

export { pinMoveCommand } from "./pin-move-command.ts";
export {
  pinMoveIdentity,
  pinPlanIdentity,
  pinVerifyIdentity,
} from "./pin-refusals.ts";

const requiredRepositoryOption = {
  name: "--repository",
  aliases: [],
  summary: "Path to a generated repository checkout.",
  required: true,
  repeatable: false,
  value: pinPathValue,
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
        ...pinCauseDefaults,
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
      ...verifyRefusalRows(pinVerifyIdentity),
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
            effects: pinNoChange,
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
          { message: refused.message, data: null, effects: pinNoChange },
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
        ...pinCauseDefaults,
        commandIdentity: pinPlanIdentity,
        causeCode: "SUCCESS_UNCHANGED",
        trigger: "The repository pin move plan was built with no writes.",
        repairAction: null,
        guidance: { next: { kind: "done" } },
        independentObservable: `${pinPlanIdentity}:planned`,
      }),
      ...planRefusalRows(pinPlanIdentity),
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
            effects: pinNoChange,
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
          { message: refused.message, data: null, effects: pinNoChange },
        );
      }
    },
  });
}
