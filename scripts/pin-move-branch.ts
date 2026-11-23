import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type TrialActive, trialStep } from "./kernel-trial.ts";
import { withoutRepositoryLocation } from "./process-runner.ts";

const repositoryGitMilliseconds = 20_000;
const restoreInstallMilliseconds = 120_000;

export class RepositoryPinRefusal extends Error {
  constructor(
    readonly code: string,
    readonly reason: string,
    readonly repair: string,
  ) {
    super(`${reason} Repair: ${repair}`);
  }
}

export function repositoryGit(repository: string, args: readonly string[]) {
  const run = Bun.spawnSync(["git", "-C", repository, ...args], {
    env: {
      ...withoutRepositoryLocation(process.env),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
    },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: repositoryGitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (run.exitedDueToTimeout)
    throw new RepositoryPinRefusal(
      "repository_git_failed",
      `git ${args.join(" ")} did not finish within ${repositoryGitMilliseconds} ms in ${repository}.`,
      `Run git ${args.join(" ")} in ${repository} to see where it waits, then run pin-move again.`,
    );
  return {
    ok: run.exitCode === 0,
    code: run.exitCode,
    stdout: run.stdout.toString(),
    said: run.stderr.toString().trim().split("\n")[0] ?? "",
  };
}

export function requireRepositoryGit(
  repository: string,
  args: readonly string[],
  repair: string,
): string {
  const run = repositoryGit(repository, args);
  if (!run.ok)
    throw new RepositoryPinRefusal(
      "repository_git_failed",
      `git ${args.join(" ")} failed in ${repository}: git says "${run.said}".`,
      repair,
    );
  return run.stdout;
}

export function commitPinMoveBranch(
  repository: string,
  branch: string,
  oldCommit: string,
  kernelCommit: string,
  written: readonly string[],
): string {
  requireRepositoryGit(
    repository,
    ["add", "--", ...written],
    `Stage ${written.join(", ")} on branch ${branch} in ${repository} and commit the pin move.`,
  );
  requireRepositoryGit(
    repository,
    [
      "commit",
      "--only",
      "-m",
      `chore(kernel): move kernel Pin from ${oldCommit.slice(0, 7)} to ${kernelCommit.slice(0, 7)}`,
      "--",
      ...written,
    ],
    `Commit the staged pin move on branch ${branch} in ${repository}.`,
  );
  return requireRepositoryGit(
    repository,
    ["rev-parse", "--short", "HEAD"],
    `Check git log on branch ${branch} in ${repository}.`,
  ).trim();
}

export type PinMoveAttempt = {
  readonly repository: string;
  readonly startingRef: string;
  readonly branch: string;
  readonly subject: string;
  readonly edited: readonly string[];
  readonly kernelPackage: string;
  readonly startingPin: string;
  readonly active: TrialActive;
};

export function attemptPaths(repository: string, edited: readonly string[]) {
  const paths = [...edited];
  if (lstatSync(join(repository, "bun.lock"), { throwIfNoEntry: false }))
    paths.push("bun.lock");
  return paths.sort();
}

function leftOver(repository: string): string {
  const status = repositoryGit(repository, [
    "status",
    "--porcelain",
    "--untracked-files=all",
  ]);
  if (!status.ok) return ` git status then failed in ${repository}.`;
  const paths = status.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => line.slice(3));
  return paths.length === 0
    ? ""
    : ` git status in ${repository} still lists ${paths.join(", ")}; remove them too.`;
}

function installedKernelCommit(attempt: PinMoveAttempt): string {
  const tag = join(
    attempt.repository,
    "node_modules",
    attempt.kernelPackage,
    ".bun-tag",
  );
  let text: string;
  try {
    text = readFileSync(tag, "utf8").trim();
  } catch {
    return "not installed";
  }
  return /([0-9a-f]{7,40})$/.exec(text)?.[1] ?? `"${text}"`;
}

// Platform: git does not track node_modules, so checking out the starting
// branch leaves the kernel the attempt's bun install wrote there.
async function restoreInstalledKernel(
  attempt: PinMoveAttempt,
): Promise<string | undefined> {
  const { repository, startingRef, startingPin, kernelPackage } = attempt;
  try {
    await trialStep(
      repository,
      "frozen install",
      ["install", "--frozen-lockfile"],
      restoreInstallMilliseconds,
      attempt.active,
    );
  } catch (error) {
    const said = error instanceof Error ? error.message : String(error);
    return `bun install --frozen-lockfile on ${startingRef} failed: ${said.split(" Repair: ")[0]}`;
  }
  const installed = installedKernelCommit(attempt);
  return startingPin.startsWith(installed)
    ? undefined
    : `the installed ${kernelPackage} is ${installed}, not ${startingPin}, the Pin on ${startingRef}.`;
}

async function keptAttemptRefusal(
  attempt: PinMoveAttempt,
  code: string,
  reason: string,
  installRan: boolean,
): Promise<RepositoryPinRefusal> {
  const { repository, startingRef, branch } = attempt;
  const reinstall = installRan
    ? ` Run bun install --frozen-lockfile in ${repository} once ${startingRef} is checked out.`
    : "";
  const paths = attemptPaths(repository, attempt.edited);
  const staged = repositoryGit(repository, ["add", "--", ...paths]);
  const committed = staged.ok
    ? repositoryGit(repository, [
        "commit",
        "--no-verify",
        "--allow-empty",
        "--only",
        "-m",
        `${attempt.subject} (${code})`,
        "-m",
        reason,
        "--",
        ...paths,
      ])
    : staged;
  if (!committed.ok)
    return new RepositoryPinRefusal(
      code,
      `${reason} pin-move could not commit the failed attempt on branch ${branch}: git says "${committed.said}". Branch ${branch} is still checked out with uncommitted edits to ${paths.join(", ")}; ${startingRef} was not changed.`,
      `In ${repository}, set the edits aside (git stash --include-untracked) or discard them, then git checkout ${startingRef} && git branch -D ${branch}, and run pin-move again.${reinstall}`,
    );
  const back = repositoryGit(repository, ["checkout", startingRef]);
  if (!back.ok)
    return new RepositoryPinRefusal(
      code,
      `${reason} The failed attempt is committed on branch ${branch}, but git checkout ${startingRef} failed: git says "${back.said}". Branch ${branch} is still checked out; ${startingRef} was not changed.`,
      `Run git checkout ${startingRef} in ${repository}, delete the failed attempt with git branch -D ${branch}, then run pin-move again.${reinstall}`,
    );
  const unrestored = installRan
    ? await restoreInstalledKernel(attempt)
    : undefined;
  if (unrestored !== undefined)
    return new RepositoryPinRefusal(
      code,
      `${reason} The failed attempt is kept on branch ${branch} for inspection and ${startingRef} is checked out again, but its installed packages may still hold the failed attempt's kernel: ${unrestored}`,
      `Run bun install --frozen-lockfile in ${repository}, then delete the failed attempt with git branch -D ${branch} before running pin-move again.${leftOver(repository)}`,
    );
  return new RepositoryPinRefusal(
    code,
    `${reason} The failed attempt is kept on branch ${branch} for inspection; ${startingRef} is checked out again and was not changed.`,
    `Delete the failed attempt with git branch -D ${branch} in ${repository} before running pin-move again.${leftOver(repository)}`,
  );
}

export async function failedAttempt(
  attempt: PinMoveAttempt,
  error: unknown,
  installRan: boolean,
): Promise<Error> {
  if (error instanceof RepositoryPinRefusal)
    return keptAttemptRefusal(attempt, error.code, error.reason, installRan);
  const kept = await keptAttemptRefusal(
    attempt,
    "error",
    error instanceof Error ? error.message : String(error),
    installRan,
  );
  return new Error(kept.message, { cause: error });
}
