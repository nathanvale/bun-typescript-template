import { rmdir } from "node:fs/promises";
import { join } from "node:path";
import {
  planTemplateUpgradeChangeset,
  writeTemplateUpgradeChangeset,
} from "./template-upgrade-changeset-write.ts";
import {
  readTemplateUpgradeChangesets,
  type TemplateChangesetEntry,
} from "./template-upgrade-changesets.ts";
import { CliError } from "./cli-error.ts";
import { withTemplateUpgradeTrees } from "./template-upgrade-bootstrap.ts";
import { runTemplateUpgradeCheckSteps } from "./template-upgrade-gate-check.ts";
import { skipJsonFormatSteps } from "./template-upgrade-json-format.ts";
import {
  formatCommandPath,
  lstatIfPresent,
  type ProcessEnvMap,
  runGitText,
} from "./template-upgrade-git.ts";
import type { TemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import {
  type PackageDependencyChange,
  readPackageChanges,
} from "./template-upgrade-json-merge.ts";
import {
  diffTemplateUpgradeCopyChanges,
  isTemplateUpgradeConflict,
  mergeTemplateUpgradeTrees,
  type TemplateUpgradeCopyChange,
  type TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";
import {
  noCheckTemplateUpgradeSteps,
  recordedHitsRequestFor,
} from "./template-upgrade-recorded-hits.ts";
import {
  createTemplateUpgradeApplyRun,
  createTemplateUpgradePlanResult,
  skipTemplateUpgradeSteps,
  type TemplateUpgradeApplyRun,
  type TemplateUpgradeApplyStep,
  type TemplateUpgradePlanResult,
} from "./template-upgrade-report.ts";
import {
  assertTargetWorktreeMatchesHead,
  assertWorktreePathAvailableForTemplateUpgrade,
  assertWorktreePathsNotSymlinks,
  createLockedTemplateUpgradeWorktree,
  moveLockedTemplateUpgradeWorktree,
  removeTemplateUpgradeLeftoverWorktree,
  removeTemplateUpgradeWorktree,
} from "./template-upgrade-worktree-lock.ts";
import {
  assertNotSymlinkPath,
  compareCodeUnits,
  findConflictMarkerFiles,
  readGitOutput,
  readTextIfFile,
  readWorktreeOwnHead,
  resolveRefIfPresent,
  stageAndCommitWorktree,
  templateUpgradeBranchName,
  templateUpgradeCommitMessage,
  templateUpgradeWorktreePaths,
  treesEqual,
} from "./template-upgrade-worktree.ts";

interface ApplySession {
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly commitSubject: string;
  readonly commitMessage: string;
  readonly changesets: readonly TemplateChangesetEntry[];
  readonly worktreesRoot: string;
  readonly temporaryWorktree: string;
  readonly targetWorktree: string;
  readonly skipCheckCommand: boolean;
  readonly env: ProcessEnvMap;
}

interface ApplyMergeData {
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly dependencyChangesNotice?: string;
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly beforePackage: string | undefined;
  readonly afterPackage: string | undefined;
  readonly keyMergedPaths: readonly string[];
}

async function findCommittedWorktreeHead(
  session: ApplySession,
): Promise<string | undefined> {
  const { inputs, commitSubject, targetWorktree, env } = session;
  const stats = await lstatIfPresent(targetWorktree);
  if (stats === undefined || !stats.isDirectory()) {
    return undefined;
  }
  const worktreeHead = await readWorktreeOwnHead(targetWorktree, env);
  if (worktreeHead === undefined || worktreeHead === inputs.repositoryHead) {
    return undefined;
  }
  if (
    resolveRefIfPresent(targetWorktree, `${worktreeHead}^`, env) !==
    inputs.repositoryHead
  ) {
    return undefined;
  }
  if (readGitOutput(targetWorktree, ["status", "--porcelain=v1"], env) !== "") {
    return undefined;
  }
  const subject = readGitOutput(
    targetWorktree,
    ["log", "-1", "--format=%s", worktreeHead],
    env,
  );
  return subject === commitSubject ? worktreeHead : undefined;
}

async function tryFinishCommittedWorktree(
  session: ApplySession,
): Promise<TemplateUpgradeApplyRun | undefined> {
  const { inputs, branch, changesets, targetWorktree, temporaryWorktree, env } =
    session;
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
  await removeTemplateUpgradeWorktree(inputs.repository, targetWorktree, env);
  await removeTemplateUpgradeWorktree(
    inputs.repository,
    temporaryWorktree,
    env,
  );
  return createTemplateUpgradeApplyRun({
    exitCode: 0,
    inputs,
    branch,
    status: "applied",
    commit: worktreeHead,
    changesets,
    steps: skipTemplateUpgradeSteps("recovered committed worktree"),
  });
}

async function executePlanInWorktree(options: {
  readonly inputs: TemplateUpgradeInputs;
  readonly changesets: readonly TemplateChangesetEntry[];
  readonly oldFolder: string;
  readonly newFolder: string;
  readonly planWorktree: string;
  readonly env: ProcessEnvMap;
}): Promise<TemplateUpgradePlanResult> {
  const { inputs, changesets, oldFolder, newFolder, planWorktree, env } =
    options;
  const beforePackage = await readTextIfFile(
    join(planWorktree, "package.json"),
  );
  const mergedJsonTexts = new Map<string, string>();
  const rows = await mergeTemplateUpgradeTrees(
    oldFolder,
    newFolder,
    planWorktree,
    env,
    new Set<string>(),
    mergedJsonTexts,
  );
  const afterPackage =
    mergedJsonTexts.get("package.json") ??
    (await readTextIfFile(join(planWorktree, "package.json")));
  const dependencyDiff = readPackageChanges(beforePackage, afterPackage);
  const templateCopyChanges = await diffTemplateUpgradeCopyChanges(
    oldFolder,
    newFolder,
    rows,
    env,
  );
  const conflicts = rows
    .filter((row) => isTemplateUpgradeConflict(row.outcome))
    .map((row) => row.path);
  const sharedMerges = rows
    .filter((row) => row.ownerLabel === "shared" && row.outcome === "merge")
    .map((row) => row.path);
  const upgradeChangeset = await planTemplateUpgradeChangeset({
    repository: inputs.repository,
    worktree: planWorktree,
    baseCommit: inputs.baseCommit,
    targetCommit: inputs.targetCommit,
    env,
  });
  return createTemplateUpgradePlanResult({
    inputs,
    status: conflicts.length > 0 ? "conflicts" : "planned",
    rows,
    conflicts: Object.freeze(conflicts),
    sharedMerges: Object.freeze(sharedMerges),
    dependencyChanges: dependencyDiff.changes,
    ...(dependencyDiff.unavailableReason === undefined
      ? {}
      : { dependencyChangesNotice: dependencyDiff.unavailableReason }),
    templateCopyChanges,
    changesets,
    ...(upgradeChangeset === undefined ? {} : { upgradeChangeset }),
  });
}

export async function templateUpgradePlan(
  inputs: TemplateUpgradeInputs,
  env: ProcessEnvMap = process.env,
): Promise<TemplateUpgradePlanResult> {
  if (inputs.baseCommit === inputs.targetCommit) {
    return createTemplateUpgradePlanResult({
      inputs,
      status: "up-to-date",
      rows: Object.freeze([]),
      conflicts: Object.freeze([]),
      sharedMerges: Object.freeze([]),
      dependencyChanges: Object.freeze([]),
      templateCopyChanges: Object.freeze([]),
      changesets: Object.freeze([]),
    });
  }
  const changesets = readTemplateUpgradeChangesets(
    inputs.templateRoot,
    inputs.baseCommit,
    inputs.targetCommit,
    env,
  );
  await assertNotSymlinkPath(
    join(inputs.repository, ".worktrees"),
    ".worktrees",
  );
  return await withTemplateUpgradeTrees(inputs, env, async (trees) => {
    const planWorktree = join(trees.scratchFolder, "plan-worktree");
    await createLockedTemplateUpgradeWorktree({
      repository: inputs.repository,
      worktreePath: planWorktree,
      commit: inputs.repositoryHead,
      targetCommit: inputs.targetCommit,
      env,
    });
    try {
      return await executePlanInWorktree({
        inputs,
        changesets,
        oldFolder: trees.oldFolder,
        newFolder: trees.newFolder,
        planWorktree,
        env,
      });
    } finally {
      await removeTemplateUpgradeWorktree(inputs.repository, planWorktree, env);
    }
  });
}

async function inspectExistingTemplateUpgradeBranch(
  session: ApplySession,
): Promise<TemplateUpgradeApplyRun | undefined> {
  const { inputs, branch, changesets, targetWorktree, temporaryWorktree, env } =
    session;
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
    const targetNotice = await removeTemplateUpgradeLeftoverWorktree({
      repository: inputs.repository,
      worktreePath: targetWorktree,
      expectedHead: existingTip,
      env,
    });
    const temporaryNotice = await removeTemplateUpgradeLeftoverWorktree({
      repository: inputs.repository,
      worktreePath: temporaryWorktree,
      expectedHead: inputs.repositoryHead,
      env,
    });
    const leftoverWorktree =
      targetNotice !== undefined
        ? targetWorktree
        : temporaryNotice !== undefined
          ? temporaryWorktree
          : undefined;
    const leftoverWorktreeNotice = [targetNotice, temporaryNotice]
      .filter((notice): notice is string => notice !== undefined)
      .join(" ");
    return createTemplateUpgradeApplyRun({
      exitCode: 0,
      inputs,
      branch,
      status: "already-done",
      commit: existingTip,
      changesets,
      steps: skipTemplateUpgradeSteps("already-done"),
      ...(leftoverWorktree === undefined
        ? {}
        : { worktree: leftoverWorktree, leftoverWorktreeNotice }),
    });
  }
  throw new CliError(
    "branch_exists_other_head",
    `branch ${branch} already exists from another commit`,
    `delete it with git -C ${formatCommandPath(inputs.repository)} branch -D ${branch} to retry`,
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
  const targetHead = await readWorktreeOwnHead(targetWorktree, env);
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
  const { inputs, branch, changesets, temporaryWorktree, targetWorktree, env } =
    session;
  await assertTargetWorktreeMatchesHead({
    repository: inputs.repository,
    repositoryHead: inputs.repositoryHead,
    targetCommit: inputs.targetCommit,
    targetWorktree,
    env,
  });
  if (await hasModifiedTargetWorktree(session)) {
    await removeTemplateUpgradeWorktree(
      inputs.repository,
      temporaryWorktree,
      env,
    );
    const markerFiles = await findConflictMarkerFiles(targetWorktree);
    if (markerFiles.length === 0) {
      return { kind: "ready", usingResolved: true };
    }
    const afterPackage = await readTextIfFile(
      join(targetWorktree, "package.json"),
    );
    const dependencyDiff = readPackageChanges(beforePackage, afterPackage);
    return {
      kind: "stopped",
      run: createTemplateUpgradeApplyRun({
        exitCode: 5,
        inputs,
        branch,
        status: "resolution-in-progress",
        worktree: targetWorktree,
        changesets,
        steps: skipTemplateUpgradeSteps("resolution-in-progress"),
        rows,
        conflicts: markerFiles,
        dependencyChanges: dependencyDiff.changes,
        ...(dependencyDiff.unavailableReason === undefined
          ? {}
          : { dependencyChangesNotice: dependencyDiff.unavailableReason }),
        templateCopyChanges,
      }),
    };
  }
  await moveLockedTemplateUpgradeWorktree({
    repository: inputs.repository,
    sourceWorktree: temporaryWorktree,
    targetWorktree,
    env,
  });
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
  steps: readonly TemplateUpgradeApplyStep[],
): Promise<TemplateUpgradeApplyRun> {
  const { inputs, branch, commitMessage, changesets, targetWorktree, env } =
    session;
  await writeTemplateUpgradeChangeset({
    repository: inputs.repository,
    worktree: targetWorktree,
    baseCommit: inputs.baseCommit,
    targetCommit: inputs.targetCommit,
    env,
  });
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
  await removeTemplateUpgradeWorktree(inputs.repository, targetWorktree, env);
  return createTemplateUpgradeApplyRun({
    exitCode: 0,
    inputs,
    branch,
    status: "applied",
    commit: commitSha,
    changesets,
    steps,
    ...mergeData,
  });
}

async function createTemporaryTemplateUpgradeWorktree(
  session: ApplySession,
): Promise<void> {
  const { inputs, temporaryWorktree, env } = session;
  await createLockedTemplateUpgradeWorktree({
    repository: inputs.repository,
    worktreePath: temporaryWorktree,
    commit: inputs.repositoryHead,
    targetCommit: inputs.targetCommit,
    env,
  });
}

async function finalizeTemplateUpgradeWorktree(
  session: ApplySession,
  beforePackage: string | undefined,
  usingResolved: boolean,
  rows: readonly TemplateUpgradeRow[],
  templateCopyChanges: readonly TemplateUpgradeCopyChange[],
  keyMergedPaths: ReadonlySet<string>,
  mergedJsonTexts: ReadonlyMap<string, string>,
): Promise<TemplateUpgradeApplyRun> {
  const { inputs, branch, changesets, targetWorktree, skipCheckCommand } =
    session;
  const afterPackage = usingResolved
    ? await readTextIfFile(join(targetWorktree, "package.json"))
    : (mergedJsonTexts.get("package.json") ??
      (await readTextIfFile(join(targetWorktree, "package.json"))));
  const dependencyDiff = readPackageChanges(beforePackage, afterPackage);
  const mergeData: ApplyMergeData = {
    rows,
    dependencyChanges: dependencyDiff.changes,
    ...(dependencyDiff.unavailableReason === undefined
      ? {}
      : { dependencyChangesNotice: dependencyDiff.unavailableReason }),
    templateCopyChanges,
    beforePackage,
    afterPackage,
    keyMergedPaths: [...keyMergedPaths].sort(compareCodeUnits),
  };
  if (!usingResolved) {
    const conflicts = await collectTemplateUpgradeConflicts(
      rows,
      targetWorktree,
    );
    if (conflicts.length > 0) {
      return createTemplateUpgradeApplyRun({
        exitCode: 2,
        inputs,
        branch,
        status: "conflicts",
        worktree: targetWorktree,
        changesets,
        steps: skipTemplateUpgradeSteps("conflicts"),
        ...mergeData,
        conflicts,
      });
    }
  }
  let steps: readonly TemplateUpgradeApplyStep[];
  if (skipCheckCommand) {
    steps = noCheckTemplateUpgradeSteps(
      recordedHitsRequestFor(
        session.targetWorktree,
        session.inputs,
        session.env,
        mergeData,
      ),
      skipJsonFormatSteps(mergeData.keyMergedPaths, "--no-check"),
    );
  } else {
    const checked = runTemplateUpgradeCheckSteps({
      inputs,
      branch,
      worktree: targetWorktree,
      changesets,
      env: session.env,
      ...mergeData,
    });
    if (!checked.ok) {
      return checked.run;
    }
    steps = checked.steps;
  }
  return await publishTemplateUpgradeBranch(session, mergeData, steps);
}

async function applyTemplateUpgradeInTrees(
  session: ApplySession,
  oldFolder: string,
  newFolder: string,
): Promise<TemplateUpgradeApplyRun> {
  const { inputs, worktreesRoot, temporaryWorktree, env } = session;
  const worktreesExisted = (await lstatIfPresent(worktreesRoot)) !== undefined;
  await createTemporaryTemplateUpgradeWorktree(session);
  let temporaryMoved = false;
  try {
    const beforePackage = await readTextIfFile(
      join(temporaryWorktree, "package.json"),
    );
    const keyMergedPaths = new Set<string>();
    const mergedJsonTexts = new Map<string, string>();
    const rows = await mergeTemplateUpgradeTrees(
      oldFolder,
      newFolder,
      temporaryWorktree,
      env,
      keyMergedPaths,
      mergedJsonTexts,
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
      keyMergedPaths,
      mergedJsonTexts,
    );
  } finally {
    if (!temporaryMoved) {
      await removeTemplateUpgradeWorktree(
        inputs.repository,
        temporaryWorktree,
        env,
      );
      if (!worktreesExisted) {
        await rmdir(worktreesRoot).catch(() => {});
      }
    }
  }
}

export async function templateUpgradeApply(
  inputs: TemplateUpgradeInputs,
  options: {
    readonly skipCheckCommand: boolean;
    readonly env?: ProcessEnvMap;
  },
): Promise<TemplateUpgradeApplyRun> {
  const env = options.env ?? process.env;
  const branch = templateUpgradeBranchName(
    inputs.baseCommit,
    inputs.targetCommit,
  );
  if (inputs.baseCommit === inputs.targetCommit) {
    return createTemplateUpgradeApplyRun({
      exitCode: 0,
      inputs,
      branch,
      status: "up-to-date",
      changesets: Object.freeze([]),
      steps: skipTemplateUpgradeSteps("up-to-date"),
    });
  }
  const changesets = readTemplateUpgradeChangesets(
    inputs.templateRoot,
    inputs.baseCommit,
    inputs.targetCommit,
    env,
  );
  const paths = templateUpgradeWorktreePaths(
    inputs.repository,
    inputs.targetCommit,
  );
  const session: ApplySession = {
    inputs,
    branch,
    commitSubject: templateUpgradeCommitMessage(
      inputs.baseCommit,
      inputs.targetCommit,
    ),
    commitMessage: templateUpgradeCommitMessage(
      inputs.baseCommit,
      inputs.targetCommit,
      changesets,
    ),
    changesets,
    ...paths,
    skipCheckCommand: options.skipCheckCommand,
    env,
  };
  await assertWorktreePathsNotSymlinks({
    ...paths,
    targetCommit: inputs.targetCommit,
  });
  const existing = await inspectExistingTemplateUpgradeBranch(session);
  if (existing !== undefined) {
    return existing;
  }
  await assertWorktreePathAvailableForTemplateUpgrade(
    inputs.repository,
    paths.temporaryWorktree,
    env,
  );
  await assertWorktreePathAvailableForTemplateUpgrade(
    inputs.repository,
    paths.targetWorktree,
    env,
  );
  const recovered = await tryFinishCommittedWorktree(session);
  if (recovered !== undefined) {
    return recovered;
  }
  await assertTargetWorktreeMatchesHead({
    repository: inputs.repository,
    repositoryHead: inputs.repositoryHead,
    targetCommit: inputs.targetCommit,
    targetWorktree: paths.targetWorktree,
    env,
  });
  return await withTemplateUpgradeTrees(inputs, env, (trees) =>
    applyTemplateUpgradeInTrees(session, trees.oldFolder, trees.newFolder),
  );
}
