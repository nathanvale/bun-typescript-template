import type { ChangeNoteEntry } from "./change-notes.ts";
import type { TemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type {
  TemplateUpgradeCopyChange,
  TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";

const SCHEMA_VERSION = 1;

export type TemplateUpgradeStepOutcome = "passed" | "failed" | "skipped";

export type TemplateUpgradeStepCommand =
  | "bun install"
  | "bun run check"
  | `bun run ${string}`;

export interface TemplateUpgradeApplyStep {
  readonly command: TemplateUpgradeStepCommand;
  readonly ran: boolean;
  readonly outcome: TemplateUpgradeStepOutcome;
  readonly reason?: string;
}

export interface TemplateUpgradePlanResult {
  readonly schemaVersion: 1;
  readonly action: "plan";
  readonly status: "up-to-date" | "planned" | "conflicts";
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly rows: readonly TemplateUpgradeRow[];
  readonly conflicts: readonly string[];
  readonly sharedMerges: readonly string[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly changeNotes: readonly ChangeNoteEntry[];
  readonly pinMoveNotice?: string;
  readonly templateHeadNotice?: string;
}

export interface TemplateUpgradeApplyResult {
  readonly schemaVersion: 1;
  readonly action: "apply";
  readonly status:
    | "up-to-date"
    | "already-done"
    | "applied"
    | "conflicts"
    | "resolution-in-progress"
    | "check-failed";
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly branch: string;
  readonly commit?: string;
  readonly worktree?: string;
  readonly rows: readonly TemplateUpgradeRow[];
  readonly conflicts: readonly string[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly changeNotes: readonly ChangeNoteEntry[];
  readonly steps: readonly TemplateUpgradeApplyStep[];
  readonly pinMoveNotice?: string;
  readonly templateHeadNotice?: string;
  readonly leftoverWorktreeNotice?: string;
  readonly failedStep?: string;
  readonly checkCommandOutput?: string;
}

export interface TemplateUpgradeApplyRun {
  readonly result: TemplateUpgradeApplyResult;
  readonly exitCode: number;
}

export interface TemplateUpgradeApplyReportOptions {
  readonly exitCode: number;
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly status: TemplateUpgradeApplyResult["status"];
  readonly changeNotes: readonly ChangeNoteEntry[];
  readonly steps: readonly TemplateUpgradeApplyStep[];
  readonly commit?: string;
  readonly worktree?: string;
  readonly leftoverWorktreeNotice?: string;
  readonly rows?: readonly TemplateUpgradeRow[];
  readonly conflicts?: readonly string[];
  readonly dependencyChanges?: readonly PackageDependencyChange[];
  readonly templateCopyChanges?: readonly TemplateUpgradeCopyChange[];
  readonly failedStep?: string;
  readonly checkCommandOutput?: string;
}

export interface TemplateUpgradePlanReportOptions {
  readonly inputs: TemplateUpgradeInputs;
  readonly status: "up-to-date" | "planned" | "conflicts";
  readonly rows: readonly TemplateUpgradeRow[];
  readonly conflicts: readonly string[];
  readonly sharedMerges: readonly string[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly changeNotes: readonly ChangeNoteEntry[];
}

function pinMoveNoticeFor(inputs: TemplateUpgradeInputs): string | undefined {
  if (inputs.repositoryPinnedCommit === inputs.templatePinnedCommit) {
    return undefined;
  }
  return `The template's Pin moved from ${inputs.repositoryPinnedCommit.slice(0, 7)} to ${inputs.templatePinnedCommit.slice(0, 7)}; a Template upgrade does not move it. Move yours separately.`;
}

export function createTemplateUpgradeApplyStep(
  command: TemplateUpgradeStepCommand,
  ran: boolean,
  outcome: TemplateUpgradeStepOutcome,
  reason?: string,
): TemplateUpgradeApplyStep {
  return Object.freeze({
    command,
    ran,
    outcome,
    ...(reason === undefined ? {} : { reason }),
  });
}

export function skipTemplateUpgradeSteps(
  reason: string,
): readonly TemplateUpgradeApplyStep[] {
  return Object.freeze([
    Object.freeze({
      command: "bun install" as const,
      ran: false,
      outcome: "skipped" as const,
      reason,
    }),
    Object.freeze({
      command: "bun run check" as const,
      ran: false,
      outcome: "skipped" as const,
      reason,
    }),
  ]);
}

export function createTemplateUpgradePlanResult(
  options: TemplateUpgradePlanReportOptions,
): TemplateUpgradePlanResult {
  const pinMoveNotice = pinMoveNoticeFor(options.inputs);
  const { templateHeadNotice } = options.inputs;
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    action: "plan",
    status: options.status,
    baseCommit: options.inputs.baseCommit,
    targetCommit: options.inputs.targetCommit,
    rows: options.rows,
    conflicts: options.conflicts,
    sharedMerges: options.sharedMerges,
    dependencyChanges: options.dependencyChanges,
    templateCopyChanges: options.templateCopyChanges,
    changeNotes: options.changeNotes,
    ...(pinMoveNotice === undefined ? {} : { pinMoveNotice }),
    ...(templateHeadNotice === undefined ? {} : { templateHeadNotice }),
  });
}

function definedApplyFields(
  options: TemplateUpgradeApplyReportOptions,
  pinMoveNotice: string | undefined,
): Partial<TemplateUpgradeApplyResult> {
  const pairs: readonly (readonly [string, string | undefined])[] = [
    ["commit", options.commit],
    ["worktree", options.worktree],
    ["pinMoveNotice", pinMoveNotice],
    ["templateHeadNotice", options.inputs.templateHeadNotice],
    ["leftoverWorktreeNotice", options.leftoverWorktreeNotice],
    ["failedStep", options.failedStep],
    ["checkCommandOutput", options.checkCommandOutput],
  ];
  return Object.fromEntries(
    pairs.filter(
      (pair): pair is readonly [string, string] => pair[1] !== undefined,
    ),
  );
}

export function createTemplateUpgradeApplyRun(
  options: TemplateUpgradeApplyReportOptions,
): TemplateUpgradeApplyRun {
  const pinMoveNotice = pinMoveNoticeFor(options.inputs);
  const result: TemplateUpgradeApplyResult = {
    schemaVersion: SCHEMA_VERSION,
    action: "apply",
    status: options.status,
    baseCommit: options.inputs.baseCommit,
    targetCommit: options.inputs.targetCommit,
    branch: options.branch,
    rows: options.rows ?? Object.freeze([]),
    conflicts: options.conflicts ?? Object.freeze([]),
    dependencyChanges: options.dependencyChanges ?? Object.freeze([]),
    templateCopyChanges: options.templateCopyChanges ?? Object.freeze([]),
    changeNotes: options.changeNotes,
    steps: options.steps,
    ...definedApplyFields(options, pinMoveNotice),
  };
  return { exitCode: options.exitCode, result: Object.freeze(result) };
}
