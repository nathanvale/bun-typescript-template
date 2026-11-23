import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChangeNoteEntry } from "./change-notes.ts";
import {
  parseFallowGateProblems,
  type TemplateUpgradeGateProblemEntry,
} from "./template-upgrade-fallow-gate.ts";
import type { TemplateUpgradeInputs } from "./template-upgrade-inputs.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type {
  TemplateUpgradeCopyChange,
  TemplateUpgradeRow,
} from "./template-upgrade-merge.ts";
import {
  createTemplateUpgradeApplyRun,
  type TemplateUpgradeApplyRun,
  type TemplateUpgradeApplyStep,
  type TemplateUpgradeStepCommand,
} from "./template-upgrade-report.ts";

export type TemplateUpgradeGateName =
  | "fallow"
  | "lint"
  | "typecheck"
  | "format";

export interface TemplateUpgradeGateProblem {
  readonly gate: TemplateUpgradeGateName;
  readonly code: string;
  readonly path: string;
  readonly message: string;
}

export interface TemplateUpgradeGateResult {
  readonly gate: TemplateUpgradeGateName;
  readonly gateFiles: readonly string[];
  readonly problems: readonly TemplateUpgradeGateProblem[];
  readonly repair: string;
}

const FALLOW_CONFIG_FILES = new Set([
  ".fallowrc.json",
  ".fallowrc.jsonc",
  "fallow.toml",
  ".fallow.toml",
]);

const FALLOW_PACKAGES = new Set([
  "fallow",
  "fallow-type-aware",
  "typescript",
  "@typescript/native",
]);

const TYPECHECK_PACKAGES = new Set(["typescript", "@typescript/native"]);
const FORMAT_PACKAGES = new Set(["@biomejs/biome"]);
const TSCONFIG_PATTERN = /^tsconfig(?:\.[^/]+)?\.json$/;
const ESLINT_PROBLEM_PATTERN =
  /^\s+(\d+):(\d+)\s+error\s+(.+?)\s{2,}([\w@/-]+)\s*$/;
const ESLINT_SUMMARY_PATTERN =
  /^✖\s+\d+\s+problems?\s+\(\d+\s+errors?,\s+\d+\s+warnings?\)/m;
const TSC_ERROR_PATTERN =
  /^([^\s(][^(\n]*)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
const BIOME_FORMAT_PATTERN = /^([^\s]+)\s+format\s+━+/gm;
const BIOME_ERROR_SUMMARY_PATTERN = /^Found\s+\d+\s+errors?\./m;

function isChangedRow(row: TemplateUpgradeRow): boolean {
  return row.outcome !== "untouched" && row.outcome !== "already-applied";
}

function isTsconfigPath(path: string): boolean {
  return TSCONFIG_PATTERN.test(path);
}

function isFallowConfigPath(path: string): boolean {
  return FALLOW_CONFIG_FILES.has(path);
}

function isLintGatePath(path: string): boolean {
  return (
    path === "eslint.config.mjs" ||
    (path.startsWith("config/") && path.endsWith(".mjs"))
  );
}

export function isFallowGatePath(path: string): boolean {
  return isFallowConfigPath(path) || isTsconfigPath(path);
}

export function fallowPackageChange(
  changes: readonly PackageDependencyChange[],
): boolean {
  return changes.some((change) => FALLOW_PACKAGES.has(change.packageName));
}

function resolveRealPath(target: string): string {
  const resolved = resolve(target);
  try {
    return realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function normalizeWorktreePath(worktree: string, rawPath: string): string {
  const trimmed = rawPath.trim().replaceAll("\\", "/");
  if (trimmed === "" || !isAbsolute(trimmed)) {
    return trimmed.replace(/^\.\//, "");
  }
  const resolvedWorktree = resolve(worktree);
  const realWorktree = resolveRealPath(worktree);
  const resolvedFile = resolve(trimmed);
  const realFile = resolveRealPath(trimmed);
  const candidate = realFile.startsWith(`${realWorktree}/`)
    ? relative(realWorktree, realFile)
    : relative(resolvedWorktree, resolvedFile);
  return candidate.replaceAll("\\", "/").replace(/^\.\//, "");
}

function isEslintPathHeader(rawLine: string): boolean {
  const trimmed = rawLine.trim();
  return (
    trimmed !== "" &&
    !rawLine.startsWith(" ") &&
    !trimmed.startsWith("$") &&
    !trimmed.startsWith("✖") &&
    !trimmed.startsWith("error:")
  );
}

function parseEslintProblemLine(
  rawLine: string,
  currentPath: string | undefined,
): TemplateUpgradeGateProblem | undefined {
  if (currentPath === undefined) return undefined;
  const match = ESLINT_PROBLEM_PATTERN.exec(rawLine);
  if (match === null) return undefined;
  return Object.freeze({
    gate: "lint",
    code: match[4] ?? "lint",
    path: currentPath,
    message: `line ${match[1] ?? ""}: ${match[3] ?? ""}`,
  });
}

function parseEslintProblems(
  checkOutput: string,
  worktree: string,
): readonly TemplateUpgradeGateProblem[] | undefined {
  if (
    checkOutput.includes("Oops! Something went wrong!") ||
    !ESLINT_SUMMARY_PATTERN.test(checkOutput)
  ) {
    return undefined;
  }
  const problems: TemplateUpgradeGateProblem[] = [];
  let currentPath: string | undefined;
  for (const rawLine of checkOutput.split(/\r?\n/)) {
    const problem = parseEslintProblemLine(rawLine, currentPath);
    if (problem !== undefined) {
      problems.push(problem);
    } else if (isEslintPathHeader(rawLine)) {
      currentPath = normalizeWorktreePath(worktree, rawLine.trim());
    }
  }
  return problems.length > 0 ? Object.freeze(problems) : undefined;
}

function parseTypecheckProblems(
  checkOutput: string,
  worktree: string,
): readonly TemplateUpgradeGateProblem[] | undefined {
  const problems: TemplateUpgradeGateProblem[] = [];
  TSC_ERROR_PATTERN.lastIndex = 0;
  let match = TSC_ERROR_PATTERN.exec(checkOutput);
  while (match !== null) {
    const filePath = normalizeWorktreePath(worktree, match[1] ?? "");
    const lineNumber = match[2] ?? "";
    const code = match[4] ?? "TS";
    const message = (match[5] ?? "").trim();
    problems.push(
      Object.freeze({
        gate: "typecheck",
        code,
        path: filePath,
        message: `line ${lineNumber}: ${message}`,
      }),
    );
    match = TSC_ERROR_PATTERN.exec(checkOutput);
  }
  return problems.length > 0 ? Object.freeze(problems) : undefined;
}

function parseFormatProblems(
  checkOutput: string,
  worktree: string,
): readonly TemplateUpgradeGateProblem[] | undefined {
  if (!BIOME_ERROR_SUMMARY_PATTERN.test(checkOutput)) return undefined;
  const problems: TemplateUpgradeGateProblem[] = [];
  BIOME_FORMAT_PATTERN.lastIndex = 0;
  let match = BIOME_FORMAT_PATTERN.exec(checkOutput);
  while (match !== null) {
    const filePath = normalizeWorktreePath(worktree, match[1] ?? "");
    problems.push(
      Object.freeze({
        gate: "format",
        code: "format",
        path: filePath,
        message: `formatting differs in ${filePath}`,
      }),
    );
    match = BIOME_FORMAT_PATTERN.exec(checkOutput);
  }
  return problems.length > 0 ? Object.freeze(problems) : undefined;
}

function repairForGate(
  gate: TemplateUpgradeGateName,
  worktree: string,
): string {
  if (gate === "fallow") {
    return `Fix the listed problems in ${worktree} to satisfy the gate, or run bun run quality:fallow:record-hits in ${worktree} to record the pre-existing Fallow findings (noting that recorded-hits growth must be accepted or paid down on the upgrade pull request), then rerun the same upgrade apply command.`;
  }
  if (gate === "lint") {
    return `Fix the listed lint problems in ${worktree} (recording Fallow hits does not silence ESLint), then rerun the same upgrade apply command.`;
  }
  if (gate === "typecheck") {
    return `Fix the listed TypeScript errors in ${worktree}, then rerun the same upgrade apply command.`;
  }
  return `Run bun run format in ${worktree} to update formatting, then rerun the same upgrade apply command.`;
}

function readPackageScriptMap(
  text: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (text === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }
    const scripts: unknown = Reflect.get(parsed, "scripts");
    if (
      typeof scripts !== "object" ||
      scripts === null ||
      Array.isArray(scripts)
    ) {
      return undefined;
    }
    return Object.fromEntries(Object.entries(scripts));
  } catch {
    return undefined;
  }
}

function packageScriptChanged(
  beforeScripts: Readonly<Record<string, unknown>> | undefined,
  afterScripts: Readonly<Record<string, unknown>> | undefined,
  keys: readonly string[],
): boolean {
  if (beforeScripts === undefined || afterScripts === undefined) return false;
  return keys.some((key) => beforeScripts[key] !== afterScripts[key]);
}

function changedGateFilesByKind(
  rows: readonly TemplateUpgradeRow[],
  dependencyChanges: readonly PackageDependencyChange[],
  beforePackage?: string,
  afterPackage?: string,
) {
  const changed = rows.filter(isChangedRow);
  const beforeScripts = readPackageScriptMap(beforePackage);
  const afterScripts = readPackageScriptMap(afterPackage);
  const addPackage = (list: string[], condition: boolean) => {
    if (condition && !list.includes("package.json")) list.push("package.json");
  };
  const fallow = changed
    .map((row) => row.path)
    .filter((path) => isFallowGatePath(path));
  addPackage(
    fallow,
    fallowPackageChange(dependencyChanges) ||
      packageScriptChanged(beforeScripts, afterScripts, [
        "quality:fallow",
        "quality:fallow:record-hits",
      ]),
  );
  const lint = changed
    .map((row) => row.path)
    .filter((path) => isLintGatePath(path));
  addPackage(lint, packageScriptChanged(beforeScripts, afterScripts, ["lint"]));
  const typecheck = changed
    .map((row) => row.path)
    .filter((path) => isTsconfigPath(path));
  addPackage(
    typecheck,
    dependencyChanges.some((change) =>
      TYPECHECK_PACKAGES.has(change.packageName),
    ) || packageScriptChanged(beforeScripts, afterScripts, ["typecheck"]),
  );
  const format: string[] = changed
    .map((row) => row.path)
    .filter((path) => path === "biome.json");
  addPackage(
    format,
    dependencyChanges.some((change) =>
      FORMAT_PACKAGES.has(change.packageName),
    ) || packageScriptChanged(beforeScripts, afterScripts, ["format:check"]),
  );
  return { fallow, lint, typecheck, format };
}

function wrapProblems(
  problems: readonly TemplateUpgradeGateProblem[] | undefined,
): readonly TemplateUpgradeGateProblemEntry[] | undefined {
  return problems?.map((problem) => ({
    problem,
    paths: problem.path === "" ? [] : [problem.path],
  }));
}

function touchesModifiedTemplateFile(
  problems: readonly TemplateUpgradeGateProblemEntry[],
  modifiedTemplateOwnedPaths: ReadonlySet<string>,
): boolean {
  return problems.some((entry) =>
    entry.paths.some((path) => modifiedTemplateOwnedPaths.has(path)),
  );
}

export function classifyTemplateUpgradeGateFailure(options: {
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly checkCommandOutput: string;
  readonly worktree: string;
  readonly beforePackage?: string | undefined;
  readonly afterPackage?: string | undefined;
}): TemplateUpgradeGateResult | undefined {
  const {
    rows,
    dependencyChanges,
    checkCommandOutput,
    worktree,
    beforePackage,
    afterPackage,
  } = options;
  const modifiedTemplateOwnedPaths = new Set(
    rows
      .filter((row) => isChangedRow(row) && row.ownerLabel !== "repository")
      .map((row) => row.path),
  );
  const gates = changedGateFilesByKind(
    rows,
    dependencyChanges,
    beforePackage,
    afterPackage,
  );
  const candidates: readonly (readonly [
    TemplateUpgradeGateName,
    readonly string[],
    () => readonly TemplateUpgradeGateProblemEntry[] | undefined,
  ])[] = [
    [
      "lint",
      gates.lint,
      () => wrapProblems(parseEslintProblems(checkCommandOutput, worktree)),
    ],
    [
      "format",
      gates.format,
      () => wrapProblems(parseFormatProblems(checkCommandOutput, worktree)),
    ],
    [
      "typecheck",
      gates.typecheck,
      () => wrapProblems(parseTypecheckProblems(checkCommandOutput, worktree)),
    ],
    [
      "fallow",
      gates.fallow,
      () =>
        parseFallowGateProblems(checkCommandOutput, (rawPath) =>
          normalizeWorktreePath(worktree, rawPath),
        ),
    ],
  ];
  for (const [gate, changedFiles, parse] of candidates) {
    if (changedFiles.length === 0) continue;
    const parsed = parse();
    if (parsed === undefined) continue;
    if (touchesModifiedTemplateFile(parsed, modifiedTemplateOwnedPaths)) {
      return undefined;
    }
    return Object.freeze({
      gate,
      gateFiles: Object.freeze([...changedFiles]),
      problems: Object.freeze(parsed.map((entry) => entry.problem)),
      repair: repairForGate(gate, worktree),
    });
  }
  return undefined;
}

export function createTemplateUpgradeCheckFailureRun(options: {
  readonly inputs: TemplateUpgradeInputs;
  readonly branch: string;
  readonly worktree: string;
  readonly changeNotes: readonly ChangeNoteEntry[];
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly templateCopyChanges: readonly TemplateUpgradeCopyChange[];
  readonly failedStep: TemplateUpgradeStepCommand;
  readonly steps: readonly TemplateUpgradeApplyStep[];
  readonly output: string;
  readonly beforePackage?: string | undefined;
  readonly afterPackage?: string | undefined;
}): TemplateUpgradeApplyRun {
  const { output, beforePackage, afterPackage, ...shared } = options;
  const gateResult =
    shared.failedStep === "bun run check"
      ? classifyTemplateUpgradeGateFailure({
          rows: shared.rows,
          dependencyChanges: shared.dependencyChanges,
          checkCommandOutput: output,
          worktree: shared.worktree,
          beforePackage,
          afterPackage,
        })
      : undefined;
  if (gateResult !== undefined) {
    return createTemplateUpgradeApplyRun({
      exitCode: 6,
      status: "gate-adoption-required",
      ...shared,
      checkCommandOutput: output,
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
    checkCommandOutput: output,
  });
}
