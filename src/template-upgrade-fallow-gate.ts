import type { TemplateUpgradeGateProblem } from "./template-upgrade-gates.ts";

export interface TemplateUpgradeGateProblemEntry {
  readonly problem: TemplateUpgradeGateProblem;
  readonly paths: readonly string[];
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

function makeParsedProblem(
  problem: TemplateUpgradeGateProblem,
  extraPaths: readonly string[] = [],
): TemplateUpgradeGateProblemEntry {
  const paths = [problem.path, ...extraPaths].filter((path) => path !== "");
  return { problem: Object.freeze(problem), paths };
}

function collectBoundaryViolations(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblemEntry[] {
  const problems: TemplateUpgradeGateProblemEntry[] = [];
  for (const entry of readArrayField(check, "boundary_violations")) {
    const item = asObject(entry);
    if (item === undefined) continue;
    const from = readStringField(item, "from_path") ?? "";
    const to = readStringField(item, "to_path") ?? "";
    const fromZone = readStringField(item, "from_zone") ?? "";
    const toZone = readStringField(item, "to_zone") ?? "";
    problems.push(
      makeParsedProblem(
        {
          gate: "fallow",
          code: "boundary-violation",
          path: from,
          message: `${from} imports ${to} (${fromZone} -> ${toZone})`,
        },
        [to],
      ),
    );
  }
  return problems;
}

function collectBoundaryCoverage(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblemEntry[] {
  const problems: TemplateUpgradeGateProblemEntry[] = [];
  for (const entry of readArrayField(check, "boundary_coverage_violations")) {
    const item = asObject(entry);
    const path = item === undefined ? undefined : readStringField(item, "path");
    if (path === undefined) continue;
    problems.push(
      makeParsedProblem({
        gate: "fallow",
        code: "boundary-coverage",
        path,
        message: `${path} does not match any boundary zone`,
      }),
    );
  }
  return problems;
}

function collectBoundaryCalls(
  check: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblemEntry[] {
  const problems: TemplateUpgradeGateProblemEntry[] = [];
  for (const entry of readArrayField(check, "boundary_call_violations")) {
    const item = asObject(entry);
    if (item === undefined) continue;
    const path =
      readStringField(item, "from_path") ?? readStringField(item, "path") ?? "";
    const to = readStringField(item, "to_path") ?? "";
    problems.push(
      makeParsedProblem(
        {
          gate: "fallow",
          code: "boundary-call",
          path,
          message:
            to === ""
              ? `${path} violates boundary call`
              : `${path} calls ${to}`,
        },
        [to],
      ),
    );
  }
  return problems;
}

function extractDeadCodePaths(
  item: Readonly<Record<string, unknown>>,
): readonly string[] {
  const paths: string[] = [];
  const direct = readStringField(item, "path");
  if (direct !== undefined && direct !== "") paths.push(direct);
  for (const loc of readArrayField(item, "locations")) {
    const locObj = asObject(loc);
    const locPath =
      locObj === undefined ? undefined : readStringField(locObj, "path");
    if (locPath !== undefined && locPath !== "") paths.push(locPath);
  }
  for (const file of readArrayField(item, "files")) {
    if (typeof file === "string" && file !== "") paths.push(file);
  }
  return paths.length > 0 ? paths : ["package.json"];
}

function extractDeadCodeDetail(
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
): TemplateUpgradeGateProblemEntry[] {
  const problems: TemplateUpgradeGateProblemEntry[] = [];
  for (const field of DEAD_CODE_FIELDS) {
    const code =
      field === "re_export_cycles"
        ? "re-export-cycle"
        : field.replaceAll("_", "-");
    for (const entry of readArrayField(check, field)) {
      if (typeof entry === "string") {
        problems.push(
          makeParsedProblem({
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
      const paths = extractDeadCodePaths(item);
      const path = paths[0] ?? "package.json";
      problems.push(
        makeParsedProblem(
          {
            gate: "fallow",
            code,
            path,
            message: extractDeadCodeDetail(code, item, path),
          },
          paths.slice(1),
        ),
      );
    }
  }
  return problems;
}

function collectDupeInstancePaths(
  group: Readonly<Record<string, unknown>>,
): readonly string[] {
  const paths: string[] = [];
  for (const instance of readArrayField(group, "instances")) {
    const item = asObject(instance);
    if (item === undefined) continue;
    const path = readStringField(item, "file") ?? readStringField(item, "path");
    if (path !== undefined && path !== "") paths.push(path);
  }
  return paths.length > 0 ? paths : ["src"];
}

function collectDupeProblems(
  report: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblemEntry[] {
  const dupes = asObject(report.dupes);
  if (dupes === undefined) return [];
  const problems: TemplateUpgradeGateProblemEntry[] = [];
  for (const entry of readArrayField(dupes, "clone_groups")) {
    const group = asObject(entry);
    if (group === undefined) continue;
    const paths = collectDupeInstancePaths(group);
    const path = paths[0] ?? "src";
    problems.push(
      makeParsedProblem(
        {
          gate: "fallow",
          code: "duplicate-code",
          path,
          message: `duplicate code group in ${path}`,
        },
        paths.slice(1),
      ),
    );
  }
  return problems;
}

function collectHealthProblems(
  report: Readonly<Record<string, unknown>>,
): TemplateUpgradeGateProblemEntry[] {
  const health = asObject(report.health);
  if (health === undefined) return [];
  const problems: TemplateUpgradeGateProblemEntry[] = [];
  for (const entry of readArrayField(health, "findings")) {
    const finding = asObject(entry);
    if (finding === undefined) continue;
    const path = readStringField(finding, "path") ?? "src";
    const name = readStringField(finding, "name") ?? path;
    problems.push(
      makeParsedProblem({
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

const FALLOW_FINDING_GATES = [
  "error-severity-findings",
  "duplication-findings",
  "health-findings",
] as const;

function fallowGateOutcomesValid(
  combined: Readonly<Record<string, unknown>>,
): boolean {
  const outcomes = asObject(combined.gate_outcomes);
  if (outcomes === undefined) return false;
  const typeAware = asObject(outcomes["type-aware-require"]);
  if (
    typeAware !== undefined &&
    readStringField(typeAware, "status") === "fail"
  ) {
    return false;
  }
  return FALLOW_FINDING_GATES.some((gateName) => {
    const entry = asObject(outcomes[gateName]);
    return (
      entry !== undefined &&
      readStringField(entry, "status") === "fail" &&
      entry.enforced === true
    );
  });
}

export function parseFallowGateProblems(
  checkOutput: string,
  normalizePath: (rawPath: string) => string,
): readonly TemplateUpgradeGateProblemEntry[] | undefined {
  const combined = findFallowCombinedJson(checkOutput);
  if (combined === undefined || !fallowGateOutcomesValid(combined)) {
    return undefined;
  }
  const check = asObject(combined.check);
  const rawProblems = [
    ...(check === undefined ? [] : collectBoundaryViolations(check)),
    ...(check === undefined ? [] : collectBoundaryCoverage(check)),
    ...(check === undefined ? [] : collectBoundaryCalls(check)),
    ...(check === undefined ? [] : collectDeadCodeProblems(check)),
    ...collectDupeProblems(combined),
    ...collectHealthProblems(combined),
  ];
  if (rawProblems.length === 0) return undefined;
  return rawProblems.map(({ problem, paths }) => ({
    problem: Object.freeze({
      ...problem,
      path: normalizePath(problem.path),
    }),
    paths: paths.map(normalizePath),
  }));
}
