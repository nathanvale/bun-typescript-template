import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  type Stats,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ChangeNoteEntry } from "./change-notes.ts";
import { RECORDED_HITS_FILES } from "./recipe.ts";
import {
  classifyTemplateUpgradeGateFailure,
  matchTemplateUpgradeGateFailure,
  parseTemplateUpgradeGateRun,
  readPackageScriptMap,
  type TemplateUpgradeGateName,
  type TemplateUpgradeGateProblem,
  type TemplateUpgradeGateResult,
} from "./template-upgrade-gates.ts";
import { type ProcessEnvMap, runGitCommand } from "./template-upgrade-git.ts";
import type { TemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import {
  JSON_FORMAT_STEP,
  runJsonFormatStep,
  skipJsonFormatSteps,
} from "./template-upgrade-json-format.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type {
  TemplateUpgradeCopyChange,
  TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";
import {
  plainFileIdentityChange,
  plainFileEntry,
} from "./template-upgrade-plain-file.ts";
import {
  createTemplateUpgradeApplyRun,
  createTemplateUpgradeApplyStep,
  type TemplateUpgradeApplyRun,
  type TemplateUpgradeApplyStep,
  type TemplateUpgradeStepCommand,
} from "./template-upgrade-report.ts";
import {
  RECORDED_HITS_STEP,
  recordedHitsRecordedBeforeRepair,
  recordedHitsRequestFor,
  runRecordedHitsRepairStep,
  runRecordedHitsStep,
} from "./template-upgrade-recorded-hits.ts";
import {
  runBunStep,
  runWorktreeStep,
  type TemplateUpgradeBunResult,
} from "./template-upgrade-worktree.ts";

const FALLOW_AUDIT_STEP = "fallow audit";
const FALLOW_BIN = "node_modules/.bin/fallow";
const INSTALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 240_000;

const GATE_SCRIPT_ARGS: Readonly<
  Record<TemplateUpgradeGateName, readonly string[]>
> = {
  lint: ["run", "lint"],
  format: ["run", "format:check"],
  typecheck: ["run", "typecheck"],
  fallow: ["run", "--silent", "quality:fallow"],
};

const GATE_PACKAGE_SCRIPTS: Readonly<
  Record<TemplateUpgradeGateName, readonly string[]>
> = {
  lint: ["lint"],
  format: ["format:check"],
  typecheck: ["typecheck"],
  fallow: ["quality:fallow", "quality:fallow:record-hits"],
};

function overlayGatePackageScripts(
  scratch: string,
  worktree: string,
  gate: TemplateUpgradeGateName,
): boolean {
  const targetPath = join(scratch, "package.json");
  const sourcePath = join(worktree, "package.json");
  const sourceScripts = readPackageScriptMap(readFileSync(sourcePath, "utf8"));
  if (sourceScripts === undefined) return false;
  const targetText = readFileSync(targetPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(targetText);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return false;
  }
  const targetObj = Object.fromEntries(Object.entries(parsed));
  const nextScripts = { ...(readPackageScriptMap(targetText) ?? {}) };
  for (const key of GATE_PACKAGE_SCRIPTS[gate]) {
    if (Object.hasOwn(sourceScripts, key)) {
      nextScripts[key] = sourceScripts[key];
    }
  }
  targetObj.scripts = nextScripts;
  writeFileSync(targetPath, `${JSON.stringify(targetObj, null, 2)}\n`);
  return true;
}

type GateFileEntries = {
  readonly path: string;
  readonly source: Stats | "absent";
  readonly destination: Stats | "absent";
};

function admitGateFiles(
  scratch: string,
  worktree: string,
  paths: readonly string[],
): readonly GateFileEntries[] | { readonly refused: string } {
  const admitted: GateFileEntries[] = [];
  for (const path of paths) {
    const source = plainFileEntry(worktree, path);
    if (source !== "absent" && "refused" in source) {
      return { refused: `${source.refused} in the upgrade worktree` };
    }
    const destination = plainFileEntry(scratch, path);
    if (destination !== "absent" && "refused" in destination) {
      return { refused: `${destination.refused} at HEAD` };
    }
    admitted.push({ path, source, destination });
  }
  return admitted;
}

function copyGateFilesToScratch(
  scratch: string,
  worktree: string,
  gate: TemplateUpgradeGateName,
  gateFiles: readonly string[],
): ReadonlyMap<string, Stats> | { readonly refused: string } {
  const extraFiles = gate === "fallow" ? RECORDED_HITS_FILES : [];
  const paths = [...new Set([...gateFiles, ...extraFiles])];
  const admitted = admitGateFiles(scratch, worktree, paths);
  if ("refused" in admitted) return admitted;
  const written = new Map<string, Stats>();
  for (const { path, source, destination } of admitted) {
    const target = join(scratch, path);
    if (path === "package.json") {
      if (source === "absent" || destination === "absent") continue;
      if (overlayGatePackageScripts(scratch, worktree, gate)) {
        written.set(path, lstatSync(target));
      }
      continue;
    }
    if (source === "absent") {
      rmSync(target, { force: true });
      continue;
    }
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(worktree, path), target);
    written.set(path, lstatSync(target));
  }
  return written;
}

type PredatedGateProbe =
  | { readonly problems?: readonly TemplateUpgradeGateProblem[] }
  | { readonly refused: string };

function probePredatedGateProblems(options: {
  readonly repository: string;
  readonly repositoryHead: string;
  readonly worktree: string;
  readonly gate: TemplateUpgradeGateName;
  readonly gateFiles: readonly string[];
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}): PredatedGateProbe {
  const modulesPath = join(options.worktree, "node_modules");
  if (!existsSync(modulesPath)) return {};
  const scratchParent = mkdtempSync(
    join(tmpdir(), "template-upgrade-gate-verify-"),
  );
  const scratch = join(scratchParent, "repo");
  try {
    const cloned = runGitCommand(
      scratchParent,
      [
        "clone",
        "--quiet",
        "--shared",
        "--no-checkout",
        options.repository,
        scratch,
      ],
      { env: options.env, timeoutMilliseconds: options.timeoutMilliseconds },
    );
    if (cloned.timedOut || cloned.exitCode !== 0) return {};
    const checkedOut = runGitCommand(
      scratch,
      ["checkout", "--quiet", "--detach", options.repositoryHead],
      { env: options.env, timeoutMilliseconds: options.timeoutMilliseconds },
    );
    if (checkedOut.timedOut || checkedOut.exitCode !== 0) return {};
    symlinkSync(modulesPath, join(scratch, "node_modules"));
    const written = copyGateFilesToScratch(
      scratch,
      options.worktree,
      options.gate,
      options.gateFiles,
    );
    if ("refused" in written) return written;
    const run = runBunStep({
      worktree: scratch,
      args: GATE_SCRIPT_ARGS[options.gate],
      timeoutMilliseconds: options.timeoutMilliseconds,
      env: options.env,
    });
    const changed = plainFileIdentityChange(scratch, written);
    if (changed !== undefined) {
      return {
        refused: `${changed} is no longer the regular file with one link that this check wrote at HEAD`,
      };
    }
    if (run.ok) return {};
    const problems = parseTemplateUpgradeGateRun({
      gate: options.gate,
      output: run.output,
      worktree: scratch,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      signalCode: run.signalCode,
    })?.map((entry) => entry.problem);
    return problems === undefined ? {} : { problems };
  } finally {
    rmSync(scratchParent, { force: true, recursive: true });
  }
}

function createTemplateUpgradeCheckFailureRun(options: {
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly worktree: string;
  readonly changeNotes: readonly ChangeNoteEntry[];
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly failedStep: TemplateUpgradeStepCommand;
  readonly steps: readonly TemplateUpgradeApplyStep[];
  readonly stepResult: Pick<
    TemplateUpgradeBunResult,
    "output" | "exitCode" | "timedOut" | "signalCode"
  >;
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
  readonly beforePackage?: string | undefined;
  readonly afterPackage?: string | undefined;
}): TemplateUpgradeApplyRun {
  const {
    stepResult,
    env,
    timeoutMilliseconds,
    beforePackage,
    afterPackage,
    ...shared
  } = options;
  let gateResult: TemplateUpgradeGateResult | undefined;
  let refusal: string | undefined;
  if (shared.failedStep === "bun run check") {
    const matched = matchTemplateUpgradeGateFailure({
      rows: shared.rows,
      dependencyChanges: shared.dependencyChanges,
      checkCommandOutput: stepResult.output,
      worktree: shared.worktree,
      exitCode: stepResult.exitCode,
      timedOut: stepResult.timedOut,
      signalCode: stepResult.signalCode,
      beforePackage,
      afterPackage,
    });
    if (matched !== undefined) {
      const probe = probePredatedGateProblems({
        repository: shared.inputs.repository,
        repositoryHead: shared.inputs.repositoryHead,
        worktree: shared.worktree,
        gate: matched.gate,
        gateFiles: matched.gateFiles,
        env,
        timeoutMilliseconds,
      });
      if ("refused" in probe) refusal = probe.refused;
      else
        gateResult = classifyTemplateUpgradeGateFailure({
          rows: shared.rows,
          dependencyChanges: shared.dependencyChanges,
          checkCommandOutput: stepResult.output,
          worktree: shared.worktree,
          exitCode: stepResult.exitCode,
          timedOut: stepResult.timedOut,
          signalCode: stepResult.signalCode,
          beforePackage,
          afterPackage,
          predatedProblems: probe.problems,
        });
    }
  }
  if (gateResult !== undefined) {
    return createTemplateUpgradeApplyRun({
      exitCode: 6,
      status: "gate-adoption-required",
      ...shared,
      checkCommandOutput: stepResult.output,
      gate: gateResult.gate,
      gateFiles: gateResult.gateFiles,
      gateProblems: gateResult.problems,
      gateRepair: gateResult.repair,
    });
  }
  return createTemplateUpgradeApplyRun({
    exitCode: 1,
    status: "check-failed",
    ...shared,
    checkCommandOutput:
      refusal === undefined
        ? stepResult.output
        : `${stepResult.output.trimEnd()}\nThe gate was not checked against HEAD, so these problems are not shown to predate the upgrade: ${refusal}.`,
  });
}

function runPushFallowAuditStep(
  worktree: string,
  base: string,
  env: ProcessEnvMap,
):
  | { readonly ok: true; readonly step: TemplateUpgradeApplyStep }
  | { readonly ok: false; readonly result: TemplateUpgradeBunResult } {
  const fallow = join(worktree, FALLOW_BIN);
  if (!existsSync(fallow)) {
    return {
      ok: true,
      step: createTemplateUpgradeApplyStep(
        FALLOW_AUDIT_STEP,
        false,
        "skipped",
        `${FALLOW_BIN} not found`,
      ),
    };
  }
  const result = runWorktreeStep({
    worktree,
    command: [fallow, "audit", "--base", base, "--quiet"],
    label: FALLOW_AUDIT_STEP,
    timeoutMilliseconds: CHECK_TIMEOUT_MS,
    env,
  });
  if (!result.ok) return { ok: false, result };
  return {
    ok: true,
    step: createTemplateUpgradeApplyStep(FALLOW_AUDIT_STEP, true, "passed"),
  };
}

export function runTemplateUpgradeCheckSteps(options: {
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly worktree: string;
  readonly changeNotes: readonly ChangeNoteEntry[];
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly beforePackage: string | undefined;
  readonly afterPackage: string | undefined;
  readonly keyMergedPaths: readonly string[];
  readonly env: ProcessEnvMap;
}):
  | { readonly ok: true; readonly steps: readonly TemplateUpgradeApplyStep[] }
  | { readonly ok: false; readonly run: TemplateUpgradeApplyRun } {
  const install = runBunStep({
    worktree: options.worktree,
    args: ["install"],
    timeoutMilliseconds: INSTALL_TIMEOUT_MS,
    env: options.env,
  });
  if (!install.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: "bun install",
        steps: Object.freeze([
          createTemplateUpgradeApplyStep("bun install", true, "failed"),
          ...skipJsonFormatSteps(options.keyMergedPaths, "bun install failed"),
          createTemplateUpgradeApplyStep(
            "bun run check",
            false,
            "skipped",
            "bun install failed",
          ),
        ]),
        stepResult: install,
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  const formatted = runJsonFormatStep(
    options.worktree,
    options.keyMergedPaths,
    options.env,
  );
  if (!formatted.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: JSON_FORMAT_STEP,
        steps: Object.freeze([
          createTemplateUpgradeApplyStep("bun install", true, "passed"),
          createTemplateUpgradeApplyStep(JSON_FORMAT_STEP, true, "failed"),
          createTemplateUpgradeApplyStep(
            "bun run check",
            false,
            "skipped",
            `${JSON_FORMAT_STEP} failed`,
          ),
        ]),
        stepResult: formatted.result,
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  const installed = [
    createTemplateUpgradeApplyStep("bun install", true, "passed"),
    ...formatted.steps,
  ];
  const recordedHitsRequest = recordedHitsRequestFor(
    options.worktree,
    options.inputs,
    options.env,
    { rows: options.rows, dependencyChanges: options.dependencyChanges },
  );
  const recordedBeforeRepair =
    recordedHitsRecordedBeforeRepair(recordedHitsRequest);
  const recorded = runRecordedHitsStep(recordedHitsRequest, CHECK_TIMEOUT_MS);
  if (!recorded.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: RECORDED_HITS_STEP,
        steps: Object.freeze([...installed, ...recorded.steps]),
        stepResult: {
          output: recorded.output,
          exitCode: 1,
          timedOut: false,
          signalCode: null,
        },
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  const check = runBunStep({
    worktree: options.worktree,
    args: ["run", "check"],
    timeoutMilliseconds: CHECK_TIMEOUT_MS,
    env: options.env,
  });
  if (!check.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: "bun run check",
        steps: Object.freeze([
          ...installed,
          ...recorded.steps,
          createTemplateUpgradeApplyStep("bun run check", true, "failed"),
        ]),
        stepResult: check,
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  const checked = [
    ...installed,
    ...recorded.steps,
    createTemplateUpgradeApplyStep("bun run check", true, "passed"),
  ];
  const recordedAfterRepair = recordedBeforeRepair
    ? runRecordedHitsRepairStep(recordedHitsRequest, CHECK_TIMEOUT_MS)
    : { ok: true as const, steps: [] };
  if (!recordedAfterRepair.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: RECORDED_HITS_STEP,
        steps: Object.freeze([...checked, ...recordedAfterRepair.steps]),
        stepResult: {
          output: recordedAfterRepair.output,
          exitCode: 1,
          timedOut: false,
          signalCode: null,
        },
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  const recordedSteps = [...checked, ...recordedAfterRepair.steps];
  const audit = runPushFallowAuditStep(
    options.worktree,
    options.inputs.repositoryHead,
    options.env,
  );
  if (!audit.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: FALLOW_AUDIT_STEP,
        steps: Object.freeze([
          ...recordedSteps,
          createTemplateUpgradeApplyStep(FALLOW_AUDIT_STEP, true, "failed"),
        ]),
        stepResult: audit.result,
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  return { ok: true, steps: Object.freeze([...recordedSteps, audit.step]) };
}
