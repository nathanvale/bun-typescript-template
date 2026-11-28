import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  qualifiedBy,
  type TrialPassed,
  withStopSignals,
} from "../scripts/kernel-trial.ts";
export { withStopSignals };
import {
  type PinMoveReport,
  pinMoveReport,
} from "../scripts/pin-move-report.ts";
import {
  generatedPin,
  type KernelPin,
  kernelPinFile,
  readKernelPin,
  writeKernelPin,
} from "./kernel-pin.ts";
import {
  git,
  type KernelSeam,
  openCommit,
  repositoryAt,
} from "./kernel-reader.ts";
import { KERNEL_LOCKFILE } from "./recipe.ts";

export type PinMove = {
  readonly report: PinMoveReport;
  readonly written: readonly string[];
};

export const pinRefusalCodes = [
  "pin_places_disagree",
  "kernel_commit_unreachable",
  "kernel_commit_before_carry_out",
  "kernel_history_unreadable",
  "kernel_branch_unreadable",
] as const;

export type PinRefusalCode = (typeof pinRefusalCodes)[number];

const repairs: { readonly [Code in PinRefusalCode]: string } = {
  pin_places_disagree:
    "Edit package.json's agent-cli-kernel dependency to match kernel-pin.json's commit and run bun install (bun run pin:move writes both places once updated).",
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

export function pinBranchCommitHeld(
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

function ownValue(target: unknown, key: string): unknown {
  return typeof target === "object" && target !== null
    ? Object.getOwnPropertyDescriptor(target, key)?.value
    : undefined;
}

function writeTemplateLockfile(
  template: string,
  pin: KernelPin,
  commit: string,
  trialLockfile: Uint8Array,
): boolean {
  const lockPath = join(template, "bun.lock");
  if (!existsSync(lockPath)) return false;
  const before = readFileSync(lockPath, "utf8");
  const spec = generatedPin(pin, commit);
  const shortCommit = commit.slice(0, 7);
  const declared = /"agent-cli-kernel": "[^"\n]*#([0-9a-f]{40})"/.exec(
    before,
  )?.[1];
  const resolved =
    /"agent-cli-kernel": \["agent-cli-kernel@[^"\n]*#([0-9a-f]{7,40})"/.exec(
      before,
    )?.[1];
  if (
    declared === commit &&
    resolved !== undefined &&
    commit.startsWith(resolved)
  )
    return false;
  let next = before.replace(
    /"agent-cli-kernel": "[^"\n]*#[0-9a-f]{40}"/,
    () => `"agent-cli-kernel": "${spec}"`,
  );
  const trialText = new TextDecoder().decode(trialLockfile);
  const resolvedFromTrial =
    /^([ \t]*"agent-cli-kernel": \["agent-cli-kernel@github:[^\n]+)$/m.exec(
      trialText,
    )?.[1];
  if (resolvedFromTrial !== undefined) {
    next = next.replace(
      /^[ \t]*"agent-cli-kernel": \["agent-cli-kernel@[^\n]+$/m,
      () => resolvedFromTrial,
    );
  } else {
    next = next.replace(
      /(^[ \t]*"agent-cli-kernel": \["agent-cli-kernel@[^"\n]*#)[0-9a-f]{7,40}(".*?")([^"\n]*?-)[0-9a-f]{7,40}(")/m,
      (_, head: string, mid: string, folderPrefix: string, tail: string) =>
        `${head}${shortCommit}${mid}${folderPrefix}${shortCommit}${tail}`,
    );
  }
  if (next === before) return false;
  writeFileSync(lockPath, next);
  return true;
}

function writeTemplatePackagePin(
  template: string,
  pin: KernelPin,
  commit: string,
): boolean {
  const manifestPath = join(template, "package.json");
  if (!existsSync(manifestPath)) return false;
  const before = readFileSync(manifestPath, "utf8");
  const parsed: unknown = JSON.parse(before);
  const deps = ownValue(parsed, "dependencies");
  if (typeof deps !== "object" || deps === null || Array.isArray(deps))
    return false;
  const spec = generatedPin(pin, commit);
  if (ownValue(deps, pin.repository) === spec) return false;
  Reflect.set(deps, pin.repository, spec);
  const next = `${JSON.stringify(parsed, null, 2)}\n`;
  if (next === before) return false;
  writeFileSync(manifestPath, next);
  return true;
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
  if (
    writeTemplateLockfile(
      template,
      pin,
      qualified.kernel.commit,
      qualified.lockfile,
    )
  )
    written.push("bun.lock");
  if (writeTemplatePackagePin(template, pin, qualified.kernel.commit))
    written.push("package.json");
  if (writeKernelPin(template, { ...pin, commit: qualified.kernel.commit }))
    written.push(kernelPinFile);
  return { report, written };
}
