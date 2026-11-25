import type { TemplateUpgradeChangesetPlan } from "./template-upgrade-changeset-write.ts";
import type { TemplateChangesetEntry } from "./template-upgrade-changesets.ts";
import type {
  TemplateUpgradeGateName,
  TemplateUpgradeGateProblem,
} from "./template-upgrade-gates.ts";
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
  | "biome format --write"
  | "fallow audit"
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
  readonly changesets: readonly TemplateChangesetEntry[];
  readonly upgradeChangeset?: TemplateUpgradeChangesetPlan;
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
    | "gate-adoption-required"
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
  readonly changesets: readonly TemplateChangesetEntry[];
  readonly steps: readonly TemplateUpgradeApplyStep[];
  readonly pinMoveNotice?: string;
  readonly templateHeadNotice?: string;
  readonly leftoverWorktreeNotice?: string;
  readonly failedStep?: string;
  readonly checkCommandOutput?: string;
  readonly gate?: TemplateUpgradeGateName;
  readonly gateFiles?: readonly string[];
  readonly gateProblems?: readonly TemplateUpgradeGateProblem[];
  readonly gateRepair?: string;
}

export interface TemplateUpgradeRecoverResult {
  readonly schemaVersion: 1;
  readonly action: "recover";
  readonly status: "recovered";
  readonly targetCommit: string;
  readonly worktree: string;
  readonly branch: string;
  readonly commit: string;
  readonly patchPath: string;
  readonly rerunCommand: string;
}

export interface TemplateUpgradeRecoverReportOptions {
  readonly targetCommit: string;
  readonly worktree: string;
  readonly branch: string;
  readonly commit: string;
  readonly patchPath: string;
  readonly rerunCommand: string;
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
  readonly changesets: readonly TemplateChangesetEntry[];
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
  readonly gate?: TemplateUpgradeGateName;
  readonly gateFiles?: readonly string[];
  readonly gateProblems?: readonly TemplateUpgradeGateProblem[];
  readonly gateRepair?: string;
}

export interface TemplateUpgradePlanReportOptions {
  readonly inputs: TemplateUpgradeInputs;
  readonly status: "up-to-date" | "planned" | "conflicts";
  readonly rows: readonly TemplateUpgradeRow[];
  readonly conflicts: readonly string[];
  readonly sharedMerges: readonly string[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly changesets: readonly TemplateChangesetEntry[];
  readonly upgradeChangeset?: TemplateUpgradeChangesetPlan;
}

function pinMoveNoticeFor(inputs: TemplateUpgradeInputs): string | undefined {
  if (inputs.repositoryPinnedCommit === inputs.templatePinnedCommit) {
    return undefined;
  }
  return `The template's Pin is ${inputs.templatePinnedCommit.slice(0, 7)} and yours is ${inputs.repositoryPinnedCommit.slice(0, 7)}; a Template upgrade does not move a Pin. Move yours separately if you need the template's.`;
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
    changesets: options.changesets,
    ...(options.upgradeChangeset === undefined
      ? {}
      : { upgradeChangeset: options.upgradeChangeset }),
    ...(pinMoveNotice === undefined ? {} : { pinMoveNotice }),
    ...(templateHeadNotice === undefined ? {} : { templateHeadNotice }),
  });
}

function definedApplyFields(
  options: TemplateUpgradeApplyReportOptions,
  pinMoveNotice: string | undefined,
): Partial<TemplateUpgradeApplyResult> {
  const pairs: readonly (readonly [string, unknown])[] = [
    ["commit", options.commit],
    ["worktree", options.worktree],
    ["pinMoveNotice", pinMoveNotice],
    ["templateHeadNotice", options.inputs.templateHeadNotice],
    ["leftoverWorktreeNotice", options.leftoverWorktreeNotice],
    ["failedStep", options.failedStep],
    ["checkCommandOutput", options.checkCommandOutput],
    ["gate", options.gate],
    ["gateFiles", options.gateFiles],
    ["gateProblems", options.gateProblems],
    ["gateRepair", options.gateRepair],
  ];
  return Object.fromEntries(pairs.filter((pair) => pair[1] !== undefined));
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
    changesets: options.changesets,
    steps: options.steps,
    ...definedApplyFields(options, pinMoveNotice),
  };
  return { exitCode: options.exitCode, result: Object.freeze(result) };
}

export function createTemplateUpgradeRecoverResult(
  options: TemplateUpgradeRecoverReportOptions,
): TemplateUpgradeRecoverResult {
  return Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    action: "recover",
    status: "recovered",
    targetCommit: options.targetCommit,
    worktree: options.worktree,
    branch: options.branch,
    commit: options.commit,
    patchPath: options.patchPath,
    rerunCommand: options.rerunCommand,
  });
}
