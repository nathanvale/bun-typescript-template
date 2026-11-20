import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { readKernelPin, siblingKernelPath } from "../src/kernel-pin.ts";
import { KernelRefusal } from "../src/kernel-reader.ts";
import { kernelTrial, type TrialActive, TrialRefusal } from "./kernel-trial.ts";
import { argumentsOf, withStopSignals } from "./pin-move.ts";

const templateRoot = resolve(import.meta.dir, "..");

const usage =
  "Usage: bun run kernel-trial <full kernel commit> [--kernel <path to the kernel repository>]\n";

// Interface: the kernel trial command, for any kernel commit, whether or not
// a pin could name it: the kernel repository's hosted check runs it on the
// commit a kernel pull request tests, as advice only. The kernel repository
// defaults to the sibling beside the template, and the generated repository
// installs the commit from the kernel pin's remote. It runs no pin
// verification and writes nothing in the template. It exits 0 when the
// trial passes, 1 on a refusal, printing its code and message, and 2 on
// arguments it cannot read. SIGINT, SIGTERM or SIGHUP stops the trial's
// running step with its process group, and the trial refuses as stopped.
export async function main(
  argv: readonly string[],
  root = templateRoot,
): Promise<number> {
  const given = argumentsOf(argv);
  if (given === undefined) {
    process.stderr.write(usage);
    return 2;
  }
  const kernel = {
    repository: given.path ?? siblingKernelPath(root, readKernelPin(root)),
    commit: given.commit,
  };
  const folder = mkdtempSync(join(tmpdir(), "kernel-trial-"));
  const active: TrialActive = {};
  try {
    await withStopSignals(active, () =>
      kernelTrial({ kernel, folder, active }),
    );
    process.stdout.write(`Kernel trial passed: ${kernel.commit}.\n`);
    return 0;
  } catch (error) {
    if (!(error instanceof TrialRefusal) && !(error instanceof KernelRefusal))
      throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    return 1;
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
