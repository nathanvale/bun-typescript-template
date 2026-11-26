import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { startChild, withoutRepositoryLocation } from "./process-runner.ts";
import { testRunFolderVariable } from "./test-run.ts";
import { bootstrapWithKernel } from "../src/bootstrap.ts";
import {
  type KernelSeam,
  kernelDeclarationPath,
} from "../src/kernel-reader.ts";

const passed: unique symbol = Symbol("a passed kernel trial");

export type TrialPassed = {
  readonly [passed]: true;
  readonly kernel: KernelSeam;
  readonly lockfile: Uint8Array;
};

export type Qualified = Pick<TrialPassed, "kernel" | "lockfile">;

const made = new WeakMap<TrialPassed, Qualified>();

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

export type TrialActive = {
  stop?: (() => void) | undefined;
  stoppedBy?: string;
};

const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export async function withStopSignals<Result>(
  active: TrialActive,
  work: () => Promise<Result>,
): Promise<Result> {
  const stop = (signal: string) => {
    active.stoppedBy ??= signal;
    active.stop?.();
  };
  for (const signal of stopSignals) process.on(signal, stop);
  try {
    return await work();
  } finally {
    for (const signal of stopSignals) process.off(signal, stop);
  }
}

export type KernelTrial = {
  readonly kernel: KernelSeam;
  readonly folder: string;
  readonly declarationPath?: string;
  readonly kernelFrom?: "remote" | "clone";
  readonly active?: TrialActive;
};

const testLines = 30;
const failingLines = 120;

function failingTests(lines: readonly string[]): string[][] {
  const tests: string[][] = [];
  let test: string[] | undefined;
  for (const line of lines) {
    if (test === undefined && line.startsWith("error:")) test = [];
    test?.push(line);
    if (test !== undefined && line.startsWith("(fail) ")) {
      tests.push(test);
      test = undefined;
    }
  }
  return tests;
}

function shortened(test: readonly string[]): readonly string[] {
  if (test.length <= testLines) return test;
  const kept = testLines - 2;
  return [
    ...test.slice(0, kept),
    `(${test.length - kept - 1} more lines of this failing test left out)`,
    test.at(-1) ?? "",
  ];
}

function shownOutput(output: string): string {
  const lines = output.trimEnd().split("\n");
  const shown: string[] = [];
  const tests = failingTests(lines);
  for (const [index, test] of tests.entries()) {
    const kept = shortened(test);
    if (shown.length + kept.length > failingLines) {
      shown.push(`(${tests.length - index} more failing tests left out)`);
      break;
    }
    shown.push(...kept);
  }
  const last = `Its last lines:\n${lines.slice(-20).join("\n")}`;
  return shown.length === 0
    ? last
    : `Its failing tests:\n${shown.join("\n")}\n${last}`;
}

function stopOf(active: TrialActive): string | undefined {
  return active.stoppedBy;
}

function stepEnv(
  runTemp: string,
): Readonly<Record<string, string | undefined>> {
  const base = withoutRepositoryLocation(process.env);
  return {
    ...base,
    PATH: (base.PATH ?? "")
      .split(delimiter)
      .filter(
        (entry) =>
          basename(entry) !== ".bin" ||
          basename(dirname(entry)) !== "node_modules",
      )
      .join(delimiter),
    STATE_TEST_DIR: runTemp,
    TMP: runTemp,
    TEMP: runTemp,
    TMPDIR: runTemp,
    [testRunFolderVariable]: runTemp,
  };
}

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
  const existingRunFolder = process.env[testRunFolderVariable];
  const ownedTemp =
    existingRunFolder && existingRunFolder !== ""
      ? undefined
      : mkdtempSync(
          join(
            process.env.STATE_TEST_DIR || process.env.TMPDIR || tmpdir(),
            "kernel-trial-run-",
          ),
        );
  const runTemp = ownedTemp ?? existingRunFolder ?? tmpdir();
  try {
    const child = startChild([process.execPath, ...args], {
      cwd: folder,
      env: stepEnv(runTemp),
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
  } finally {
    if (ownedTemp !== undefined)
      rmSync(ownedTemp, { recursive: true, force: true });
  }
}

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
