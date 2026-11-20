import { resolve } from "node:path";
import { readKernelPin, siblingKernelPath } from "../src/kernel-pin.ts";
import { KernelRefusal } from "../src/kernel-reader.ts";
import { branchCommitHeldBy, PinRefusal, verifyPin } from "./pin-move.ts";

const templateRoot = resolve(import.meta.dir, "..");

const usage =
  "Usage: bun run pin-verification [--kernel <path to the kernel repository>]\n";

export function argumentsOf(
  argv: readonly string[],
): { readonly path?: string } | undefined {
  const [flag, path, ...rest] = argv;
  if (flag === undefined) return {};
  return flag === "--kernel" && path !== undefined && rest.length === 0
    ? { path }
    : undefined;
}

export function verifyKernelPin(root: string, kernel: string): string {
  const pin = readKernelPin(root);
  const branchCommit = branchCommitHeldBy(pin, kernel);
  verifyPin({ repository: kernel, commit: pin.commit }, pin, branchCommit);
  return `Pin verified: ${pin.commit} is reachable from ${branchCommit}, where branch ${pin.branch} points on ${pin.remote}, and has the carry-out commit ${pin.carryOutIdentity} as an ancestor.\n`;
}

export function main(argv: readonly string[], root = templateRoot): number {
  const given = argumentsOf(argv);
  if (given === undefined) {
    process.stderr.write(usage);
    return 2;
  }
  const kernel = given.path ?? siblingKernelPath(root, readKernelPin(root));
  try {
    process.stdout.write(verifyKernelPin(root, kernel));
    return 0;
  } catch (error) {
    if (!(error instanceof PinRefusal) && !(error instanceof KernelRefusal))
      throw error;
    process.stderr.write(`${error.code}: ${error.message}\n`);
    return 1;
  }
}

if (import.meta.main) process.exitCode = main(process.argv.slice(2));
