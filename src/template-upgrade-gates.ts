import { realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import {
  parseFallowGateProblems,
  type TemplateUpgradeGateProblemEntry,
} from "./template-upgrade-fallow-gate.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type { TemplateUpgradeRow } from "./template-upgrade-merge.ts";

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
  /^✖\s+\d+\s+problems?\s+\((\d+)\s+errors?,\s+\d+\s+warnings?\)/m;
const TSC_ERROR_PATTERN =
  /^([^\s(][^(\n]*)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/gm;
const TSC_ANY_ERROR_PATTERN = /:\s+error\s+TS\d+:/g;
const BIOME_FORMAT_PATTERN = /^([^\s]+)\s+format\s+━+/gm;
const BIOME_ERROR_SUMMARY_PATTERN = /^Found\s+(\d+)\s+errors?\./m;
const CRASH_OR_NON_GATE_PATTERNS: readonly RegExp[] = [
  /Oops! Something went wrong!/,
  /error:\s+script\s+"test"\s+exited\s+with\s+code/,
  /did not finish within \d+ ms/,
  /Segmentation fault/i,
  /\bFATAL ERROR\b/,
  /\bUnhandledPromiseRejection\b/,
  /\bERR_MODULE_NOT_FOUND\b/,
  /^thread '[^']+' panicked/m,
  /^(?:SyntaxError|ReferenceError|TypeError|RangeError):/m,
];

const GATE_PACKAGE_SCRIPTS: Readonly<
  Record<TemplateUpgradeGateName, readonly string[]>
> = {
  lint: ["lint"],
  format: ["format:check"],
  typecheck: ["typecheck"],
  fallow: ["quality:fallow", "quality:fallow:record-hits"],
};

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
  const summaryMatch = ESLINT_SUMMARY_PATTERN.exec(checkOutput);
  if (summaryMatch === null) return undefined;
  const expectedErrors = Number.parseInt(summaryMatch[1] ?? "0", 10);
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
  return problems.length > 0 && problems.length === expectedErrors
    ? Object.freeze(problems)
    : undefined;
}

function parseTypecheckProblems(
  checkOutput: string,
  worktree: string,
): readonly TemplateUpgradeGateProblem[] | undefined {
  const allErrors = checkOutput.match(TSC_ANY_ERROR_PATTERN) ?? [];
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
  return problems.length > 0 && problems.length === allErrors.length
    ? Object.freeze(problems)
    : undefined;
}

function parseFormatProblems(
  checkOutput: string,
  worktree: string,
): readonly TemplateUpgradeGateProblem[] | undefined {
  const summaryMatch = BIOME_ERROR_SUMMARY_PATTERN.exec(checkOutput);
  if (summaryMatch === null) return undefined;
  const expectedErrors = Number.parseInt(summaryMatch[1] ?? "0", 10);
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
  return problems.length > 0 && problems.length === expectedErrors
    ? Object.freeze(problems)
    : undefined;
}

function repairForGate(
  gate: TemplateUpgradeGateName,
  worktree: string,
): string {
  if (gate === "fallow") {
    return `Fix the listed problems in ${worktree} so existing code satisfies the gate, then rerun the same upgrade apply command. Only if you intentionally choose to defer paying down pre-existing Fallow findings (never to hide new mistakes), run bun run quality:fallow:record-hits in ${worktree} to record every current Fallow finding into fallow-*-recorded-hits.json so only newer findings fail; the hosted baseline-growth check will still require those recorded hits to be explicitly accepted or paid down on the upgrade pull request.`;
  }
  if (gate === "lint") {
    return `Fix the listed lint problems in ${worktree} (recording Fallow hits does not silence ESLint), then rerun the same upgrade apply command.`;
  }
  if (gate === "typecheck") {
    return `Fix the listed TypeScript errors in ${worktree}, then rerun the same upgrade apply command.`;
  }
  return `Run bun run format in ${worktree} to update formatting, then rerun the same upgrade apply command.`;
}

export function readPackageScriptMap(
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
      packageScriptChanged(
        beforeScripts,
        afterScripts,
        GATE_PACKAGE_SCRIPTS.fallow,
      ),
  );
  const lint = changed
    .map((row) => row.path)
    .filter((path) => isLintGatePath(path));
  addPackage(
    lint,
    packageScriptChanged(
      beforeScripts,
      afterScripts,
      GATE_PACKAGE_SCRIPTS.lint,
    ),
  );
  const typecheck = changed
    .map((row) => row.path)
    .filter((path) => isTsconfigPath(path));
  addPackage(
    typecheck,
    dependencyChanges.some((change) =>
      TYPECHECK_PACKAGES.has(change.packageName),
    ) ||
      packageScriptChanged(
        beforeScripts,
        afterScripts,
        GATE_PACKAGE_SCRIPTS.typecheck,
      ),
  );
  const format: string[] = changed
    .map((row) => row.path)
    .filter((path) => path === "biome.json");
  addPackage(
    format,
    dependencyChanges.some((change) =>
      FORMAT_PACKAGES.has(change.packageName),
    ) ||
      packageScriptChanged(
        beforeScripts,
        afterScripts,
        GATE_PACKAGE_SCRIPTS.format,
      ),
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

function excludedNonRepositoryPaths(
  rows: readonly TemplateUpgradeRow[],
): ReadonlySet<string> {
  return new Set(
    rows
      .filter(
        (row) =>
          row.ownerLabel === "template" ||
          row.ownerLabel === "generated" ||
          (row.ownerLabel === "shared" && isChangedRow(row)),
      )
      .map((row) => row.path),
  );
}

function validGateExit(
  gate: TemplateUpgradeGateName,
  exitCode: number | null,
  timedOut: boolean,
  signalCode: string | null,
): boolean {
  if (timedOut || signalCode !== null || exitCode === null) return false;
  if (exitCode <= 0 || exitCode >= 128) return false;
  if (gate === "typecheck") return exitCode === 1 || exitCode === 2;
  return exitCode === 1;
}

function hasCrashOrNonGateFailure(checkCommandOutput: string): boolean {
  return CRASH_OR_NON_GATE_PATTERNS.some((pattern) =>
    pattern.test(checkCommandOutput),
  );
}

function parseGateProblemsByKind(
  gate: TemplateUpgradeGateName,
  output: string,
  worktree: string,
): readonly TemplateUpgradeGateProblemEntry[] | undefined {
  if (gate === "lint")
    return wrapProblems(parseEslintProblems(output, worktree));
  if (gate === "format")
    return wrapProblems(parseFormatProblems(output, worktree));
  if (gate === "typecheck")
    return wrapProblems(parseTypecheckProblems(output, worktree));
  return parseFallowGateProblems(output, (rawPath) =>
    normalizeWorktreePath(worktree, rawPath),
  );
}

function matchesPredatedProblem(
  problem: TemplateUpgradeGateProblem,
  predated: readonly TemplateUpgradeGateProblem[],
): boolean {
  return predated.some(
    (item) =>
      item.gate === problem.gate &&
      item.code === problem.code &&
      item.path === problem.path &&
      (problem.gate !== "fallow" || item.message === problem.message),
  );
}

function allProblemsPredate(
  problems: readonly TemplateUpgradeGateProblem[],
  predated: readonly TemplateUpgradeGateProblem[] | undefined,
): boolean {
  if (predated === undefined || predated.length === 0) return false;
  return problems.every((problem) => matchesPredatedProblem(problem, predated));
}

export function parseTemplateUpgradeGateRun(options: {
  readonly gate: TemplateUpgradeGateName;
  readonly output: string;
  readonly worktree: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signalCode: string | null;
}): readonly TemplateUpgradeGateProblemEntry[] | undefined {
  if (hasCrashOrNonGateFailure(options.output)) return undefined;
  if (
    !validGateExit(
      options.gate,
      options.exitCode,
      options.timedOut,
      options.signalCode,
    )
  ) {
    return undefined;
  }
  return parseGateProblemsByKind(
    options.gate,
    options.output,
    options.worktree,
  );
}

export function matchTemplateUpgradeGateFailure(options: {
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly checkCommandOutput: string;
  readonly worktree: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signalCode: string | null;
  readonly beforePackage?: string | undefined;
  readonly afterPackage?: string | undefined;
}):
  | {
      readonly gate: TemplateUpgradeGateName;
      readonly gateFiles: readonly string[];
      readonly problems: readonly TemplateUpgradeGateProblem[];
    }
  | undefined {
  if (hasCrashOrNonGateFailure(options.checkCommandOutput)) return undefined;
  const excludedPaths = excludedNonRepositoryPaths(options.rows);
  const gates = changedGateFilesByKind(
    options.rows,
    options.dependencyChanges,
    options.beforePackage,
    options.afterPackage,
  );
  const order: readonly (readonly [
    TemplateUpgradeGateName,
    readonly string[],
  ])[] = [
    ["lint", gates.lint],
    ["format", gates.format],
    ["typecheck", gates.typecheck],
    ["fallow", gates.fallow],
  ];
  for (const [gate, changedFiles] of order) {
    if (changedFiles.length === 0) continue;
    const parsed = parseTemplateUpgradeGateRun({
      gate,
      output: options.checkCommandOutput,
      worktree: options.worktree,
      exitCode: options.exitCode,
      timedOut: options.timedOut,
      signalCode: options.signalCode,
    });
    if (parsed === undefined) continue;
    if (
      parsed.some((entry) =>
        entry.paths.some((path) => excludedPaths.has(path)),
      )
    ) {
      return undefined;
    }
    return {
      gate,
      gateFiles: Object.freeze([...changedFiles]),
      problems: Object.freeze(parsed.map((entry) => entry.problem)),
    };
  }
  return undefined;
}

export function classifyTemplateUpgradeGateFailure(options: {
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
  readonly checkCommandOutput: string;
  readonly worktree: string;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly signalCode: string | null;
  readonly beforePackage?: string | undefined;
  readonly afterPackage?: string | undefined;
  readonly predatedProblems?: readonly TemplateUpgradeGateProblem[] | undefined;
}): TemplateUpgradeGateResult | undefined {
  const matched = matchTemplateUpgradeGateFailure(options);
  if (matched === undefined) return undefined;
  if (!allProblemsPredate(matched.problems, options.predatedProblems)) {
    return undefined;
  }
  return Object.freeze({
    gate: matched.gate,
    gateFiles: matched.gateFiles,
    problems: matched.problems,
    repair: repairForGate(matched.gate, options.worktree),
  });
}
