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
  kernelPinFile,
  readKernelPin,
  siblingKernelPath,
  writeKernelPin,
} from "../src/kernel-pin.ts";
import {
  git,
  KernelRefusal,
  type KernelSeam,
  openCommit,
} from "../src/kernel-reader.ts";
import {
  kernelTrial,
  qualifiedBy,
  type TrialActive,
  type TrialPassed,
  TrialRefusal,
} from "./kernel-trial.ts";
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
  | "kernel_commit_before_carry_out"
  | "kernel_history_unreadable"
  | "kernel_branch_unreadable";

const repairs: { readonly [Code in PinRefusalCode]: string } = {
  kernel_commit_unreachable:
    "Give a commit that branch reaches on the pin's remote. Push the commit there first if it is only local.",
  kernel_commit_before_carry_out:
    "Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.",
  kernel_history_unreadable:
    "Give a full clone of the kernel repository that holds both commits: run git fetch --unshallow origin, or git fetch origin <branch>, there, then run this again.",
  kernel_branch_unreadable:
    "Check that the network reaches the pin's remote and that it serves branch <branch>, then run this again.",
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

const remoteMilliseconds = 20_000;

// Interface: the commit that the pin's named branch points at on the pin's
// own remote, read with git ls-remote, never from a local clone, whose
// branches can hold unpushed commits or name another repository. It
// refuses when the remote does not answer within `limitMilliseconds`, when
// git fails, and when the remote has no such branch.
export function pinBranchCommit(
  { remote, branch }: Pick<KernelPin, "remote" | "branch">,
  limitMilliseconds = remoteMilliseconds,
): string {
  const run = Bun.spawnSync(
    ["git", "ls-remote", "--", remote, `refs/heads/${branch}`],
    {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: limitMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  const unreadable = (why: string) =>
    new PinRefusal(
      "kernel_branch_unreadable",
      `Branch ${branch} of ${remote} could not be read: ${why}`,
      branch,
    );
  if (run.exitedDueToTimeout)
    throw unreadable(
      `git ls-remote did not finish within ${limitMilliseconds} ms.`,
    );
  if (run.exitCode !== 0)
    throw unreadable(
      `git ls-remote exited ${run.exitCode} and says "${run.stderr.toString().trim().split("\n")[0] ?? ""}".`,
    );
  const [commit = ""] = run.stdout.toString().split("\t");
  if (!/^[0-9a-f]{40}$/.test(commit))
    throw unreadable("the remote has no such branch.");
  return commit;
}

// Platform: git merge-base --is-ancestor exits 0 for yes and 1 for no. Any
// other exit means git could not read the history, as in a shallow clone or
// one that lacks a commit, and is never read as no.
function isAncestor(
  repository: string,
  older: string,
  newer: string,
  branch: string,
): boolean {
  const run = git(repository, "merge-base", ["--is-ancestor", older, newer]);
  if (run.code === 0 || run.code === 1) return run.code === 0;
  throw new PinRefusal(
    "kernel_history_unreadable",
    `git cannot tell whether ${older} is an ancestor of ${newer} in the git repository at ${repository}: git says "${run.said}".`,
    branch,
  );
}

// Interface: pin verification. The commit must be reachable from
// `branchCommit`, the commit the pin's named branch points at on the pin's
// remote (see pinBranchCommit), and the carry-out commit must be that commit
// or an ancestor of it: the kernel repository carries the template's
// history, so commits from before the carry-out are reachable too. It reads
// git history only, never a kernel declaration, so it judges any commit on
// the branch. It refuses by throwing a KernelRefusal for a repository or
// commit the kernel reader cannot open, and a PinRefusal otherwise. Returns
// the repository's real path.
export function verifyPin(
  seam: KernelSeam,
  { branch, carryOutIdentity }: Pick<KernelPin, "branch" | "carryOutIdentity">,
  branchCommit: string,
): string {
  const repository = openCommit(seam);
  const { commit } = seam;
  if (!isAncestor(repository, commit, branchCommit, branch))
    throw new PinRefusal(
      "kernel_commit_unreachable",
      `Commit ${commit} is not reachable from ${branchCommit}, where branch ${branch} points on the pin's remote, in the git repository at ${seam.repository}.`,
      branch,
    );
  if (!isAncestor(repository, carryOutIdentity, commit, branch))
    throw new PinRefusal(
      "kernel_commit_before_carry_out",
      `Commit ${commit} does not have the carry-out commit ${carryOutIdentity} as an ancestor in the git repository at ${seam.repository}.`,
    );
  return repository;
}

// Interface: the pin move. It takes a passed kernel trial, so a pin move
// without one does not compile. It verifies the trial's commit against the
// pin at `template` and `branchCommit`, the commit the pin's branch points
// at on the pin's remote, builds the pin move report, then writes the lockfile the
// trial qualified, if its bytes changed, and the pin last, if it changed. The
// carry-out identity is copied from the pin as it was. It commits nothing,
// and run twice with the same trial it writes nothing the second time.
export function movePin(
  trial: TrialPassed,
  template: string,
  branchCommit: string,
): PinMove {
  const qualified = qualifiedBy(trial);
  const pin = readKernelPin(template);
  const repository = verifyPin(qualified.kernel, pin, branchCommit);
  openCommit({ repository, commit: pin.commit });
  const report = pinMoveReport(repository, pin.commit, qualified.kernel.commit);
  const written: string[] = [];
  const lockfile = join(template, KERNEL_LOCKFILE);
  if (
    !existsSync(lockfile) ||
    Buffer.compare(readFileSync(lockfile), qualified.lockfile) !== 0
  ) {
    mkdirSync(dirname(lockfile), { recursive: true });
    writeFileSync(lockfile, qualified.lockfile);
    written.push(KERNEL_LOCKFILE);
  }
  if (writeKernelPin(template, { ...pin, commit: qualified.kernel.commit }))
    written.push(kernelPinFile);
  return { report, written };
}

const usage =
  "Usage: bun run pin-move <full kernel commit> [--kernel <path to the kernel repository>]\n";

// Interface: the pin move command's arguments: one commit, and the kernel
// repository's path after --kernel. Anything else is no arguments at all.
export function argumentsOf(
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

const stopSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

// Interface: runs `work` with SIGINT, SIGTERM and SIGHUP stopping the step
// `active` holds, instead of ending the process, and removes those handlers
// when `work` settles. The pin move command runs its whole trial and pin
// move inside it.
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

// Interface: the pin move command. The kernel repository defaults to the
// sibling beside the template. It reads the pin's branch from the pin's
// remote and verifies the commit before the trial, so a refused commit costs
// no install, and keeps the trial's folder only for the
// run. SIGINT, SIGTERM or SIGHUP stops the trial's running step with its
// process group; the command then writes nothing, removes the trial's
// folder and exits 1.
export async function main(argv: readonly string[]): Promise<number> {
  const given = argumentsOf(argv);
  if (given === undefined) {
    process.stderr.write(usage);
    return 2;
  }
  const pin = readKernelPin(templateRoot);
  const kernel = {
    repository: given.path ?? siblingKernelPath(templateRoot, pin),
    commit: given.commit,
  };
  const folder = mkdtempSync(join(tmpdir(), "kernel-trial-"));
  const active: TrialActive = {};
  try {
    return await withStopSignals(active, async () => {
      const branchCommit = pinBranchCommit(pin);
      verifyPin(kernel, pin, branchCommit);
      const { report, written } = movePin(
        await kernelTrial({ kernel, folder, active }),
        templateRoot,
        branchCommit,
      );
      process.stdout.write(pinMoveReportText(report, written));
      return 0;
    });
  } catch (error) {
    return refusalExit(error);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
