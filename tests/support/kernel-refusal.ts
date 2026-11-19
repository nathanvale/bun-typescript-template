import {
  KernelRefusal,
  type KernelRefusalCode,
} from "../../src/kernel-reader.ts";

// Interface: the repair line each kernel reader refusal must end with, written
// out here so a test compares the source's text with a second copy.
export const repairs = {
  repository:
    "Put a clone of the kernel repository at that path, or give the path of one that is there.",
  abbreviated:
    "Give the commit's full identity, as `git rev-parse <commit>` prints it in the kernel repository.",
  commit:
    "Give a commit that clone holds with all its files. Fetch one with `git fetch origin <commit>`, and in a partial clone also run `git fetch --refetch --no-filter origin`. Then run this again.",
  format: "Give a kernel repository that uses git's sha1 object format.",
  declarationMissing:
    "Give a commit that holds the kernel declaration, or the path the kernel declaration has at that commit.",
  declaration:
    "Correct the kernel declaration in the kernel repository, then give the commit that holds the correction.",
  entry:
    "Make that entry a plain file with its own name in the kernel repository, then give the commit that holds the change.",
};

export type Refusal = {
  readonly code: KernelRefusalCode;
  readonly message: string;
  readonly repair: string;
};

export function refusalOf(read: () => unknown): Refusal {
  try {
    read();
  } catch (error) {
    if (!(error instanceof KernelRefusal)) throw error;
    return { code: error.code, message: error.message, repair: error.repair };
  }
  throw new Error("The read was not refused.");
}

export function refused<Code extends string>(
  code: Code,
  cause: string,
  repair: string,
) {
  return { code, message: `${cause} Repair: ${repair}`, repair };
}
