import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
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
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type {
  TemplateUpgradeCopyChange,
  TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";
import {
  createTemplateUpgradeApplyRun,
  createTemplateUpgradeApplyStep,
  type TemplateUpgradeApplyRun,
  type TemplateUpgradeApplyStep,
  type TemplateUpgradeStepCommand,
} from "./template-upgrade-report.ts";
import {
  RECORDED_HITS_STEP,
  recordedHitsRequestFor,
  runRecordedHitsStep,
} from "./template-upgrade-recorded-hits.ts";
import {
  runBunStep,
  type TemplateUpgradeBunResult,
} from "./template-upgrade-worktree.ts";

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
): void {
  const targetPath = join(scratch, "package.json");
  const sourcePath = join(worktree, "package.json");
  if (!existsSync(targetPath) || !existsSync(sourcePath)) return;
  const sourceScripts = readPackageScriptMap(readFileSync(sourcePath, "utf8"));
  if (sourceScripts === undefined) return;
  const targetText = readFileSync(targetPath, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(targetText);
  } catch {
    return;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return;
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
}

function copyGateFilesToScratch(
  scratch: string,
  worktree: string,
  gate: TemplateUpgradeGateName,
  gateFiles: readonly string[],
): void {
  const extraFiles = gate === "fallow" ? RECORDED_HITS_FILES : [];
  for (const relPath of [...new Set([...gateFiles, ...extraFiles])]) {
    if (relPath === "package.json") {
      overlayGatePackageScripts(scratch, worktree, gate);
      continue;
    }
    const source = join(worktree, relPath);
    const destination = join(scratch, relPath);
    if (!existsSync(source)) {
      rmSync(destination, { force: true });
      continue;
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
}

function probePredatedGateProblems(options: {
  readonly repository: string;
  readonly repositoryHead: string;
  readonly worktree: string;
  readonly gate: TemplateUpgradeGateName;
  readonly gateFiles: readonly string[];
  readonly env: ProcessEnvMap;
  readonly timeoutMilliseconds: number;
}): readonly TemplateUpgradeGateProblem[] | undefined {
  const modulesPath = join(options.worktree, "node_modules");
  if (!existsSync(modulesPath)) return undefined;
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
    if (cloned.timedOut || cloned.exitCode !== 0) return undefined;
    const checkedOut = runGitCommand(
      scratch,
      ["checkout", "--quiet", "--detach", options.repositoryHead],
      { env: options.env, timeoutMilliseconds: options.timeoutMilliseconds },
    );
    if (checkedOut.timedOut || checkedOut.exitCode !== 0) return undefined;
    symlinkSync(modulesPath, join(scratch, "node_modules"));
    copyGateFilesToScratch(
      scratch,
      options.worktree,
      options.gate,
      options.gateFiles,
    );
    const run = runBunStep({
      worktree: scratch,
      args: GATE_SCRIPT_ARGS[options.gate],
      timeoutMilliseconds: options.timeoutMilliseconds,
      env: options.env,
    });
    if (run.ok) return undefined;
    return parseTemplateUpgradeGateRun({
      gate: options.gate,
      output: run.output,
      worktree: scratch,
      exitCode: run.exitCode,
      timedOut: run.timedOut,
      signalCode: run.signalCode,
    })?.map((entry) => entry.problem);
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
      const predatedProblems = probePredatedGateProblems({
        repository: shared.inputs.repository,
        repositoryHead: shared.inputs.repositoryHead,
        worktree: shared.worktree,
        gate: matched.gate,
        gateFiles: matched.gateFiles,
        env,
        timeoutMilliseconds,
      });
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
        predatedProblems,
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
    checkCommandOutput: stepResult.output,
  });
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
  const recorded = runRecordedHitsStep(
    recordedHitsRequestFor(options.worktree, options.inputs, options.env, {
      rows: options.rows,
      dependencyChanges: options.dependencyChanges,
    }),
    CHECK_TIMEOUT_MS,
  );
  if (!recorded.ok) {
    return {
      ok: false,
      run: createTemplateUpgradeCheckFailureRun({
        ...options,
        failedStep: RECORDED_HITS_STEP,
        steps: Object.freeze([
          createTemplateUpgradeApplyStep("bun install", true, "passed"),
          ...recorded.steps,
        ]),
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
          createTemplateUpgradeApplyStep("bun install", true, "passed"),
          ...recorded.steps,
          createTemplateUpgradeApplyStep("bun run check", true, "failed"),
        ]),
        stepResult: check,
        timeoutMilliseconds: CHECK_TIMEOUT_MS,
      }),
    };
  }
  return {
    ok: true,
    steps: Object.freeze([
      createTemplateUpgradeApplyStep("bun install", true, "passed"),
      ...recorded.steps,
      createTemplateUpgradeApplyStep("bun run check", true, "passed"),
    ]),
  };
}
