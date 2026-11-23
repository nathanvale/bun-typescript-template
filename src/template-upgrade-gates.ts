import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import type { ChangeNoteEntry } from "./change-notes.ts";
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

function asObject(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function readStringField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function readArrayField(
  record: Readonly<Record<string, unknown>>,
  key: string,
): readonly unknown[] {
  if (!Object.hasOwn(record, key)) return [];
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function collectBoundaryViolationProblems(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblem[] {
  const problems: TemplateUpgradeGateProblem[] = [];
  for (const entry of readArrayField(check, "boundary_violations")) {
    const item = asObject(entry);
    if (item === undefined) continue;
    const from = readStringField(item, "from_path") ?? "";
    const to = readStringField(item, "to_path") ?? "";
    const fromZone = readStringField(item, "from_zone") ?? "";
    const toZone = readStringField(item, "to_zone") ?? "";
    problems.push(
      Object.freeze({
        gate: "fallow",
        code: "boundary-violation",
        path: from,
        message: `${from} imports ${to} (${fromZone} -> ${toZone})`,
      }),
    );
  }
  return problems;
}

function collectBoundaryOtherProblems(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblem[] {
  const problems: TemplateUpgradeGateProblem[] = [];
  for (const entry of readArrayField(check, "boundary_coverage_violations")) {
    const item = asObject(entry);
    const path = item === undefined ? undefined : readStringField(item, "path");
    if (path === undefined) continue;
    problems.push(
      Object.freeze({
        gate: "fallow",
        code: "boundary-coverage",
        path,
        message: `${path} does not match any boundary zone`,
      }),
    );
  }
  for (const entry of readArrayField(check, "boundary_call_violations")) {
    const item = asObject(entry);
    if (item === undefined) continue;
    const path =
      readStringField(item, "from_path") ?? readStringField(item, "path") ?? "";
    const to = readStringField(item, "to_path") ?? "";
    problems.push(
      Object.freeze({
        gate: "fallow",
        code: "boundary-call",
        path,
        message:
          to === "" ? `${path} violates boundary call` : `${path} calls ${to}`,
      }),
    );
  }
  return problems;
}

function collectBoundaryProblems(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblem[] {
  return [
    ...collectBoundaryViolationProblems(check),
    ...collectBoundaryOtherProblems(check),
  ];
}

const DEAD_CODE_FIELDS: readonly string[] = [
  "unused_files",
  "unused_exports",
  "unused_types",
  "unused_class_members",
  "unused_enum_members",
  "duplicate_exports",
  "duplicate_export_aliases",
  "circular_dependencies",
  "re_export_cycles",
  "unresolved_imports",
  "unused_dependencies",
  "unused_dev_dependencies",
  "unused_optional_dependencies",
  "unlisted_dependencies",
  "unlisted_binaries",
  "dev_dependencies_in_production",
  "test_only_dependencies",
  "unused_dependency_overrides",
  "misconfigured_dependency_overrides",
  "stale_suppressions",
];

function extractDeadCodeItemPath(
  item: Readonly<Record<string, unknown>>,
): string {
  const direct = readStringField(item, "path");
  if (direct !== undefined && direct !== "") return direct;
  const firstLocation = asObject(readArrayField(item, "locations")[0]);
  const locPath =
    firstLocation === undefined
      ? undefined
      : readStringField(firstLocation, "path");
  if (locPath !== undefined && locPath !== "") return locPath;
  const firstFile = readArrayField(item, "files")[0];
  return typeof firstFile === "string" && firstFile !== ""
    ? firstFile
    : "package.json";
}

function extractDeadCodeItemDetail(
  code: string,
  item: Readonly<Record<string, unknown>>,
  path: string,
): string {
  const symbol =
    readStringField(item, "export_name") ??
    readStringField(item, "member_name") ??
    readStringField(item, "package_name") ??
    readStringField(item, "specifier") ??
    readStringField(item, "name");
  return symbol === undefined ? `${code} in ${path}` : `${code}: ${symbol}`;
}

function collectDeadCodeProblems(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblem[] {
  const problems: TemplateUpgradeGateProblem[] = [];
  for (const field of DEAD_CODE_FIELDS) {
    const code =
      field === "re_export_cycles"
        ? "re-export-cycle"
        : field.replaceAll("_", "-");
    for (const entry of readArrayField(check, field)) {
      if (typeof entry === "string") {
        problems.push(
          Object.freeze({
            gate: "fallow",
            code,
            path: entry,
            message: `${code}: ${entry}`,
          }),
        );
        continue;
      }
      const item = asObject(entry);
      if (item === undefined) continue;
      const path = extractDeadCodeItemPath(item);
      problems.push(
        Object.freeze({
          gate: "fallow",
          code,
          path,
          message: extractDeadCodeItemDetail(code, item, path),
        }),
      );
    }
  }
  return problems;
}

function collectDupeProblems(
  report: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblem[] {
  const dupes = asObject(report.dupes);
  if (dupes === undefined) return [];
  const problems: TemplateUpgradeGateProblem[] = [];
  for (const entry of readArrayField(dupes, "clone_groups")) {
    const group = asObject(entry);
    if (group === undefined) continue;
    const first = asObject(readArrayField(group, "instances")[0]);
    const path =
      (first === undefined ? undefined : readStringField(first, "file")) ??
      (first === undefined ? undefined : readStringField(first, "path")) ??
      "src";
    problems.push(
      Object.freeze({
        gate: "fallow",
        code: "duplicate-code",
        path,
        message: `duplicate code group in ${path}`,
      }),
    );
  }
  return problems;
}

function collectHealthProblems(
  report: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblem[] {
  const health = asObject(report.health);
  if (health === undefined) return [];
  const problems: TemplateUpgradeGateProblem[] = [];
  for (const entry of readArrayField(health, "findings")) {
    const finding = asObject(entry);
    if (finding === undefined) continue;
    const path = readStringField(finding, "path") ?? "src";
    const name = readStringField(finding, "name") ?? path;
    problems.push(
      Object.freeze({
        gate: "fallow",
        code: "complexity",
        path,
        message: `complexity finding in ${name}`,
      }),
    );
  }
  return problems;
}

function parseJsonLine(
  rawLine: string,
): Readonly<Record<string, unknown>> | undefined {
  const line = rawLine.trim();
  if (!line.startsWith("{") || !line.endsWith("}")) return undefined;
  try {
    return asObject(JSON.parse(line));
  } catch {
    return undefined;
  }
}

function findFallowCombinedJson(
  checkOutput: string,
): Readonly<Record<string, unknown>> | undefined {
  let combined: Readonly<Record<string, unknown>> | undefined;
  for (const rawLine of checkOutput.split(/\r?\n/)) {
    const obj = parseJsonLine(rawLine);
    if (obj === undefined) continue;
    if (obj.error === true) return undefined;
    if (obj.kind === "combined") combined = obj;
  }
  return combined;
}

function parseFallowProblems(
  checkOutput: string,
  worktree: string,
): readonly TemplateUpgradeGateProblem[] | undefined {
  const combined = findFallowCombinedJson(checkOutput);
  if (combined === undefined) return undefined;
  const check = asObject(combined.check);
  const rawProblems = [
    ...(check === undefined ? [] : collectBoundaryProblems(check)),
    ...(check === undefined ? [] : collectDeadCodeProblems(check)),
    ...collectDupeProblems(combined),
    ...collectHealthProblems(combined),
  ];
  if (rawProblems.length === 0) return undefined;
  return Object.freeze(
    rawProblems.map((problem) =>
      Object.freeze({
        ...problem,
        path: normalizeWorktreePath(worktree, problem.path),
      }),
    ),
  );
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

function changedGateFilesByKind(
  rows: readonly TemplateUpgradeRow[],
  dependencyChanges: readonly PackageDependencyChange[],
) {
  const changed = rows.filter(isChangedRow);
  const fallow = changed
    .map((row) => row.path)
    .filter((path) => isFallowGatePath(path));
  if (
    fallowPackageChange(dependencyChanges) &&
    !fallow.includes("package.json")
  ) {
    fallow.push("package.json");
  }
  const lint = changed
    .map((row) => row.path)
    .filter((path) => isLintGatePath(path));
  const typecheck = changed
    .map((row) => row.path)
    .filter((path) => isTsconfigPath(path));
  if (
    dependencyChanges.some((change) =>
      TYPECHECK_PACKAGES.has(change.packageName),
    ) &&
    !typecheck.includes("package.json")
  ) {
    typecheck.push("package.json");
  }
  const format: string[] = changed
    .map((row) => row.path)
    .filter((path) => path === "biome.json");
  if (
    dependencyChanges.some((change) =>
      FORMAT_PACKAGES.has(change.packageName),
    ) &&
    !format.includes("package.json")
  ) {
    format.push("package.json");
  }
  return { fallow, lint, typecheck, format };
}

function touchesModifiedTemplateFile(
  problems: readonly TemplateUpgradeGateProblem[],
  modifiedTemplateOwnedPaths: ReadonlySet<string>,
): boolean {
  return problems.some((problem) =>
    modifiedTemplateOwnedPaths.has(problem.path),
  );
}

export function classifyTemplateUpgradeGateFailure(options: {
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly checkCommandOutput: string;
  readonly worktree: string;
}): TemplateUpgradeGateResult | undefined {
  const { rows, dependencyChanges, checkCommandOutput, worktree } = options;
  const modifiedTemplateOwnedPaths = new Set(
    rows
      .filter((row) => isChangedRow(row) && row.ownerLabel !== "repository")
      .map((row) => row.path),
  );
  const gates = changedGateFilesByKind(rows, dependencyChanges);
  const candidates: readonly (readonly [
    TemplateUpgradeGateName,
    readonly string[],
    () => readonly TemplateUpgradeGateProblem[] | undefined,
  ])[] = [
    [
      "lint",
      gates.lint,
      () => parseEslintProblems(checkCommandOutput, worktree),
    ],
    [
      "format",
      gates.format,
      () => parseFormatProblems(checkCommandOutput, worktree),
    ],
    [
      "typecheck",
      gates.typecheck,
      () => parseTypecheckProblems(checkCommandOutput, worktree),
    ],
    [
      "fallow",
      gates.fallow,
      () => parseFallowProblems(checkCommandOutput, worktree),
    ],
  ];
  for (const [gate, changedFiles, parse] of candidates) {
    if (changedFiles.length === 0) continue;
    const problems = parse();
    if (problems === undefined) continue;
    if (touchesModifiedTemplateFile(problems, modifiedTemplateOwnedPaths)) {
      return undefined;
    }
    return Object.freeze({
      gate,
      gateFiles: Object.freeze([...changedFiles]),
      problems,
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
}): TemplateUpgradeApplyRun {
  const { output, ...shared } = options;
  const gateResult =
    shared.failedStep === "bun run check"
      ? classifyTemplateUpgradeGateFailure({
          rows: shared.rows,
          dependencyChanges: shared.dependencyChanges,
          checkCommandOutput: output,
          worktree: shared.worktree,
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
