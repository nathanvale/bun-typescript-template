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
  repositoryAt,
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

// Platform: git starts automatic maintenance in the background after a fetch,
// and it writes into the clone after the fetch returns.
export function fetchBranchCommit(
  repository: string,
  remote: string,
  commit: string,
  limitMilliseconds = remoteMilliseconds,
): boolean {
  const local = repositoryAt(repository);
  const held = () =>
    git(local, "cat-file", ["-e", `${commit}^{commit}`]).code === 0;
  if (held()) return true;
  Bun.spawnSync(
    [
      "git",
      "-C",
      local,
      "-c",
      "maintenance.auto=false",
      "-c",
      "gc.auto=0",
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--",
      remote,
      commit,
    ],
    {
      env: {
        PATH: process.env.PATH ?? "",
        GIT_TERMINAL_PROMPT: "0",
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_CONFIG_GLOBAL: "/dev/null",
      },
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      timeout: limitMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  return held();
}

export function branchCommitHeldBy(
  pin: Pick<KernelPin, "remote" | "branch">,
  repository: string,
): string {
  const branchCommit = pinBranchCommit(pin);
  fetchBranchCommit(repository, pin.remote, branchCommit);
  return branchCommit;
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
      const branchCommit = branchCommitHeldBy(pin, kernel.repository);
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
