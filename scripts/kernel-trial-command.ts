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
