import {
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { clonePin, generatedPin, type KernelPin } from "../src/kernel-pin.ts";
import {
  git,
  type KernelSeam,
  openCommit,
  readKernel,
} from "../src/kernel-reader.ts";
import { SKILL_FOLDER } from "../src/recipe.ts";
import { type TrialActive, TrialRefusal, trialStep } from "./kernel-trial.ts";
import { pinMoveReport, pinMoveReportText } from "./pin-move-report.ts";
import {
  attemptPaths,
  commitPinMoveBranch,
  failedAttempt,
  type PinMoveAttempt,
  RepositoryPinRefusal,
  repositoryGit,
  requireRepositoryGit,
} from "./pin-move-branch.ts";

const repositoryInstallMilliseconds = 120_000;
const repositoryCheckMilliseconds = 240_000;

function requireCleanWorkTree(repository: string): void {
  const status = requireRepositoryGit(
    repository,
    ["status", "--porcelain", "--untracked-files=all"],
    `Run git status in ${repository} and resolve any git error before running pin-move again.`,
  );
  if (status.trim() !== "")
    throw new RepositoryPinRefusal(
      "repository_dirty",
      `Repository at ${repository} has uncommitted or untracked changes.`,
      `Commit, stash, or remove local changes in ${repository} so git status is clean, then run pin-move again.`,
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
    `Check out a branch such as main in ${repository}, then run pin-move again.`,
  );
}

function openGeneratedRepository(
  givenPath: string,
  requireClean: boolean,
): { readonly repository: string; readonly startingRef: string } {
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
        `Replace the symbolic link at ${relativePath} in ${repository} with a plain ${kind}, commit it, and run pin-move again.`,
      );
    const expectedDirectory = !isLast || kind === "directory";
    if (expectedDirectory ? !stats.isDirectory() : !stats.isFile())
      throw new RepositoryPinRefusal(
        "repository_invalid",
        `${relativePath} in ${repository} is not a plain ${kind}.`,
        `Restore ${relativePath} in ${repository} as a plain ${kind}, commit it, and run pin-move again.`,
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
      `Set dependencies["${pin.repository}"] in ${manifestPath} to ${generatedPin(pin, pin.commit)} and commit it before running pin-move.`,
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

type PlannedEdit = { readonly path: string; readonly text: string };

function plannedPackagePin(
  repository: string,
  record: RepositoryPinRecord,
  packageName: string,
): PlannedEdit {
  const manifestPath = requirePlainEntry(repository, "package.json", "file");
  const parsed: unknown = JSON.parse(record.packageText);
  const deps = ownPropertyValue(parsed, "dependencies");
  if (typeof deps !== "object" || deps === null || Array.isArray(deps))
    throw new RepositoryPinRefusal(
      "repository_pin_missing",
      `${manifestPath} has no dependencies object.`,
      `Restore dependencies["${packageName}"] in ${manifestPath}, commit it, and run pin-move again.`,
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
      `Write dependencies["${packageName}"] in ${manifestPath} by hand and run pin-move again.`,
    );
  return { path: "package.json", text: updated };
}

function frontmatterLine(text: string, label: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)?.[1];
  if (block === undefined) return undefined;
  return new RegExp(`^${label}: (.*)$`, "m").exec(block)?.[1];
}

function replaceFrontmatterLine(
  text: string,
  label: string,
  value: string,
): string {
  return text.replace(/^---\r?\n([\s\S]*?)\r?\n---(?=\r?\n|$)/, (block) =>
    block.replace(
      new RegExp(`^${label}: .*$`, "m"),
      () => `${label}: ${value}`,
    ),
  );
}

function syncPointerSkill(
  text: string,
  kernelRepository: string,
  kernelCommit: string,
  skillRelPath: string,
): string {
  let next = text.replace(
    /^Pinned commit: `[^`\n]*`$/m,
    () => `Pinned commit: \`${kernelCommit}\``,
  );
  const full = git(kernelRepository, "cat-file", [
    "-p",
    `${kernelCommit}:${skillRelPath}`,
  ]);
  if (!full.ok) return next;
  const fullText = full.stdout.toString("utf8");
  for (const label of ["name", "description"] as const) {
    const expected = frontmatterLine(fullText, label);
    if (expected !== undefined)
      next = replaceFrontmatterLine(next, label, expected);
  }
  return next;
}

function plannedPointerSkills(
  repository: string,
  kernelRepository: string,
  kernelCommit: string,
  packageName: string,
): PlannedEdit[] {
  const folder = join(repository, SKILL_FOLDER);
  if (!existsSync(folder)) return [];
  requirePlainEntry(repository, SKILL_FOLDER, "directory");
  const installedPrefix = `node_modules/${packageName}/`;
  const planned: PlannedEdit[] = [];
  for (const name of readdirSync(folder).sort()) {
    const relativeSkill = `${SKILL_FOLDER}/${name}/SKILL.md`;
    const skillDir = join(folder, name);
    if (!existsSync(join(skillDir, "SKILL.md"))) continue;
    const file = requirePlainEntry(repository, relativeSkill, "file");
    const text = readFileSync(file, "utf8");
    const fullSkill = /^Full skill: `([^`\n]+)`$/m.exec(text)?.[1];
    if (fullSkill === undefined || !fullSkill.startsWith(installedPrefix))
      continue;
    const next = syncPointerSkill(
      text,
      kernelRepository,
      kernelCommit,
      fullSkill.slice(installedPrefix.length),
    );
    if (next !== text) planned.push({ path: relativeSkill, text: next });
  }
  return planned;
}

function planRepositoryEdits(
  repository: string,
  kernelRepository: string,
  kernelCommit: string,
  pin: KernelPin,
  current: RepositoryPinRecord,
): PlannedEdit[] {
  if (lstatSync(join(repository, "bun.lock"), { throwIfNoEntry: false }))
    requirePlainEntry(repository, "bun.lock", "file");
  return [
    plannedPackagePin(repository, current, pin.repository),
    ...plannedPointerSkills(
      repository,
      kernelRepository,
      kernelCommit,
      pin.repository,
    ),
  ];
}

async function runRepositoryCheckSteps(
  repository: string,
  branch: string,
  active: TrialActive,
): Promise<void> {
  const steps: readonly (readonly [string, readonly string[], number])[] = [
    ["install", ["install"], repositoryInstallMilliseconds],
    [
      "frozen install",
      ["install", "--frozen-lockfile"],
      repositoryInstallMilliseconds,
    ],
    ["check command", ["run", "check"], repositoryCheckMilliseconds],
  ];
  for (const [name, args, limit] of steps) {
    try {
      await trialStep(repository, name, args, limit, active);
    } catch (error) {
      if (error instanceof TrialRefusal && error.code === "trial_failed") {
        const detail = error.message.split(" Repair: ")[0] ?? error.message;
        throw new RepositoryPinRefusal(
          "repository_check_failed",
          `${name} failed on branch ${branch} in ${repository}: ${detail}`,
          `Fix the failure ${name} reports, then run pin-move again.`,
        );
      }
      if (error instanceof TrialRefusal && error.code === "trial_stopped") {
        throw new RepositoryPinRefusal(
          "trial_stopped",
          `Pin move in ${repository} was stopped by ${active.stoppedBy ?? "a signal"} during ${name} on branch ${branch}.`,
          "Run pin-move again when it can run to its end.",
        );
      }
      throw error;
    }
  }
}

function createPinMoveBranch(repository: string, kernelCommit: string): string {
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
      `Inspect or remove branch ${branch} in ${repository} (git branch -D ${branch}), then run pin-move again.`,
    );
  requireRepositoryGit(
    repository,
    ["checkout", "-b", branch],
    `Resolve why git could not create branch ${branch} in ${repository}, then run pin-move again.`,
  );
  return branch;
}

async function applyRepositoryPinMove(
  repository: string,
  startingRef: string,
  kernelCommit: string,
  current: RepositoryPinRecord,
  edits: readonly PlannedEdit[],
  reportText: string,
  active: TrialActive,
): Promise<number> {
  const branch = createPinMoveBranch(repository, kernelCommit);
  const attempt: PinMoveAttempt = {
    repository,
    startingRef,
    branch,
    subject: `chore(kernel): failed Pin move from ${current.oldCommit.slice(0, 7)} to ${kernelCommit.slice(0, 7)}`,
    edited: edits.map((edit) => edit.path),
  };
  try {
    process.stdout.write(reportText);
    for (const edit of edits)
      writeFileSync(join(repository, edit.path), edit.text);
    await runRepositoryCheckSteps(repository, branch, active);
    const written = attemptPaths(repository, attempt.edited);
    const commit = commitPinMoveBranch(
      repository,
      branch,
      current.oldCommit,
      kernelCommit,
      written,
    );
    process.stdout.write(
      `Moved kernel Pin in ${repository} on branch ${branch} (${commit}):\n${written.map((file) => `  ${file}\n`).join("")}`,
    );
    return 0;
  } catch (error) {
    throw failedAttempt(attempt, error);
  }
}

export async function moveRepositoryPin(
  kernel: KernelSeam,
  pin: KernelPin,
  givenRepository: string,
  planOnly: boolean,
  active: TrialActive,
  verifyTarget: (seam: KernelSeam, pin: KernelPin) => string,
): Promise<number> {
  const { repository, startingRef } = openGeneratedRepository(
    givenRepository,
    !planOnly,
  );
  const kernelRepository = verifyTarget(kernel, pin);
  readKernel(kernel);
  const current = readRepositoryPin(
    repository,
    { repository: kernelRepository, commit: kernel.commit },
    pin,
  );
  openCommit({ repository: kernelRepository, commit: current.oldCommit });
  const reportText = pinMoveReportText(
    pinMoveReport(kernelRepository, current.oldCommit, kernel.commit),
  );
  if (planOnly) {
    process.stdout.write(reportText);
    process.stdout.write(
      `Plan only: no branch or file changed in ${repository}.\n`,
    );
    return 0;
  }
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
  return applyRepositoryPinMove(
    repository,
    startingRef,
    kernel.commit,
    current,
    edits,
    reportText,
    active,
  );
}
