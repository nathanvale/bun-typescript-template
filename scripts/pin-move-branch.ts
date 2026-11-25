import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../src/cli-error.ts";
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
      GIT_LITERAL_PATHSPECS: "1",
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
  oldCommit: string,
  kernelCommit: string,
  written: readonly string[],
): string {
  const status = requireRepositoryGit(
    repository,
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    `Run git status in ${repository} and resolve any git error before running pin-move again.`,
  );
  const { stagedOnly } = parseStatusChanges(status);
  const toAdd = written.filter((path) => !stagedOnly.has(path));
  if (toAdd.length > 0)
    requireRepositoryGit(
      repository,
      ["add", "--", ...toAdd],
      `Fix why git add failed in ${repository} (git's message above), then run pin-move again.`,
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
    `Fix why git commit failed in ${repository} (for example a commit hook or signing; git's message above), then run pin-move again.`,
  );
  return requireRepositoryGit(
    repository,
    ["rev-parse", "--short", "HEAD"],
    `Run git log in ${repository} to see why git rev-parse failed, then run pin-move again.`,
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
  readonly regenerate: boolean;
  readonly active: TrialActive;
};

export function attemptPaths(
  repository: string,
  edited: readonly string[],
  regenerated: readonly string[] = [],
) {
  const paths = new Set([...edited, ...regenerated]);
  if (lstatSync(join(repository, "bun.lock"), { throwIfNoEntry: false }))
    paths.add("bun.lock");
  return [...paths].sort();
}

export function parseStatusChanges(stdout: string): {
  readonly all: readonly string[];
  readonly stagedOnly: ReadonlySet<string>;
} {
  const entries = stdout.split("\0");
  const all = new Set<string>();
  const needsAdd = new Set<string>();
  const maybeStagedOnly = new Set<string>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    const x = entry[0];
    const y = entry[1];
    const path = entry.slice(3);
    all.add(path);
    if (y !== " ") needsAdd.add(path);
    else maybeStagedOnly.add(path);
    if (x === "R" || x === "C" || y === "R" || y === "C") {
      index += 1;
      const oldPath = entries[index];
      if (oldPath) {
        all.add(oldPath);
        maybeStagedOnly.add(oldPath);
      }
    }
  }
  const stagedOnly = new Set(
    [...maybeStagedOnly].filter((path) => !needsAdd.has(path)),
  );
  return { all: [...all].sort(), stagedOnly };
}

export function changedPaths(repository: string): readonly string[] {
  const status = requireRepositoryGit(
    repository,
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    `Run git status in ${repository} and resolve any git error before running pin-move again.`,
  );
  return parseStatusChanges(status).all;
}

function safeRepositoryGit(
  repository: string,
  args: readonly string[],
  runGit: typeof repositoryGit = repositoryGit,
) {
  try {
    return runGit(repository, args);
  } catch (error) {
    const said =
      error instanceof RepositoryPinRefusal
        ? error.reason
        : error instanceof Error
          ? error.message
          : String(error);
    return { ok: false, code: null, stdout: "", said };
  }
}

function failedAttemptPaths(
  attempt: PinMoveAttempt,
  runGit: typeof repositoryGit,
): {
  readonly paths: readonly string[];
  readonly stagedOnly: ReadonlySet<string>;
} {
  const status = safeRepositoryGit(
    attempt.repository,
    ["status", "--porcelain", "-z", "--untracked-files=all"],
    runGit,
  );
  const parsed = status.ok
    ? parseStatusChanges(status.stdout)
    : { all: [], stagedOnly: new Set<string>() };
  return {
    paths: attemptPaths(
      attempt.repository,
      attempt.edited,
      attempt.regenerate ? parsed.all : [],
    ),
    stagedOnly: parsed.stagedOnly,
  };
}

function keepFailedAttempt(
  repository: string,
  branch: string,
  runGit: typeof repositoryGit,
): { readonly kept: string; readonly unrenamed: string } {
  const head = safeRepositoryGit(
    repository,
    ["rev-parse", "--short", "HEAD"],
    runGit,
  );
  const wanted = `${branch}-failed-${head.stdout.trim()}`;
  const renamed = head.ok
    ? safeRepositoryGit(repository, ["branch", "-m", branch, wanted], runGit)
    : head;
  if (renamed.ok) return { kept: wanted, unrenamed: "" };
  return {
    kept: branch,
    unrenamed: ` pin-move could not rename branch ${branch} to ${wanted}: git says "${renamed.said}". Rename it with git branch -m ${branch} <an unused branch name> in ${repository} before running pin-move again.`,
  };
}

function leftOver(repository: string, runGit: typeof repositoryGit): string {
  const status = safeRepositoryGit(
    repository,
    ["status", "--porcelain", "--untracked-files=all"],
    runGit,
  );
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
  repair: string,
  installRan: boolean,
  runGit: typeof repositoryGit,
): Promise<RepositoryPinRefusal> {
  const { repository, startingRef, branch } = attempt;
  const reinstall = installRan
    ? ` Run bun install --frozen-lockfile in ${repository} once ${startingRef} is checked out.`
    : "";
  const { paths, stagedOnly } = failedAttemptPaths(attempt, runGit);
  const toAdd = paths.filter((path) => !stagedOnly.has(path));
  const staged =
    toAdd.length > 0
      ? safeRepositoryGit(repository, ["add", "--", ...toAdd], runGit)
      : { ok: true, code: 0, stdout: "", said: "" };
  const committed = staged.ok
    ? safeRepositoryGit(
        repository,
        [
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
        ],
        runGit,
      )
    : staged;
  if (!committed.ok)
    return new RepositoryPinRefusal(
      code,
      `${reason} pin-move could not commit the failed attempt on branch ${branch}: git says "${committed.said}". Branch ${branch} is still checked out with uncommitted edits to ${paths.join(", ")}; ${startingRef} was not changed.`,
      `In ${repository}, discard pin-move's edits to ${paths.join(", ")} until git status is clean, then git checkout ${startingRef} && git branch -d ${branch}, and run pin-move again.${reinstall}`,
    );
  const { kept, unrenamed } = keepFailedAttempt(repository, branch, runGit);
  const back = safeRepositoryGit(repository, ["checkout", startingRef], runGit);
  if (!back.ok)
    return new RepositoryPinRefusal(
      code,
      `${reason} The failed attempt is committed on branch ${kept}, but git checkout ${startingRef} failed: git says "${back.said}". Branch ${kept} is still checked out; ${startingRef} was not changed.`,
      `Run git checkout ${startingRef} in ${repository}, then run pin-move again.${unrenamed}${reinstall}`,
    );
  const unrestored = installRan
    ? await restoreInstalledKernel(attempt)
    : undefined;
  if (unrestored !== undefined)
    return new RepositoryPinRefusal(
      code,
      `${reason} The failed attempt is kept on branch ${kept} for inspection and ${startingRef} is checked out again, but its installed packages may still hold the failed attempt's kernel: ${unrestored}`,
      `Run bun install --frozen-lockfile in ${repository} before running pin-move again.${unrenamed}${leftOver(repository, runGit)}`,
    );
  return new RepositoryPinRefusal(
    code,
    `${reason} The failed attempt is kept on branch ${kept} for inspection; ${startingRef} is checked out again and was not changed.`,
    `${repair}${unrenamed}${leftOver(repository, runGit)}`,
  );
}

export async function failedAttempt(
  attempt: PinMoveAttempt,
  error: unknown,
  installRan: boolean,
  runGit: typeof repositoryGit = repositoryGit,
): Promise<Error> {
  if (error instanceof RepositoryPinRefusal)
    return keptAttemptRefusal(
      attempt,
      error.code,
      error.reason,
      error.repair,
      installRan,
      runGit,
    );
  if (error instanceof CliError)
    return keptAttemptRefusal(
      attempt,
      error.code,
      error.message,
      error.repair,
      installRan,
      runGit,
    );
  const kept = await keptAttemptRefusal(
    attempt,
    "error",
    error instanceof Error ? error.message : String(error),
    "Fix the error above, then run pin-move again.",
    installRan,
    runGit,
  );
  return new Error(kept.message, { cause: error });
}
