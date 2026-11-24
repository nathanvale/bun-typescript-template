import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatChangesetLines,
  type TemplateChangesetEntry,
} from "./template-upgrade-changesets.ts";
import { writeCliError } from "./cli-error.ts";
import {
  templateUpgradeApply,
  templateUpgradePlan,
} from "./template-upgrade-apply.ts";
import {
  parseTemplateUpgradeArgs,
  TEMPLATE_UPGRADE_HELP,
} from "./template-upgrade-arguments.ts";
import { formatTemplateUpgradeCommand } from "./template-upgrade-git.ts";
import { resolveTemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type {
  TemplateUpgradeCopyChange,
  TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";
import { templateUpgradeRecover } from "./template-upgrade-recover.ts";
import type {
  TemplateUpgradeApplyResult,
  TemplateUpgradeApplyStep,
  TemplateUpgradePlanResult,
  TemplateUpgradeRecoverResult,
} from "./template-upgrade-report.ts";

const TEMPLATE_ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

export interface TemplateUpgradeRuntime {
  readonly templateRoot?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
}

function formatRows(rows: readonly TemplateUpgradeRow[]): string[] {
  if (rows.length === 0) {
    return [];
  }
  const width = Math.max(...rows.map((row) => row.path.length), "Path".length);
  return [
    `${"Path".padEnd(width)}  ${"Owner".padEnd(10)}  Outcome`,
    ...rows.map((row) => {
      const outcomeText =
        row.reason === undefined
          ? row.outcome
          : `${row.outcome} (${row.reason})`;
      return `${row.path.padEnd(width)}  ${row.ownerLabel.padEnd(10)}  ${outcomeText}`;
    }),
  ];
}

function formatTargetCommitLines(
  targetCommit: string,
  templateHeadNotice: string | undefined,
): string[] {
  return [
    `Target commit: ${targetCommit}`,
    ...(templateHeadNotice === undefined ? [] : [templateHeadNotice]),
  ];
}

function formatChangesetsSection(
  changesets: readonly TemplateChangesetEntry[],
): string[] {
  if (changesets.length === 0) {
    return [];
  }
  return [
    "",
    `Changesets (${changesets.length}):`,
    ...formatChangesetLines(changesets).map((line) => `  ${line}`),
  ];
}

function formatSharedMerges(sharedMerges: readonly string[]): string[] {
  if (sharedMerges.length === 0) {
    return [];
  }
  return [
    "",
    "Shared files edited by this repository (will be merged):",
    ...sharedMerges.map((path) => `  ${path}`),
  ];
}

function formatApplySteps(
  steps: readonly TemplateUpgradeApplyStep[],
): string[] {
  return steps.map((step) =>
    step.reason === undefined
      ? `${step.command}: ${step.outcome}`
      : `${step.command}: ${step.outcome} (${step.reason})`,
  );
}

function formatDependencyChanges(
  changes: readonly PackageDependencyChange[],
): string[] {
  if (changes.length === 0) {
    return [];
  }
  return [
    "",
    "package.json dependency changes:",
    ...changes.map(
      (change) =>
        `  ${change.section}.${change.packageName}: ${change.before ?? "(none)"} -> ${change.after ?? "(removed)"}`,
    ),
  ];
}

function formatTemplateCopyDiffs(
  changes: readonly TemplateUpgradeCopyChange[],
): string[] {
  if (changes.length === 0) {
    return [];
  }
  return [
    "",
    "Template changes left untouched (not written):",
    ...changes.flatMap((change) =>
      change.diff === "" ? [`  ${change.path}`] : [change.diff],
    ),
  ];
}

function formatTemplateCopyNotice(
  changes: readonly TemplateUpgradeCopyChange[],
  targetCommit: string,
): string[] {
  if (changes.length === 0) {
    return [];
  }
  return [
    "Template changes left untouched:",
    ...changes.map((change) => `  ${change.path}`),
    `Run bun run upgrade plan --repository PATH --to ${targetCommit.slice(0, 7)} to see the diff between old and new regenerated copies.`,
  ];
}

function formatPinMoveNoticeLines(pinMoveNotice: string | undefined): string[] {
  return pinMoveNotice === undefined ? [] : [pinMoveNotice];
}

function formatPlan(result: TemplateUpgradePlanResult): string {
  const base7 = result.baseCommit.slice(0, 7);
  const target7 = result.targetCommit.slice(0, 7);
  const targetLines = formatTargetCommitLines(
    result.targetCommit,
    result.templateHeadNotice,
  );
  if (result.status === "up-to-date") {
    return `${[`Template upgrade plan: up-to-date at ${target7}`, ...targetLines, ...formatPinMoveNoticeLines(result.pinMoveNotice)].join("\n")}\n`;
  }
  const lines = [
    `Template upgrade plan: ${base7} -> ${target7}`,
    ...targetLines,
    ...formatChangesetsSection(result.changesets),
    ...(result.changesets.length > 0 ? [""] : []),
    ...formatRows(result.rows),
    ...formatSharedMerges(result.sharedMerges),
    ...formatDependencyChanges(result.dependencyChanges),
    ...formatTemplateCopyDiffs(result.templateCopyChanges),
  ];
  if (result.conflicts.length > 0) {
    lines.push(
      "",
      `Conflicts (${result.conflicts.length}): ${result.conflicts.join(", ")}`,
    );
  }
  if (result.pinMoveNotice !== undefined) {
    lines.push("", result.pinMoveNotice);
  }
  return `${lines.join("\n")}\n`;
}

const MAX_DISPLAYED_GATE_PROBLEMS = 50;

function formatWorktreeDiscardLines(
  worktree: string | undefined,
  repository: string,
  targetCommit: string,
): string[] {
  if (worktree === undefined || worktree === "") {
    return [];
  }
  const target7 = targetCommit.slice(0, 7);
  return [
    "To save any edits in this locked worktree and remove it instead of resuming, run:",
    `  ${formatTemplateUpgradeCommand("recover", repository, target7)}`,
  ];
}

function formatConflictApply(
  result: TemplateUpgradeApplyResult,
  repository: string,
  headerDetails: readonly string[],
  notices: readonly string[],
): string {
  const worktree = result.worktree ?? "";
  const isResolving = result.status === "resolution-in-progress";
  const header = isResolving
    ? `Template upgrade: resolution in progress in ${worktree}`
    : `Template upgrade: ${result.conflicts.length} conflicted file(s) in ${worktree}`;
  const instruction = isResolving
    ? "Finish resolving conflict markers in that worktree, then rerun the same upgrade apply command."
    : "Resolve the conflicts in that worktree, then rerun the same upgrade apply command.";
  const lines = [
    header,
    ...headerDetails,
    ...result.conflicts.map((path) => `  ${path}`),
    ...notices,
    instruction,
    ...formatWorktreeDiscardLines(
      result.worktree,
      repository,
      result.targetCommit,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function formatGateAdoptionApply(
  result: TemplateUpgradeApplyResult,
  repository: string,
  headerDetails: readonly string[],
  notices: readonly string[],
): string {
  const worktree = result.worktree ?? "";
  const problems = result.gateProblems ?? [];
  const changedFiles = result.gateFiles ?? [];
  const shown = problems.slice(0, MAX_DISPLAYED_GATE_PROBLEMS);
  const remaining = problems.length - shown.length;
  const gateSummary =
    changedFiles.length === 0
      ? `Gate: ${result.gate ?? "check"} (${problems.length} existing problem(s))`
      : `Gate: ${result.gate ?? "check"} (${problems.length} existing problem(s) after changing ${changedFiles.join(", ")})`;
  const lines = [
    `Template upgrade: existing code needs gate adoption in ${worktree}`,
    ...headerDetails,
    "",
    gateSummary,
    ...shown.map(
      (problem) => `  - [${problem.code}] ${problem.path}: ${problem.message}`,
    ),
    ...(remaining > 0 ? [`  ... and ${remaining} more problem(s)`] : []),
    ...notices,
    ...(result.gateRepair === undefined
      ? []
      : [`Repair: ${result.gateRepair}`]),
    ...formatWorktreeDiscardLines(
      result.worktree,
      repository,
      result.targetCommit,
    ),
  ];
  return `${lines.join("\n")}\n`;
}

function formatCheckCommandFailureApply(
  result: TemplateUpgradeApplyResult,
  repository: string,
  headerDetails: readonly string[],
  notices: readonly string[],
): string {
  const lines = [
    `Template upgrade: ${result.failedStep ?? "check"} failed in ${result.worktree ?? ""}`,
    ...headerDetails,
  ];
  if (
    result.checkCommandOutput !== undefined &&
    result.checkCommandOutput !== ""
  ) {
    lines.push(result.checkCommandOutput);
  }
  lines.push(
    ...notices,
    "Repair the failure in that worktree, then rerun the same upgrade apply command.",
    ...formatWorktreeDiscardLines(
      result.worktree,
      repository,
      result.targetCommit,
    ),
  );
  return `${lines.join("\n")}\n`;
}

function formatApply(
  result: TemplateUpgradeApplyResult,
  repository: string,
): string {
  const base7 = result.baseCommit.slice(0, 7);
  const target7 = result.targetCommit.slice(0, 7);
  const targetLines = formatTargetCommitLines(
    result.targetCommit,
    result.templateHeadNotice,
  );
  const stepLines = formatApplySteps(result.steps);
  const changesetLines = formatChangesetsSection(result.changesets);
  const pinNotice = formatPinMoveNoticeLines(result.pinMoveNotice);
  const headerDetails = [...targetLines, ...stepLines, ...changesetLines];
  if (result.status === "up-to-date") {
    return `${[`Template upgrade: up-to-date at ${target7}`, ...targetLines, ...stepLines, ...pinNotice].join("\n")}\n`;
  }
  if (result.status === "already-done") {
    const extraLines = [
      ...headerDetails,
      ...pinNotice,
      ...(result.leftoverWorktreeNotice === undefined
        ? []
        : [result.leftoverWorktreeNotice]),
    ];
    return `${[`Template upgrade: already-done on branch ${result.branch}`, ...extraLines].join("\n")}\n`;
  }
  const notices = [
    ...pinNotice,
    ...formatTemplateCopyNotice(
      result.templateCopyChanges,
      result.targetCommit,
    ),
  ];
  if (result.status === "applied") {
    return `${[`Template upgrade: created branch ${result.branch} (${base7} -> ${target7})`, ...headerDetails, ...notices].join("\n")}\n`;
  }
  if (
    result.status === "conflicts" ||
    result.status === "resolution-in-progress"
  ) {
    return formatConflictApply(result, repository, headerDetails, notices);
  }
  if (result.status === "gate-adoption-required") {
    return formatGateAdoptionApply(result, repository, headerDetails, notices);
  }
  return formatCheckCommandFailureApply(
    result,
    repository,
    headerDetails,
    notices,
  );
}

function formatRecover(result: TemplateUpgradeRecoverResult): string {
  return `${[
    `Template upgrade recover: removed ${result.worktree}`,
    `Target commit: ${result.targetCommit}`,
    `Branch: ${result.branch}`,
    `Commit: ${result.commit}`,
    `Patch: ${result.patchPath}`,
    `Rerun: ${result.rerunCommand}`,
  ].join("\n")}\n`;
}

export async function main(
  argv: readonly string[],
  runtime: TemplateUpgradeRuntime = {},
): Promise<number> {
  const json = argv.includes("--json");
  try {
    const options = parseTemplateUpgradeArgs(argv);
    if (options === "help") {
      process.stdout.write(TEMPLATE_UPGRADE_HELP);
      return 0;
    }
    const env = runtime.env ?? process.env;
    const templateRoot = runtime.templateRoot ?? TEMPLATE_ROOT;
    if (options.action === "recover") {
      const result = await templateUpgradeRecover({
        templateRoot,
        repository: options.repository,
        targetRef: options.targetRef,
        env,
      });
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : formatRecover(result),
      );
      return 0;
    }
    const inputs = resolveTemplateUpgradeInputs({
      templateRoot,
      repository: options.repository,
      targetRef: options.targetRef,
      env,
    });
    if (options.action === "plan") {
      const result = await templateUpgradePlan(inputs, env);
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : formatPlan(result),
      );
      return 0;
    }
    const execution = await templateUpgradeApply(inputs, {
      skipCheckCommand: options.skipCheckCommand,
      env,
    });
    process.stdout.write(
      options.json
        ? `${JSON.stringify(execution.result)}\n`
        : formatApply(execution.result, inputs.repository),
    );
    return execution.exitCode;
  } catch (error) {
    return writeCliError(error, json);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
