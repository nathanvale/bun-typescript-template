import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  type TrialActive,
  TrialRefusal,
  trialStep,
} from "../scripts/kernel-trial.ts";
import {
  type PinMoveReport,
  pinMoveReport,
  pinMoveReportText,
} from "../scripts/pin-move-report.ts";
import { withoutRepositoryLocation } from "../scripts/process-runner.ts";
import { clonePin, generatedPin, type KernelPin } from "./kernel-pin.ts";
import { type KernelSeam, openCommit, readKernel } from "./kernel-reader.ts";
import {
  attemptPaths,
  changedPaths,
  commitPinMoveBranch,
  failedAttempt,
  type PinMoveAttempt,
  RepositoryPinRefusal,
  repositoryGit,
  requireRepositoryGit,
} from "./pin-move-branch.ts";
import {
  type PinMoveFile,
  pointerSkillFiles,
} from "./pin-move-pointer-skills.ts";
import { REGENERATE_SCRIPT } from "./recipe.ts";
import {
  planRepositoryChangeset,
  writeRepositoryChangeset,
} from "./template-upgrade-changeset-write.ts";

const repositoryInstallMilliseconds = 120_000;
const repositoryCheckMilliseconds = 240_000;

export type RepositoryPinMoveOutcome =
  | {
      readonly planOnly: true;
      readonly repository: string;
      readonly from: string;
      readonly to: string;
      readonly report: PinMoveReport;
      readonly reportText: string;
      readonly changeset?: {
        readonly path: string;
        readonly level: string;
        readonly summary: string;
      };
      readonly message: string;
    }
  | {
      readonly planOnly: false;
      readonly repository: string;
      readonly from: string;
      readonly to: string;
      readonly branch: string;
      readonly commit: string;
      readonly written: readonly string[];
      readonly report: PinMoveReport;
      readonly reportText: string;
      readonly message: string;
    };

function requireCleanWorkTree(repository: string): void {
  const status = requireRepositoryGit(
    repository,
    ["status", "--porcelain", "--untracked-files=all"],
    `Run git status in ${repository} and resolve any git error before running bun run pin:move again.`,
  );
  if (status.trim() !== "")
    throw new RepositoryPinRefusal(
      "repository_dirty",
      `Repository at ${repository} has uncommitted or untracked changes.`,
      `Commit or remove local changes in ${repository} so git status is clean, then run bun run pin:move again.`,
    );
}

function requireGitWorkTreeRoot(
  repository: string,
  invalid: (why: string) => RepositoryPinRefusal,
): void {
  const inside = repositoryGit(repository, [
    "rev-parse",
    "--is-inside-work-tree",
  ]);
  if (!inside.ok || inside.stdout.trim() !== "true")
    throw invalid("it is not a git working tree.");
  const prefix = repositoryGit(repository, ["rev-parse", "--show-prefix"]);
  if (!prefix.ok || prefix.stdout.slice(0, -1) !== "")
    throw invalid("that folder is inside the repository above it.");
  if (!repositoryGit(repository, ["rev-parse", "--verify", "HEAD"]).ok)
    throw invalid("HEAD has no commit yet.");
}

function requireStartingBranch(
  repository: string,
  requireAttached: boolean,
): string {
  const branch = repositoryGit(repository, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  if (branch.ok) return branch.stdout.trim();
  if (!requireAttached) return "HEAD";
  throw new RepositoryPinRefusal(
    "repository_invalid",
    `Repository at ${repository} is on a detached HEAD.`,
    `Check out a branch such as main in ${repository}, then run bun run pin:move again.`,
  );
}

function resolveGeneratedRepository(givenPath: string): string {
  const invalid = (why: string) =>
    new RepositoryPinRefusal(
      "repository_invalid",
      `No generated git repository is at ${givenPath}: ${why}`,
      "Give the root folder of a clean git checkout created from this template.",
    );
  if (!existsSync(givenPath) || !lstatSync(givenPath).isDirectory())
    throw invalid("that path is not an existing folder.");
  const repository = realpathSync(givenPath);
  requireGitWorkTreeRoot(repository, invalid);
  return repository;
}

function openGeneratedRepository(
  givenPath: string,
  requireClean: boolean,
): { readonly repository: string; readonly startingRef: string } {
  const repository = resolveGeneratedRepository(givenPath);
  const startingRef = requireStartingBranch(repository, requireClean);
  if (requireClean) requireCleanWorkTree(repository);
  return { repository, startingRef };
}

function ownPropertyValue(target: unknown, key: string): unknown {
  return typeof target === "object" && target !== null
    ? Object.getOwnPropertyDescriptor(target, key)?.value
    : undefined;
}

function requirePlainEntry(
  repository: string,
  relativePath: string,
  kind: "file" | "directory",
): string {
  const segments = relativePath.split("/").filter((part) => part !== "");
  let current = repository;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = lstatSync(current);
    const isLast = index === segments.length - 1;
    if (stats.isSymbolicLink())
      throw new RepositoryPinRefusal(
        "repository_invalid",
        `${relativePath} in ${repository} traverses a symbolic link.`,
        `Replace the symbolic link at ${relativePath} in ${repository} with a plain ${kind}, commit it, and run bun run pin:move again.`,
      );
    const expectedDirectory = !isLast || kind === "directory";
    if (expectedDirectory ? !stats.isDirectory() : !stats.isFile())
      throw new RepositoryPinRefusal(
        "repository_invalid",
        `${relativePath} in ${repository} is not a plain ${kind}.`,
        `Restore ${relativePath} in ${repository} as a plain ${kind}, commit it, and run bun run pin:move again.`,
      );
  }
  return current;
}

type RepositoryPinRecord = {
  readonly oldCommit: string;
  readonly currentSpecifier: string;
  readonly nextSpecifier: string;
  readonly packageText: string;
};

function readManifestSpecifier(
  repository: string,
  packageName: string,
  missing: (why: string) => RepositoryPinRefusal,
): { readonly packageText: string; readonly specifier: string } {
  const manifestPath = join(repository, "package.json");
  if (!existsSync(manifestPath)) throw missing("package.json is missing.");
  requirePlainEntry(repository, "package.json", "file");
  const packageText = readFileSync(manifestPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(packageText);
  } catch {
    throw missing("package.json is not valid JSON.");
  }
  const specifier = ownPropertyValue(
    ownPropertyValue(parsed, "dependencies"),
    packageName,
  );
  if (typeof specifier !== "string")
    throw missing(`dependencies["${packageName}"] is missing.`);
  return { packageText, specifier };
}

function readRepositoryPin(
  repository: string,
  kernel: KernelSeam,
  pin: KernelPin,
): RepositoryPinRecord {
  const manifestPath = join(repository, "package.json");
  const missing = (why: string) =>
    new RepositoryPinRefusal(
      "repository_pin_missing",
      `${manifestPath} pins no valid ${pin.repository} commit: ${why}`,
      `Set dependencies["${pin.repository}"] in ${manifestPath} to ${generatedPin(pin, pin.commit)} and commit it before running bun run pin:move.`,
    );
  const { packageText, specifier } = readManifestSpecifier(
    repository,
    pin.repository,
    missing,
  );
  const oldCommit = /#([0-9a-f]{40})$/.exec(specifier)?.[1];
  if (oldCommit === undefined)
    throw missing(`"${specifier}" does not end in a full 40-character commit.`);
  if (specifier === generatedPin(pin, oldCommit))
    return {
      oldCommit,
      currentSpecifier: specifier,
      nextSpecifier: generatedPin(pin, kernel.commit),
      packageText,
    };
  if (
    specifier === clonePin({ repository: kernel.repository, commit: oldCommit })
  )
    return {
      oldCommit,
      currentSpecifier: specifier,
      nextSpecifier: clonePin(kernel),
      packageText,
    };
  throw missing(
    `"${specifier}" does not match ${generatedPin(pin, oldCommit)} or the given kernel clone.`,
  );
}

function plannedPackagePin(
  repository: string,
  record: RepositoryPinRecord,
  packageName: string,
): PinMoveFile {
  const manifestPath = requirePlainEntry(repository, "package.json", "file");
  const parsed: unknown = JSON.parse(record.packageText);
  const deps = ownPropertyValue(parsed, "dependencies");
  if (typeof deps !== "object" || deps === null || Array.isArray(deps))
    throw new RepositoryPinRefusal(
      "repository_pin_missing",
      `${manifestPath} has no dependencies object.`,
      `Restore dependencies["${packageName}"] in ${manifestPath}, commit it, and run bun run pin:move again.`,
    );
  Reflect.set(deps, packageName, record.nextSpecifier);
  const updated = `${JSON.stringify(parsed, null, 2)}\n`;
  if (
    ownPropertyValue(
      ownPropertyValue(JSON.parse(updated), "dependencies"),
      packageName,
    ) !== record.nextSpecifier
  )
    throw new RepositoryPinRefusal(
      "repository_pin_missing",
      `${manifestPath} could not record dependencies["${packageName}"].`,
      `Write dependencies["${packageName}"] in ${manifestPath} by hand and run bun run pin:move again.`,
    );
  return { path: "package.json", text: updated };
}

function planRepositoryEdits(
  repository: string,
  kernelRepository: string,
  kernelCommit: string,
  pin: KernelPin,
  current: RepositoryPinRecord,
): PinMoveFile[] {
  if (lstatSync(join(repository, "bun.lock"), { throwIfNoEntry: false }))
    requirePlainEntry(repository, "bun.lock", "file");
  return [
    plannedPackagePin(repository, current, pin.repository),
    ...pointerSkillFiles(
      repository,
      kernelRepository,
      kernelCommit,
      pin.repository,
      requirePlainEntry,
    ),
  ];
}

function declaresRegenerate(packageText: string): boolean {
  const scripts = ownPropertyValue(JSON.parse(packageText), "scripts");
  return typeof ownPropertyValue(scripts, REGENERATE_SCRIPT) === "string";
}

type CheckStep = readonly [string, readonly string[], number];

const installSteps: readonly CheckStep[] = [
  ["install", ["install"], repositoryInstallMilliseconds],
  [
    "frozen install",
    ["install", "--frozen-lockfile"],
    repositoryInstallMilliseconds,
  ],
];

async function runRepositoryCheckSteps(
  repository: string,
  branch: string,
  active: TrialActive,
  regenerate: boolean,
): Promise<readonly string[]> {
  await runCheckSteps(repository, branch, active, [
    ...installSteps,
    ...(regenerate
      ? [
          [
            REGENERATE_SCRIPT,
            ["run", REGENERATE_SCRIPT],
            repositoryCheckMilliseconds,
          ] as const,
        ]
      : []),
  ]);
  const regenerated = regenerate ? changedPaths(repository) : [];
  await runCheckSteps(repository, branch, active, [
    ["check command", ["run", "check"], repositoryCheckMilliseconds],
  ]);
  return regenerated;
}

async function runCheckSteps(
  repository: string,
  branch: string,
  active: TrialActive,
  steps: readonly CheckStep[],
): Promise<void> {
  for (const [name, args, limit] of steps) {
    try {
      await trialStep(repository, name, args, limit, active);
    } catch (error) {
      if (error instanceof TrialRefusal && error.code === "trial_failed") {
        const detail = error.message.split(" Repair: ")[0] ?? error.message;
        throw new RepositoryPinRefusal(
          "repository_check_failed",
          `${name} failed on branch ${branch} in ${repository}: ${detail}`,
          `Fix the failure ${name} reports, then run bun run pin:move again.`,
        );
      }
      if (error instanceof TrialRefusal && error.code === "trial_stopped") {
        throw new RepositoryPinRefusal(
          "trial_stopped",
          `Pin move in ${repository} was stopped by ${active.stoppedBy ?? "a signal"} during ${name} on branch ${branch}.`,
          "Run bun run pin:move again when it can run to its end.",
        );
      }
      throw error;
    }
  }
}

function requireBranchAbsent(repository: string, kernelCommit: string): string {
  const branch = `pin-move/${kernelCommit.slice(0, 7)}`;
  if (
    repositoryGit(repository, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]).ok
  )
    throw new RepositoryPinRefusal(
      "repository_branch_exists",
      `Branch ${branch} already exists in ${repository}.`,
      `Inspect branch ${branch} in ${repository}: merge it if it holds the Pin move you want, or rename it with git branch -m ${branch} <an unused branch name>, then run bun run pin:move again.`,
    );
  return branch;
}

function createPinMoveBranch(repository: string, kernelCommit: string): string {
  const branch = requireBranchAbsent(repository, kernelCommit);
  requireRepositoryGit(
    repository,
    ["checkout", "-b", branch],
    `Resolve why git could not create branch ${branch} in ${repository}, then run bun run pin:move again.`,
  );
  return branch;
}

function pinMoveChangesetOptions(
  repository: string,
  oldCommit: string,
  kernelCommit: string,
  changedPaths?: readonly string[],
) {
  const old7 = oldCommit.slice(0, 7);
  const new7 = kernelCommit.slice(0, 7);
  return {
    repository,
    worktree: repository,
    fileName: `kernel-pin-${new7}.md`,
    summary: `Moved the kernel Pin from ${old7} to ${new7}`,
    env: withoutRepositoryLocation(process.env),
    ...(changedPaths === undefined ? {} : { changedPaths }),
  };
}

function isTrackedInHead(repository: string, path: string): boolean {
  return repositoryGit(repository, ["cat-file", "-e", `HEAD:${path}`]).ok;
}

async function applyRepositoryPinMove(
  repository: string,
  startingRef: string,
  branch: string,
  kernelCommit: string,
  current: RepositoryPinRecord,
  edits: readonly PinMoveFile[],
  report: PinMoveReport,
  reportText: string,
  active: TrialActive,
  kernelPackage: string,
  quiet: boolean,
): Promise<RepositoryPinMoveOutcome> {
  const editedPaths = edits.map((edit) => edit.path);
  const attempt: PinMoveAttempt = {
    repository,
    startingRef,
    branch,
    subject: `chore(kernel): failed Pin move from ${current.oldCommit.slice(0, 7)} to ${kernelCommit.slice(0, 7)}`,
    edited: editedPaths,
    kernelPackage,
    startingPin: current.oldCommit,
    regenerate: declaresRegenerate(current.packageText),
    active,
  };
  let installRan = false;
  try {
    if (!quiet) process.stdout.write(reportText);
    for (const edit of edits)
      writeFileSync(join(repository, edit.path), edit.text);
    installRan = true;
    const regenerated = await runRepositoryCheckSteps(
      repository,
      branch,
      active,
      attempt.regenerate,
    );
    const changeset = await writeRepositoryChangeset(
      pinMoveChangesetOptions(repository, current.oldCommit, kernelCommit),
    );
    if (changeset !== undefined) {
      editedPaths.push(changeset.path);
      if (
        changeset.createdPath !== undefined &&
        isTrackedInHead(repository, changeset.createdPath)
      ) {
        editedPaths.push(changeset.createdPath);
      }
    }
    const written = attemptPaths(repository, editedPaths, regenerated);
    const commit = commitPinMoveBranch(
      repository,
      current.oldCommit,
      kernelCommit,
      written,
    );
    const summary = `Moved kernel Pin in ${repository} on branch ${branch} (${commit}):\n${written.map((file) => `  ${file}\n`).join("")}`;
    if (!quiet) process.stdout.write(summary);
    return {
      planOnly: false,
      repository,
      from: current.oldCommit,
      to: kernelCommit,
      branch,
      commit,
      written,
      report,
      reportText,
      message: summary.trimEnd(),
    };
  } catch (error) {
    throw await failedAttempt(attempt, error, installRan);
  }
}

async function writePinMovePlan(
  repository: string,
  oldCommit: string,
  kernelCommit: string,
  report: PinMoveReport,
  reportText: string,
  quiet: boolean,
): Promise<RepositoryPinMoveOutcome> {
  const plannedChangeset =
    oldCommit === kernelCommit
      ? undefined
      : await planRepositoryChangeset(
          pinMoveChangesetOptions(repository, oldCommit, kernelCommit, [
            "package.json",
          ]),
        );
  const changesetLine =
    plannedChangeset === undefined
      ? ""
      : `Changeset: ${plannedChangeset.path} (${plannedChangeset.level}, ${plannedChangeset.summary})\n`;
  const planLine = `Plan only: no branch or file changed in ${repository}.`;
  if (!quiet) {
    process.stdout.write(reportText);
    if (changesetLine !== "") process.stdout.write(changesetLine);
  }
  return {
    planOnly: true,
    repository,
    from: oldCommit,
    to: kernelCommit,
    report,
    reportText,
    ...(plannedChangeset === undefined
      ? {}
      : {
          changeset: {
            path: plannedChangeset.path,
            level: plannedChangeset.level,
            summary: plannedChangeset.summary,
          },
        }),
    message: planLine,
  };
}

export type PreparedRepositoryMove = {
  readonly apply: () => Promise<RepositoryPinMoveOutcome>;
};

export async function moveRepositoryPin(
  kernel: KernelSeam,
  pin: KernelPin,
  givenRepository: string,
  planOnly: boolean,
  active: TrialActive,
  verifyTarget: (seam: KernelSeam, pin: KernelPin) => string,
  options: {
    readonly quiet?: boolean;
    readonly runWrite?: (
      repository: string,
      prepare: () => PreparedRepositoryMove,
    ) => Promise<RepositoryPinMoveOutcome>;
  } = {},
): Promise<RepositoryPinMoveOutcome> {
  const quiet = options.quiet === true;
  if (planOnly) {
    const { repository } = openGeneratedRepository(givenRepository, false);
    const kernelRepository = verifyTarget(kernel, pin);
    readKernel(kernel);
    const current = readRepositoryPin(
      repository,
      { repository: kernelRepository, commit: kernel.commit },
      pin,
    );
    openCommit({ repository: kernelRepository, commit: current.oldCommit });
    const report = pinMoveReport(
      kernelRepository,
      current.oldCommit,
      kernel.commit,
    );
    const reportText = pinMoveReportText(report);
    return writePinMovePlan(
      repository,
      current.oldCommit,
      kernel.commit,
      report,
      reportText,
      quiet,
    );
  }
  const runWrite =
    options.runWrite ?? ((_repository, prepare) => prepare().apply());
  const repository = resolveGeneratedRepository(givenRepository);
  const kernelRepository = verifyTarget(kernel, pin);
  readKernel(kernel);
  return runWrite(repository, () => {
    const startingRef = requireStartingBranch(repository, true);
    requireCleanWorkTree(repository);
    const current = readRepositoryPin(
      repository,
      { repository: kernelRepository, commit: kernel.commit },
      pin,
    );
    openCommit({ repository: kernelRepository, commit: current.oldCommit });
    const report = pinMoveReport(
      kernelRepository,
      current.oldCommit,
      kernel.commit,
    );
    const reportText = pinMoveReportText(report);
    if (current.oldCommit === kernel.commit)
      throw new RepositoryPinRefusal(
        "repository_pin_unchanged",
        `Repository at ${repository} already pins ${kernel.commit}.`,
        "Give a different kernel commit to move the pin.",
      );
    const edits = planRepositoryEdits(
      repository,
      kernelRepository,
      kernel.commit,
      pin,
      current,
    );
    requireBranchAbsent(repository, kernel.commit);
    return {
      apply: () => {
        const branch = createPinMoveBranch(repository, kernel.commit);
        return applyRepositoryPinMove(
          repository,
          startingRef,
          branch,
          kernel.commit,
          current,
          edits,
          report,
          reportText,
          active,
          pin.repository,
          quiet,
        );
      },
    };
  });
}
