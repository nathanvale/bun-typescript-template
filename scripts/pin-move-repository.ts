import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
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
import { withoutRepositoryLocation } from "./process-runner.ts";

const repositoryGitMilliseconds = 20_000;
const repositoryInstallMilliseconds = 120_000;
const repositoryCheckMilliseconds = 240_000;

export class RepositoryPinRefusal extends Error {
  constructor(
    readonly code: string,
    cause: string,
    readonly repair: string,
  ) {
    super(`${cause} Repair: ${repair}`);
  }
}

function repositoryGit(repository: string, args: readonly string[]) {
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

function requireRepositoryGit(
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
  if (!existsSync(givenPath) || !statSync(givenPath).isDirectory())
    throw invalid("that path is not an existing folder.");
  const repository = realpathSync(givenPath);
  requireGitWorkTreeRoot(repository, invalid);
  if (requireClean) requireCleanWorkTree(repository);
  const branch = repositoryGit(repository, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "HEAD",
  ]);
  return {
    repository,
    startingRef: branch.ok ? branch.stdout.trim() : "HEAD",
  };
}

function ownPropertyValue(target: unknown, key: string): unknown {
  return typeof target === "object" && target !== null
    ? Object.getOwnPropertyDescriptor(target, key)?.value
    : undefined;
}

type RepositoryPinRecord = {
  readonly oldCommit: string;
  readonly currentSpecifier: string;
  readonly nextSpecifier: string;
  readonly packageText: string;
};

function readManifestSpecifier(
  manifestPath: string,
  packageName: string,
  missing: (why: string) => RepositoryPinRefusal,
): { readonly packageText: string; readonly specifier: string } {
  if (!existsSync(manifestPath)) throw missing("package.json is missing.");
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
    manifestPath,
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

function writeRepositoryPackagePin(
  repository: string,
  record: RepositoryPinRecord,
  packageName: string,
): string {
  const manifestPath = join(repository, "package.json");
  const quotedOld = JSON.stringify(record.currentSpecifier);
  const quotedNew = JSON.stringify(record.nextSpecifier);
  const pattern = new RegExp(
    `("${packageName}"\\s*:\\s*)${quotedOld.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`,
  );
  if (!pattern.test(record.packageText))
    throw new RepositoryPinRefusal(
      "repository_pin_missing",
      `${manifestPath} does not contain a replaceable "${packageName}" dependency line.`,
      `Write "${packageName}": ${quotedOld} in ${manifestPath}, commit it, and run pin-move again.`,
    );
  writeFileSync(
    manifestPath,
    record.packageText.replace(pattern, `$1${quotedNew}`),
  );
  return "package.json";
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
    block.replace(new RegExp(`^${label}: .*$`, "m"), `${label}: ${value}`),
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
    `Pinned commit: \`${kernelCommit}\``,
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

function updatePointerSkills(
  repository: string,
  kernelRepository: string,
  kernelCommit: string,
  packageName: string,
): string[] {
  const folder = join(repository, SKILL_FOLDER);
  if (!existsSync(folder)) return [];
  const installedPrefix = `node_modules/${packageName}/`;
  const written: string[] = [];
  for (const name of readdirSync(folder).sort()) {
    const file = join(folder, name, "SKILL.md");
    if (!existsSync(file) || !statSync(file).isFile()) continue;
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
    if (next !== text) {
      writeFileSync(file, next);
      written.push(`${SKILL_FOLDER}/${name}/SKILL.md`);
    }
  }
  return written;
}

async function runRepositoryCheckSteps(
  repository: string,
  branch: string,
  startingRef: string,
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
          `${name} failed on branch ${branch} in ${repository}: ${detail} Branch ${branch} was left checked out for inspection; ${startingRef} was not changed.`,
          `Inspect the failure on branch ${branch} in ${repository}, fix it, run bun run check, and commit, or switch back to ${startingRef} and delete ${branch}.`,
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

function commitPinMoveBranch(
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
      "-m",
      `chore(kernel): move kernel Pin from ${oldCommit.slice(0, 7)} to ${kernelCommit.slice(0, 7)}`,
    ],
    `Commit the staged pin move on branch ${branch} in ${repository}.`,
  );
  return requireRepositoryGit(
    repository,
    ["rev-parse", "--short", "HEAD"],
    `Check git log on branch ${branch} in ${repository}.`,
  ).trim();
}

async function applyRepositoryPinMove(
  repository: string,
  startingRef: string,
  kernelRepository: string,
  kernelCommit: string,
  pin: KernelPin,
  current: RepositoryPinRecord,
  reportText: string,
  active: TrialActive,
): Promise<number> {
  const branch = createPinMoveBranch(repository, kernelCommit);
  process.stdout.write(reportText);
  const written = [
    writeRepositoryPackagePin(repository, current, pin.repository),
    ...updatePointerSkills(
      repository,
      kernelRepository,
      kernelCommit,
      pin.repository,
    ),
  ];
  await runRepositoryCheckSteps(repository, branch, startingRef, active);
  if (existsSync(join(repository, "bun.lock"))) written.push("bun.lock");
  written.sort();
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
  return applyRepositoryPinMove(
    repository,
    startingRef,
    kernelRepository,
    kernel.commit,
    pin,
    current,
    reportText,
    active,
  );
}
