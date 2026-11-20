import { resolve } from "node:path";
import { readKernelPin, siblingKernelPath } from "../src/kernel-pin.ts";
import { KernelRefusal } from "../src/kernel-reader.ts";
import { PinRefusal, pinBranchCommit, verifyPin } from "./pin-move.ts";

const templateRoot = resolve(import.meta.dir, "..");

const usage =
  "Usage: bun run pin-verification [--kernel <path to the kernel repository>]\n";

// Interface: the pin verification command's arguments: nothing, or the
// kernel repository's path after --kernel. Anything else is undefined.
export function argumentsOf(
  argv: readonly string[],
): { readonly path?: string } | undefined {
  const [flag, path, ...rest] = argv;
  if (flag === undefined) return {};
  return flag === "--kernel" && path !== undefined && rest.length === 0
    ? { path }
    : undefined;
}

// Interface: pin verification of the kernel pin at `root`, against the
// kernel repository at `kernel`. It reads where the pin's branch points on
// the pin's own remote, then verifies the pinned commit with verifyPin, and
// returns the line the command prints. It refuses as verifyPin and
// pinBranchCommit do.
export function verifyKernelPin(root: string, kernel: string): string {
  const pin = readKernelPin(root);
  const branchCommit = pinBranchCommit(pin);
  verifyPin({ repository: kernel, commit: pin.commit }, pin, branchCommit);
  return `Pin verified: ${pin.commit} is reachable from ${branchCommit}, where branch ${pin.branch} points on ${pin.remote}, and has the carry-out commit ${pin.carryOutIdentity} as an ancestor.\n`;
}

// Interface: the pin verification command, which the hosted check runs. The
// kernel repository defaults to the sibling beside the template. It exits 0
// when the pin passes, 1 on a refusal, printing its code and message, and 2
// on arguments it cannot read.
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
