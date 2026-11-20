import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "./process-runner.ts";
import { bootstrapWithKernel } from "../src/bootstrap.ts";
import {
  type KernelSeam,
  kernelDeclarationPath,
} from "../src/kernel-reader.ts";

const passed: unique symbol = Symbol("a passed kernel trial");

// Interface: the record that a kernel trial passed for one kernel commit,
// with the lockfile it qualified. Only kernelTrial makes one, so a function
// that takes one cannot be called for a commit no trial passed.
export type TrialPassed = {
  readonly [passed]: true;
  readonly kernel: KernelSeam;
  readonly lockfile: Uint8Array;
};

const installMilliseconds = 120_000;
const checkMilliseconds = 240_000;
export const trialMilliseconds = 2 * installMilliseconds + checkMilliseconds;

const repair =
  "Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.";

export class TrialRefusal extends Error {
  readonly code = "trial_failed";
  constructor(cause: string) {
    super(`${cause} Repair: ${repair}`);
  }
}

export type KernelTrial = {
  readonly kernel: KernelSeam;
  readonly folder: string;
  readonly declarationPath?: string;
  readonly kernelFrom?: "remote" | "clone";
};

function lastLines(output: string): string {
  return output.trimEnd().split("\n").slice(-20).join("\n");
}

async function step(
  folder: string,
  name: string,
  args: readonly string[],
  limitMilliseconds: number,
): Promise<void> {
  const run = await startChild([process.execPath, ...args], {
    cwd: folder,
    limitMilliseconds,
  }).finished;
  if (run.timedOut || run.exitCode !== 0)
    throw new TrialRefusal(
      `The kernel trial's ${name} in ${folder} ${run.timedOut ? `did not finish within ${limitMilliseconds} ms` : `exited ${run.exitCode}`}. Its last lines:\n${lastLines(run.stdout + run.stderr)}\n`,
    );
}

// Interface: the kernel trial. It makes a repository from the candidate
// kernel commit in `folder`/first with no lockfile, and installs there to
// make one, because the first lockfile has nothing to come from. It confirms
// that lockfile exists, then makes a fresh repository in `folder`/second
// with those exact bytes, installs frozen, and runs that repository's check
// command, whose tests start the tool with each add-on. It writes only in
// `folder`, never in the template. Only the trial installs packages.
export async function kernelTrial(trial: KernelTrial): Promise<TrialPassed> {
  const render = async (name: string, lockfile: "none" | Uint8Array) => {
    const { destination } = await bootstrapWithKernel({
      destination: join(trial.folder, name),
      name: "kernel-trial",
      sourcePacket: "/kernel-trial",
      kernel: trial.kernel,
      declarationPath: trial.declarationPath ?? kernelDeclarationPath,
      kernelFrom: trial.kernelFrom ?? "remote",
      lockfile,
    });
    return destination;
  };
  const first = await render("first", "none");
  await step(first, "install", ["install"], installMilliseconds);
  const made = join(first, "bun.lock");
  if (!existsSync(made))
    throw new TrialRefusal(
      `The kernel trial's install in ${first} made no lockfile.`,
    );
  const lockfile = new Uint8Array(readFileSync(made));
  const second = await render("second", lockfile);
  await step(
    second,
    "frozen install",
    ["install", "--frozen-lockfile"],
    installMilliseconds,
  );
  await step(second, "check command", ["run", "check"], checkMilliseconds);
  return { [passed]: true, kernel: trial.kernel, lockfile };
}
