import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeCliError } from "./cli-error.ts";
import {
  type TemplateUpgradeApplyResult,
  type TemplateUpgradePlanResult,
  templateUpgradeApply,
  templateUpgradePlan,
} from "./template-upgrade-apply.ts";
import {
  parseTemplateUpgradeArgs,
  TEMPLATE_UPGRADE_HELP,
} from "./template-upgrade-arguments.ts";
import { resolveTemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type {
  TemplateUpgradeCopyChange,
  TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";

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
    ...rows.map(
      (row) =>
        `${row.path.padEnd(width)}  ${row.ownerLabel.padEnd(10)}  ${row.outcome}`,
    ),
  ];
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
    "Repository-owned starting copies changed in template (not written):",
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
    "Repository-owned starting copies changed in template (left untouched):",
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
  if (result.status === "up-to-date") {
    return `${[`Template upgrade plan: up-to-date at ${target7}`, ...formatPinMoveNoticeLines(result.pinMoveNotice)].join("\n")}\n`;
  }
  const lines = [
    `Template upgrade plan: ${base7} -> ${target7}`,
    ...formatRows(result.rows),
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

function formatConflictApply(
  result: TemplateUpgradeApplyResult,
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
    ...result.conflicts.map((path) => `  ${path}`),
    ...notices,
    instruction,
  ];
  return `${lines.join("\n")}\n`;
}

function formatCheckCommandFailureApply(
  result: TemplateUpgradeApplyResult,
  notices: readonly string[],
): string {
  const lines = [
    `Template upgrade: ${result.failedStep ?? "check"} failed in ${result.worktree ?? ""}`,
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
  );
  return `${lines.join("\n")}\n`;
}

function formatApply(result: TemplateUpgradeApplyResult): string {
  const base7 = result.baseCommit.slice(0, 7);
  const target7 = result.targetCommit.slice(0, 7);
  const pinNotice = formatPinMoveNoticeLines(result.pinMoveNotice);
  if (result.status === "up-to-date") {
    return `${[`Template upgrade: up-to-date at ${target7}`, ...pinNotice].join("\n")}\n`;
  }
  if (result.status === "already-done") {
    return `${[`Template upgrade: already-done on branch ${result.branch}`, ...pinNotice].join("\n")}\n`;
  }
  const notices = [
    ...pinNotice,
    ...formatTemplateCopyNotice(
      result.templateCopyChanges,
      result.targetCommit,
    ),
  ];
  if (result.status === "applied") {
    return `${[`Template upgrade: created branch ${result.branch} (${base7} -> ${target7})`, ...notices].join("\n")}\n`;
  }
  if (
    result.status === "conflicts" ||
    result.status === "resolution-in-progress"
  ) {
    return formatConflictApply(result, notices);
  }
  return formatCheckCommandFailureApply(result, notices);
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
        : formatApply(execution.result),
    );
    return execution.exitCode;
  } catch (error) {
    return writeCliError(error, json);
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
