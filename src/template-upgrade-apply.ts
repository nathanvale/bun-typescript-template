import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "./cli-error.ts";
import { withTemplateUpgradeTrees } from "./template-upgrade-bootstrap.ts";
import {
  lstatIfPresent,
  removeWorktreeIfPresent,
  runGitCommand,
  runGitText,
} from "./template-upgrade-git.ts";
import type { TemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import {
  diffPackageDependencies,
  type PackageDependencyChange,
} from "./template-upgrade-json-merge.ts";
import {
  diffTemplateUpgradeCopyChanges,
  isTemplateUpgradeConflict,
  mergeTemplateUpgradeTrees,
  type TemplateUpgradeCopyChange,
  type TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";
import {
  compareCodeUnits,
  findConflictMarkerFiles,
  readTextIfFile,
  resolveRefIfPresent,
  runBunStep,
  stageAndCommitWorktree,
  templateUpgradeBranchName,
  templateUpgradeCommitMessage,
  templateUpgradeWorktreePaths,
  treesEqual,
} from "./template-upgrade-worktree.ts";

const SCHEMA_VERSION = 1;
const WORKTREE_TIMEOUT_MS = 30_000;
const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 240_000;

export interface TemplateUpgradePlanResult {
  readonly schemaVersion: 1;
  readonly action: "plan";
  readonly status: "up-to-date" | "planned" | "conflicts";
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly rows: readonly TemplateUpgradeRow[];
  readonly conflicts: readonly string[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
}

export type TemplateUpgradeApplyStatus =
  | "up-to-date"
  | "already-done"
  | "applied"
  | "conflicts"
  | "resolution-in-progress"
  | "check-failed";

export interface TemplateUpgradeApplyResult {
  readonly schemaVersion: 1;
  readonly action: "apply";
  readonly status: TemplateUpgradeApplyStatus;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly branch: string;
  readonly commit?: string;
  readonly worktree?: string;
  readonly rows: readonly TemplateUpgradeRow[];
  readonly conflicts: readonly string[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly failedStep?: string;
  readonly checkCommandOutput?: string;
}

export interface TemplateUpgradeApplyRun {
  readonly result: TemplateUpgradeApplyResult;
  readonly exitCode: number;
}

interface ApplySession {
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly commitMessage: string;
  readonly worktreesRoot: string;
  readonly temporaryWorktree: string;
  readonly targetWorktree: string;
  readonly skipCheckCommand: boolean;
  readonly env: Readonly<Record<string, string | undefined>>;
}

interface ApplyMergeData {
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
}

function buildTemplateUpgradeApplyRun(options: {
  readonly exitCode: number;
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly status: TemplateUpgradeApplyStatus;
  readonly commit?: string;
  readonly worktree?: string;
  readonly rows?: readonly TemplateUpgradeRow[];
  readonly conflicts?: readonly string[];
  readonly dependencyChanges?: readonly PackageDependencyChange[];
  readonly templateCopyChanges?: readonly TemplateUpgradeCopyChange[];
  readonly failedStep?: string;
  readonly checkCommandOutput?: string;
}): TemplateUpgradeApplyRun {
  const result: TemplateUpgradeApplyResult = {
    schemaVersion: SCHEMA_VERSION,
    action: "apply",
    status: options.status,
    baseCommit: options.inputs.baseCommit,
    targetCommit: options.inputs.targetCommit,
    branch: options.branch,
    ...(options.commit === undefined ? {} : { commit: options.commit }),
    ...(options.worktree === undefined ? {} : { worktree: options.worktree }),
    rows: options.rows ?? Object.freeze([]),
    conflicts: options.conflicts ?? Object.freeze([]),
    dependencyChanges: options.dependencyChanges ?? Object.freeze([]),
    templateCopyChanges: options.templateCopyChanges ?? Object.freeze([]),
    ...(options.failedStep === undefined
      ? {}
      : { failedStep: options.failedStep }),
    ...(options.checkCommandOutput === undefined
      ? {}
      : { checkCommandOutput: options.checkCommandOutput }),
  };
  return { exitCode: options.exitCode, result: Object.freeze(result) };
}

function gitStdoutIfOk(
  cwd: string,
  args: readonly string[],
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const result = runGitCommand(cwd, args, { env });
  if (result.timedOut || result.exitCode !== 0) {
    return undefined;
  }
  return new TextDecoder("utf-8").decode(result.stdout).trim();
}

async function findCommittedWorktreeHead(
  session: ApplySession,
): Promise<string | undefined> {
  const { inputs, commitMessage, targetWorktree, env } = session;
  const stats = await lstatIfPresent(targetWorktree);
  if (stats === undefined || !stats.isDirectory()) {
    return undefined;
  }
  const worktreeHead = resolveRefIfPresent(targetWorktree, "HEAD", env);
  if (worktreeHead === undefined || worktreeHead === inputs.repositoryHead) {
    return undefined;
  }
  if (
    resolveRefIfPresent(targetWorktree, `${worktreeHead}^`, env) !==
    inputs.repositoryHead
  ) {
    return undefined;
  }
  if (gitStdoutIfOk(targetWorktree, ["status", "--porcelain=v1"], env) !== "") {
    return undefined;
  }
  const subject = gitStdoutIfOk(
    targetWorktree,
    ["log", "-1", "--format=%s", worktreeHead],
    env,
  );
  return subject === commitMessage ? worktreeHead : undefined;
}

async function tryFinishCommittedWorktree(
  session: ApplySession,
): Promise<TemplateUpgradeApplyRun | undefined> {
  const { inputs, branch, targetWorktree, temporaryWorktree, env } = session;
  const worktreeHead = await findCommittedWorktreeHead(session);
  if (worktreeHead === undefined) {
    return undefined;
  }
  runGitText(
    inputs.repository,
    ["branch", branch, worktreeHead],
    {
      code: "branch_create_failed",
      message: `cannot create branch ${branch} at ${worktreeHead.slice(0, 7)}`,
      repair: `check git branch -a in ${inputs.repository} and rerun`,
    },
    { env },
  );
  await removeWorktreeIfPresent(inputs.repository, targetWorktree, env);
  await removeWorktreeIfPresent(inputs.repository, temporaryWorktree, env);
  return buildTemplateUpgradeApplyRun({
    exitCode: 0,
    inputs,
    branch,
    status: "applied",
    commit: worktreeHead,
  });
}

async function executePlanInWorktree(
  inputs: TemplateUpgradeInputs,
  oldFolder: string,
  newFolder: string,
  planWorktree: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<TemplateUpgradePlanResult> {
  const beforePackage = await readTextIfFile(
    join(planWorktree, "package.json"),
  );
  const rows = await mergeTemplateUpgradeTrees(
    oldFolder,
    newFolder,
    planWorktree,
    env,
  );
  const afterPackage = await readTextIfFile(join(planWorktree, "package.json"));
  const dependencyChanges = diffPackageDependencies(
    beforePackage,
    afterPackage,
  );
  const templateCopyChanges = await diffTemplateUpgradeCopyChanges(
    oldFolder,
    newFolder,
    rows,
    env,
  );
  const conflicts = rows
    .filter((row) => isTemplateUpgradeConflict(row.outcome))
    .map((row) => row.path);
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    action: "plan",
    status: conflicts.length > 0 ? "conflicts" : "planned",
    baseCommit: inputs.baseCommit,
    targetCommit: inputs.targetCommit,
    rows,
    conflicts: Object.freeze(conflicts),
    dependencyChanges,
    templateCopyChanges,
  });
}

export async function templateUpgradePlan(
  inputs: TemplateUpgradeInputs,
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<TemplateUpgradePlanResult> {
  if (inputs.baseCommit === inputs.targetCommit) {
    return Object.freeze({
      schemaVersion: SCHEMA_VERSION,
      action: "plan",
      status: "up-to-date",
      baseCommit: inputs.baseCommit,
      targetCommit: inputs.targetCommit,
      rows: Object.freeze([]),
      conflicts: Object.freeze([]),
      dependencyChanges: Object.freeze([]),
      templateCopyChanges: Object.freeze([]),
    });
  }
  return await withTemplateUpgradeTrees(inputs, env, async (trees) => {
    const planWorktree = join(trees.scratchFolder, "plan-worktree");
    runGitText(
      inputs.repository,
      [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        planWorktree,
        inputs.repositoryHead,
      ],
      {
        code: "worktree_create_failed",
        message: `cannot create temporary worktree for ${inputs.repository}`,
        repair: `run git worktree prune in ${inputs.repository}, then rerun`,
      },
      { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
    );
    try {
      return await executePlanInWorktree(
        inputs,
        trees.oldFolder,
        trees.newFolder,
        planWorktree,
        env,
      );
    } finally {
      await removeWorktreeIfPresent(inputs.repository, planWorktree, env);
    }
  });
}

function runSingleCheckCommandStep(
  session: ApplySession,
  mergeData: ApplyMergeData,
  args: readonly string[],
  failedStep: string,
  timeoutMilliseconds: number,
): TemplateUpgradeApplyRun | undefined {
  const stepResult = runBunStep({
    worktree: session.targetWorktree,
    args,
    timeoutMilliseconds,
    env: session.env,
  });
  if (stepResult.ok) {
    return undefined;
  }
  return buildTemplateUpgradeApplyRun({
    exitCode: 1,
    inputs: session.inputs,
    branch: session.branch,
    status: "check-failed",
    worktree: session.targetWorktree,
    ...mergeData,
    failedStep,
    checkCommandOutput: stepResult.output,
  });
}

function runCheckCommandSteps(
  session: ApplySession,
  mergeData: ApplyMergeData,
): TemplateUpgradeApplyRun | undefined {
  return (
    runSingleCheckCommandStep(
      session,
      mergeData,
      ["install"],
      "bun install",
      INSTALL_TIMEOUT_MS,
    ) ??
    runSingleCheckCommandStep(
      session,
      mergeData,
      ["run", "check"],
      "bun run check",
      CHECK_TIMEOUT_MS,
    )
  );
}

async function inspectExistingTemplateUpgradeBranch(
  session: ApplySession,
): Promise<TemplateUpgradeApplyRun | undefined> {
  const { inputs, branch, targetWorktree, temporaryWorktree, env } = session;
  const existingTip = resolveRefIfPresent(
    inputs.repository,
    `refs/heads/${branch}`,
    env,
  );
  if (existingTip === undefined) {
    return undefined;
  }
  const existingParent = resolveRefIfPresent(
    inputs.repository,
    `${existingTip}^`,
    env,
  );
  if (existingParent === inputs.repositoryHead) {
    await removeWorktreeIfPresent(inputs.repository, targetWorktree, env);
    await removeWorktreeIfPresent(inputs.repository, temporaryWorktree, env);
    return buildTemplateUpgradeApplyRun({
      exitCode: 0,
      inputs,
      branch,
      status: "already-done",
      commit: existingTip,
    });
  }
  throw new CliError(
    "branch_exists_other_head",
    `branch ${branch} already exists from another commit`,
    `delete it with git -C ${inputs.repository} branch -D ${branch} to retry`,
    4,
    false,
  );
}

async function hasModifiedTargetWorktree(
  session: ApplySession,
): Promise<boolean> {
  const { inputs, temporaryWorktree, targetWorktree, env } = session;
  const targetStats = await lstatIfPresent(targetWorktree);
  if (targetStats === undefined || !targetStats.isDirectory()) {
    return false;
  }
  const targetHead = resolveRefIfPresent(targetWorktree, "HEAD", env);
  return (
    targetHead === inputs.repositoryHead &&
    !(await treesEqual(targetWorktree, temporaryWorktree))
  );
}

async function prepareTemplateUpgradeWorktree(
  session: ApplySession,
  beforePackage: string | undefined,
  rows: readonly TemplateUpgradeRow[],
  templateCopyChanges: readonly TemplateUpgradeCopyChange[],
): Promise<
  | { readonly kind: "stopped"; readonly run: TemplateUpgradeApplyRun }
  | { readonly kind: "ready"; readonly usingResolved: boolean }
> {
  const { inputs, branch, temporaryWorktree, targetWorktree, env } = session;
  if (await hasModifiedTargetWorktree(session)) {
    await removeWorktreeIfPresent(inputs.repository, temporaryWorktree, env);
    const markerFiles = await findConflictMarkerFiles(targetWorktree);
    if (markerFiles.length === 0) {
      return { kind: "ready", usingResolved: true };
    }
    const afterPackage = await readTextIfFile(
      join(targetWorktree, "package.json"),
    );
    return {
      kind: "stopped",
      run: buildTemplateUpgradeApplyRun({
        exitCode: 5,
        inputs,
        branch,
        status: "resolution-in-progress",
        worktree: targetWorktree,
        rows,
        conflicts: markerFiles,
        dependencyChanges: diffPackageDependencies(beforePackage, afterPackage),
        templateCopyChanges,
      }),
    };
  }
  await removeWorktreeIfPresent(inputs.repository, targetWorktree, env);
  runGitText(
    inputs.repository,
    ["worktree", "move", temporaryWorktree, targetWorktree],
    {
      code: "worktree_move_failed",
      message: `cannot move merge worktree into ${targetWorktree}`,
      repair: `remove leftover worktrees with git worktree prune in ${inputs.repository}, then rerun`,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
  return { kind: "ready", usingResolved: false };
}

async function collectTemplateUpgradeConflicts(
  rows: readonly TemplateUpgradeRow[],
  targetWorktree: string,
): Promise<readonly string[]> {
  const freshConflicts = rows
    .filter((row) => isTemplateUpgradeConflict(row.outcome))
    .map((row) => row.path);
  const markerFiles = await findConflictMarkerFiles(targetWorktree);
  return Object.freeze(
    [...new Set([...freshConflicts, ...markerFiles])].sort(compareCodeUnits),
  );
}

async function publishTemplateUpgradeBranch(
  session: ApplySession,
  mergeData: ApplyMergeData,
): Promise<TemplateUpgradeApplyRun> {
  const { inputs, branch, commitMessage, targetWorktree, env } = session;
  const commitSha = await stageAndCommitWorktree({
    worktree: targetWorktree,
    message: commitMessage,
    env,
  });
  runGitText(
    inputs.repository,
    ["branch", branch, commitSha],
    {
      code: "branch_create_failed",
      message: `cannot create branch ${branch} at ${commitSha.slice(0, 7)}`,
      repair: `check git branch -a in ${inputs.repository} and rerun`,
    },
    { env },
  );
  await removeWorktreeIfPresent(inputs.repository, targetWorktree, env);
  return buildTemplateUpgradeApplyRun({
    exitCode: 0,
    inputs,
    branch,
    status: "applied",
    commit: commitSha,
    ...mergeData,
  });
}

async function createTemporaryTemplateUpgradeWorktree(
  session: ApplySession,
): Promise<void> {
  const { inputs, worktreesRoot, temporaryWorktree, env } = session;
  await removeWorktreeIfPresent(inputs.repository, temporaryWorktree, env);
  await mkdir(worktreesRoot, { recursive: true });
  runGitText(
    inputs.repository,
    [
      "worktree",
      "add",
      "--quiet",
      "--detach",
      temporaryWorktree,
      inputs.repositoryHead,
    ],
    {
      code: "worktree_create_failed",
      message: `cannot create temporary worktree at ${temporaryWorktree}`,
      repair: `run git worktree prune in ${inputs.repository}, then rerun`,
    },
    { env, timeoutMilliseconds: WORKTREE_TIMEOUT_MS },
  );
}

async function finalizeTemplateUpgradeWorktree(
  session: ApplySession,
  beforePackage: string | undefined,
  usingResolved: boolean,
  rows: readonly TemplateUpgradeRow[],
  templateCopyChanges: readonly TemplateUpgradeCopyChange[],
): Promise<TemplateUpgradeApplyRun> {
  const { inputs, branch, targetWorktree, skipCheckCommand } = session;
  const afterPackage = await readTextIfFile(
    join(targetWorktree, "package.json"),
  );
  const mergeData: ApplyMergeData = {
    rows,
    dependencyChanges: diffPackageDependencies(beforePackage, afterPackage),
    templateCopyChanges,
  };
  if (!usingResolved) {
    const conflicts = await collectTemplateUpgradeConflicts(
      rows,
      targetWorktree,
    );
    if (conflicts.length > 0) {
      return buildTemplateUpgradeApplyRun({
        exitCode: 2,
        inputs,
        branch,
        status: "conflicts",
        worktree: targetWorktree,
        ...mergeData,
        conflicts,
      });
    }
  }
  if (!skipCheckCommand) {
    const failure = runCheckCommandSteps(session, mergeData);
    if (failure !== undefined) {
      return failure;
    }
  }
  return await publishTemplateUpgradeBranch(session, mergeData);
}

async function applyTemplateUpgradeInTrees(
  session: ApplySession,
  oldFolder: string,
  newFolder: string,
): Promise<TemplateUpgradeApplyRun> {
  const { inputs, temporaryWorktree, env } = session;
  await createTemporaryTemplateUpgradeWorktree(session);
  let temporaryMoved = false;
  try {
    const beforePackage = await readTextIfFile(
      join(temporaryWorktree, "package.json"),
    );
    const rows = await mergeTemplateUpgradeTrees(
      oldFolder,
      newFolder,
      temporaryWorktree,
      env,
    );
    const templateCopyChanges = await diffTemplateUpgradeCopyChanges(
      oldFolder,
      newFolder,
      rows,
      env,
    );
    const prepared = await prepareTemplateUpgradeWorktree(
      session,
      beforePackage,
      rows,
      templateCopyChanges,
    );
    temporaryMoved = true;
    if (prepared.kind === "stopped") {
      return prepared.run;
    }
    return await finalizeTemplateUpgradeWorktree(
      session,
      beforePackage,
      prepared.usingResolved,
      rows,
      templateCopyChanges,
    );
  } finally {
    if (!temporaryMoved) {
      await removeWorktreeIfPresent(inputs.repository, temporaryWorktree, env);
    }
  }
}

export async function templateUpgradeApply(
  inputs: TemplateUpgradeInputs,
  options: {
    readonly skipCheckCommand: boolean;
    readonly env?: Readonly<Record<string, string | undefined>>;
  },
): Promise<TemplateUpgradeApplyRun> {
  const env = options.env ?? process.env;
  const branch = templateUpgradeBranchName(
    inputs.baseCommit,
    inputs.targetCommit,
  );
  if (inputs.baseCommit === inputs.targetCommit) {
    return buildTemplateUpgradeApplyRun({
      exitCode: 0,
      inputs,
      branch,
      status: "up-to-date",
    });
  }
  const paths = templateUpgradeWorktreePaths(
    inputs.repository,
    inputs.targetCommit,
  );
  const session: ApplySession = {
    inputs,
    branch,
    commitMessage: templateUpgradeCommitMessage(
      inputs.baseCommit,
      inputs.targetCommit,
    ),
    ...paths,
    skipCheckCommand: options.skipCheckCommand,
    env,
  };
  const existing = await inspectExistingTemplateUpgradeBranch(session);
  if (existing !== undefined) {
    return existing;
  }
  const recovered = await tryFinishCommittedWorktree(session);
  if (recovered !== undefined) {
    return recovered;
  }
  return await withTemplateUpgradeTrees(inputs, env, (trees) =>
    applyTemplateUpgradeInTrees(session, trees.oldFolder, trees.newFolder),
  );
}
