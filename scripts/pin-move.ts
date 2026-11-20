import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  type KernelPin,
  readKernelPin,
  writeKernelPin,
} from "../src/kernel-pin.ts";
import {
  git,
  KernelRefusal,
  type KernelSeam,
  openCommit,
} from "../src/kernel-reader.ts";
import { kernelTrial, type TrialPassed, TrialRefusal } from "./kernel-trial.ts";
import {
  type PinMoveReport,
  pinMoveReport,
  pinMoveReportText,
} from "./pin-move-report.ts";
import { KERNEL_LOCKFILE } from "../src/recipe.ts";

const templateRoot = resolve(import.meta.dir, "..");

export type PinMove = {
  readonly report: PinMoveReport;
  readonly written: readonly string[];
};

export type PinRefusalCode =
  | "kernel_commit_unreachable"
  | "kernel_commit_before_carry_out";

const repairs: { readonly [Code in PinRefusalCode]: string } = {
  kernel_commit_unreachable:
    "Give a commit that branch reaches. If the clone is behind, run git fetch origin <branch> there first.",
  kernel_commit_before_carry_out:
    "Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.",
};

export class PinRefusal extends Error {
  readonly repair: string;
  constructor(
    readonly code: PinRefusalCode,
    cause: string,
    branch = "",
  ) {
    const repair = repairs[code].replace("<branch>", branch);
    super(`${cause} Repair: ${repair}`);
    this.repair = repair;
  }
}

// Platform: a clone made by git clone, or by a hosted checkout, holds the
// remote's branch under refs/remotes/origin, and its own copy of the branch
// can lag behind it or be missing. A repository with no remote holds only
// its own branch.
function branchTip(repository: string, branch: string): string | undefined {
  for (const ref of [`refs/remotes/origin/${branch}`, `refs/heads/${branch}`]) {
    const found = git(repository, "rev-parse", [
      "--verify",
      "--quiet",
      `${ref}^{commit}`,
    ]);
    if (found.ok) return found.stdout.toString().trim();
  }
  return undefined;
}

function isAncestor(repository: string, older: string, newer: string) {
  return git(repository, "merge-base", ["--is-ancestor", older, newer]).ok;
}

// Interface: pin verification. The commit must be reachable from the pin's
// named branch, and the carry-out commit must be that commit or an ancestor
// of it: the kernel repository carries the template's history, so commits
// from before the carry-out are reachable too. It reads git history only,
// never a kernel declaration, so it judges any commit on the branch. It
// refuses by throwing a KernelRefusal for a repository or commit the kernel
// reader cannot open, and a PinRefusal otherwise. Returns the repository's
// real path.
export function verifyPin(
  seam: KernelSeam,
  { branch, carryOutIdentity }: Pick<KernelPin, "branch" | "carryOutIdentity">,
): string {
  const repository = openCommit(seam);
  const { commit } = seam;
  const tip = branchTip(repository, branch);
  if (tip === undefined)
    throw new PinRefusal(
      "kernel_commit_unreachable",
      `The git repository at ${seam.repository} has no branch ${branch}, so commit ${commit} cannot be shown reachable from it.`,
      branch,
    );
  if (!isAncestor(repository, commit, tip))
    throw new PinRefusal(
      "kernel_commit_unreachable",
      `Commit ${commit} is not reachable from branch ${branch} in the git repository at ${seam.repository}.`,
      branch,
    );
  if (!isAncestor(repository, carryOutIdentity, commit))
    throw new PinRefusal(
      "kernel_commit_before_carry_out",
      `Commit ${commit} does not have the carry-out commit ${carryOutIdentity} as an ancestor in the git repository at ${seam.repository}.`,
    );
  return repository;
}

// Interface: the pin move. It takes a passed kernel trial, so a pin move
// without one does not compile. It verifies the trial's commit against the
// pin at `template`, builds the pin move report, then writes the lockfile the
// trial qualified, if its bytes changed, and the pin last, if it changed. The
// carry-out identity is copied from the pin as it was. It commits nothing,
// and run twice with the same trial it writes nothing the second time.
export function movePin(trial: TrialPassed, template: string): PinMove {
  const pin = readKernelPin(template);
  const repository = verifyPin(trial.kernel, pin);
  openCommit({ repository, commit: pin.commit });
  const report = pinMoveReport(repository, pin.commit, trial.kernel.commit);
  const written: string[] = [];
  const lockfile = join(template, KERNEL_LOCKFILE);
  if (
    !existsSync(lockfile) ||
    Buffer.compare(readFileSync(lockfile), trial.lockfile) !== 0
  ) {
    mkdirSync(dirname(lockfile), { recursive: true });
    writeFileSync(lockfile, trial.lockfile);
    written.push(KERNEL_LOCKFILE);
  }
  if (writeKernelPin(template, { ...pin, commit: trial.kernel.commit }))
    written.push("kernel-pin.json");
  return { report, written };
}

const usage =
  "Usage: bun run pin-move <full kernel commit> [--kernel <path to the kernel repository>]\n";

function argumentsOf(
  argv: readonly string[],
): { readonly commit: string; readonly path?: string } | undefined {
  const [commit, flag, path, ...rest] = argv;
  if (commit === undefined || rest.length > 0) return undefined;
  if (flag === undefined) return { commit };
  return flag === "--kernel" && path !== undefined
    ? { commit, path }
    : undefined;
}

function refusalExit(error: unknown): number {
  if (
    !(error instanceof PinRefusal) &&
    !(error instanceof KernelRefusal) &&
    !(error instanceof TrialRefusal)
  )
    throw error;
  process.stderr.write(`${error.code}: ${error.message}\n`);
  return 1;
}

// Interface: the pin move command. The kernel repository defaults to the
// sibling beside the template. It verifies the commit before the trial, so a
// refused commit costs no install, and keeps the trial's folder only for the
// run.
export async function main(argv: readonly string[]): Promise<number> {
  const given = argumentsOf(argv);
  if (given === undefined) {
    process.stderr.write(usage);
    return 2;
  }
  const pin = readKernelPin(templateRoot);
  const kernel = {
    repository: given.path ?? join(dirname(templateRoot), pin.repository),
    commit: given.commit,
  };
  const folder = mkdtempSync(join(tmpdir(), "kernel-trial-"));
  try {
    verifyPin(kernel, pin);
    const { report, written } = movePin(
      await kernelTrial({ kernel, folder }),
      templateRoot,
    );
    process.stdout.write(pinMoveReportText(report, written));
    return 0;
  } catch (error) {
    return refusalExit(error);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
