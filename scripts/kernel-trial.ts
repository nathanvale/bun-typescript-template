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
// that takes one cannot be called for a commit no trial passed. It is
// frozen, and `lockfile` gives a copy of the bytes each time it is read.
export type TrialPassed = {
  readonly [passed]: true;
  readonly kernel: KernelSeam;
  readonly lockfile: Uint8Array;
};

export type Qualified = Pick<TrialPassed, "kernel" | "lockfile">;

const made = new WeakMap<TrialPassed, Qualified>();

// Interface: the commit and lockfile a passed trial qualified, as the trial
// recorded them. It refuses a record the trial did not make, such as a
// copy with a field replaced.
export function qualifiedBy(trial: TrialPassed): Qualified {
  const found = made.get(trial);
  if (found === undefined)
    throw new TrialRefusal(
      "That record of a passed kernel trial was not made by the kernel trial.",
    );
  return { kernel: found.kernel, lockfile: found.lockfile.slice() };
}

function recordOf(kernel: KernelSeam, bytes: Uint8Array): TrialPassed {
  const seam = Object.freeze({ ...kernel });
  const kept = bytes.slice();
  const record = Object.freeze({
    [passed]: true as const,
    kernel: seam,
    get lockfile() {
      return kept.slice();
    },
  });
  made.set(record, { kernel: seam, lockfile: kept });
  return record;
}

const installMilliseconds = 120_000;
const checkMilliseconds = 240_000;
export const trialMilliseconds = 2 * installMilliseconds + checkMilliseconds;

const repair =
  "Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.";

const stopRepair =
  "Nothing was written, and nothing is wrong with the kernel commit. Run the kernel trial, or the pin move, again when it can run to its end.";

// Interface: a kernel trial that did not pass. `trial_stopped` is a trial a
// signal stopped, which says nothing about the commit, so its repair is to
// run again; `trial_failed` is every other.
export class TrialRefusal extends Error {
  readonly code: "trial_failed" | "trial_stopped";
  constructor(
    cause: string,
    code: "trial_failed" | "trial_stopped" = "trial_failed",
  ) {
    super(`${cause} Repair: ${code === "trial_stopped" ? stopRepair : repair}`);
    this.code = code;
  }
}

// Interface: the step a kernel trial is running, for a caller that stops it
// on a signal: set `stoppedBy`, then call `stop`. A stopped trial starts no
// further step.
export type TrialActive = {
  stop?: (() => void) | undefined;
  stoppedBy?: string;
};

export type KernelTrial = {
  readonly kernel: KernelSeam;
  readonly folder: string;
  readonly declarationPath?: string;
  readonly kernelFrom?: "remote" | "clone";
  readonly active?: TrialActive;
};

// Interface: what a failed step's refusal shows of its output. Each failing
// test's lines, from bun test's "error:" line to its "(fail)" line, come
// first wherever they are in the output, since the order test files run in
// can leave them far from the end; then the last 20 lines.
function shownOutput(output: string): string {
  const lines = output.trimEnd().split("\n");
  const failing: string[] = [];
  let block: string[] | undefined;
  for (const line of lines) {
    if (line.startsWith("error:")) block = [];
    block?.push(line);
    if (block !== undefined && line.startsWith("(fail) ")) {
      failing.push(...block);
      block = undefined;
    }
  }
  const last = `Its last lines:\n${lines.slice(-20).join("\n")}`;
  return failing.length === 0
    ? last
    : `Its failing tests:\n${failing.join("\n")}\n${last}`;
}

function stopOf(active: TrialActive): string | undefined {
  return active.stoppedBy;
}

// Interface: one step of the kernel trial: Bun with `args` in `folder`,
// stopped with its whole process group once `limitMilliseconds` passes, or
// when its caller stops `active`. It refuses a step that a stop reached,
// that exits non-zero, or that does not finish in time.
export async function trialStep(
  folder: string,
  name: string,
  args: readonly string[],
  limitMilliseconds: number,
  active: TrialActive = {},
): Promise<void> {
  if (active.stoppedBy !== undefined)
    throw new TrialRefusal(
      `The kernel trial was stopped by ${active.stoppedBy} before its ${name} in ${folder}.`,
      "trial_stopped",
    );
  const child = startChild([process.execPath, ...args], {
    cwd: folder,
    limitMilliseconds,
  });
  active.stop = child.stop;
  const run = await child.finished.finally(() => {
    active.stop = undefined;
  });
  const stoppedBy = stopOf(active);
  if (stoppedBy !== undefined)
    throw new TrialRefusal(
      `The kernel trial's ${name} in ${folder} was stopped by ${stoppedBy}.`,
      "trial_stopped",
    );
  if (run.timedOut || run.exitCode !== 0)
    throw new TrialRefusal(
      `The kernel trial's ${name} in ${folder} ${run.timedOut ? `did not finish within ${limitMilliseconds} ms` : `exited ${run.exitCode}`}. ${shownOutput(run.stdout + run.stderr)}\n`,
    );
}

// Interface: the kernel trial. It makes a repository from the candidate
// kernel commit in `folder`/first with no lockfile, and installs there to
// make one, because the first lockfile has nothing to come from. It confirms
// that lockfile exists, then makes a fresh repository in `folder`/second
// with those exact bytes, installs frozen, and runs that repository's check
// command, whose tests start the tool with each add-on. It writes only in
// `folder`, never in the template. Only the trial installs packages. It
// reads the request once, before its first wait, and records the commit it
// tried.
export async function kernelTrial(trial: KernelTrial): Promise<TrialPassed> {
  const { folder, declarationPath, kernelFrom, active = {} } = trial;
  const { repository, commit } = trial.kernel;
  const kernel = Object.freeze({ repository, commit });
  const render = async (name: string, lockfile: "none" | Uint8Array) => {
    const { destination } = await bootstrapWithKernel({
      destination: join(folder, name),
      name: "kernel-trial",
      sourcePacket: "/kernel-trial",
      kernel,
      declarationPath: declarationPath ?? kernelDeclarationPath,
      kernelFrom: kernelFrom ?? "remote",
      lockfile,
    });
    return destination;
  };
  const first = await render("first", "none");
  await trialStep(first, "install", ["install"], installMilliseconds, active);
  const made = join(first, "bun.lock");
  if (!existsSync(made))
    throw new TrialRefusal(
      `The kernel trial's install in ${first} made no lockfile.`,
    );
  const lockfile = new Uint8Array(readFileSync(made));
  const second = await render("second", lockfile);
  await trialStep(
    second,
    "frozen install",
    ["install", "--frozen-lockfile"],
    installMilliseconds,
    active,
  );
  await trialStep(
    second,
    "check command",
    ["run", "check"],
    checkMilliseconds,
    active,
  );
  return recordOf(kernel, lockfile);
}
