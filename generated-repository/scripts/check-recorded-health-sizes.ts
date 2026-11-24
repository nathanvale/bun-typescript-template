import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

type Options = {
  readonly base: string;
  readonly head: string;
  readonly root: string;
  readonly fallow: string;
};
type CountEntry = {
  readonly count: number;
  readonly approved: string | undefined;
};
type CountTable = Map<string, Map<string, CountEntry>>;
type FindingMetric = {
  readonly lineCount: number;
  readonly cyclomatic: number;
  readonly cognitive: number;
};
type HealthData = {
  readonly options: Options;
  readonly baseHealth: CountTable;
  readonly headHealth: CountTable | undefined;
  readonly baseMetrics: ReadonlyMap<string, FindingMetric[]>;
  readonly headMetrics: ReadonlyMap<string, FindingMetric[]>;
};

const HEALTH_FILE = "fallow-health-recorded-hits.json";
const ESLINT_FILE = "eslint-suppressions.json";
const GIT_MS = 15_000;
const FALLOW_MS = 60_000;
const GIT_LOC_VARS = new Set(
  "GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR GIT_PREFIX GIT_SUPER_PREFIX GIT_QUARANTINE_PATH".split(
    " ",
  ),
);
const HEALTH_KEYS =
  "kind finding_counts identity_finding_counts runtime_coverage_findings target_keys approved".split(
    " ",
  );
const FALLOW_ARGS =
  "health --complexity --no-type-aware --report-only --format json --quiet --no-cache".split(
    " ",
  );
const KNOWN_FLAGS = new Set(["--base", "--head", "--root", "--fallow"]);

const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function fail(message: string): never {
  throw new Error(message);
}
function refuseShape(where: string, shape: string): never {
  fail(
    `${where} is not ${shape}, so the recorded health sizes check cannot read it. Repair: restore that shape, then run this check again.`,
  );
}
function badFallowField(rev: string, key: string): never {
  fail(
    `fallow health JSON at ${rev} has invalid finding field "${key}". Repair: install the pinned fallow with bun install --frozen-lockfile, then run this check again.`,
  );
}

function runGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>> = {},
) {
  const env: Record<string, string | undefined> = {
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_LAZY_FETCH: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    ...extra,
  };
  for (const [k, v] of Object.entries(process.env))
    if (!GIT_LOC_VARS.has(k) && !Object.hasOwn(env, k)) env[k] = v;
  const run = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: GIT_MS,
    killSignal: "SIGKILL",
  });
  if (run.exitedDueToTimeout)
    fail(
      `git ${args.join(" ")} did not finish within ${GIT_MS} ms. Repair: resolve the git lock or slow disk, then run this check again.`,
    );
  return {
    exitCode: run.exitCode,
    stdout: run.stdout.toString(),
    stderr: run.stderr.toString(),
  };
}

function resolveCommit(root: string, rev: string): string {
  const res = runGit(root, [
    ..."rev-parse --verify --quiet".split(" "),
    `${rev}^{commit}`,
  ]);
  if (res.exitCode !== 0)
    fail(
      `git cannot resolve commit ${rev}: ${res.stderr.trim() || `exit ${res.exitCode}`}. Repair: fetch ${rev} with full history, then run this check again.`,
    );
  return res.stdout.trim();
}

function readCommittedFile(root: string, rev: string, file: string) {
  const listed = runGit(root, ["ls-tree", rev, "--", file]);
  if (listed.exitCode === 0 && listed.stdout === "") return undefined;
  const shown = runGit(root, ["show", `${rev}:${file}`]);
  if (listed.exitCode !== 0 || shown.exitCode !== 0) {
    const reason = [listed.stderr.trim(), shown.stderr.trim()]
      .filter(Boolean)
      .join(" ");
    fail(
      `git cannot read ${file} at ${rev}: ${reason || `exit ${shown.exitCode}`}. Repair: run git fsck, or fetch ${rev} with full history, then run this check again.`,
    );
  }
  return shown.stdout;
}

function parseJson(text: string, where: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    fail(
      `${where} is not valid JSON: ${error instanceof Error ? error.message : String(error)}. Repair: restore valid JSON, then run this check again.`,
    );
  }
}

function asOwnMap(
  value: unknown,
  where: string,
  shape: string,
  keys?: readonly string[],
) {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return refuseShape(where, shape);
  const own = new Map<string, unknown>(Object.entries(value));
  if (keys !== undefined && [...own.keys()].some((k) => !keys.includes(k)))
    return refuseShape(where, shape);
  return own;
}

function parseCountEntry(value: unknown, where: string, shape: string) {
  const own = asOwnMap(value, where, shape, ["count", "approved"]);
  const count = own.get("count");
  if (typeof count !== "number" || !Number.isSafeInteger(count) || count < 0)
    return refuseShape(where, shape);
  const approved = own.get("approved");
  if (approved !== undefined && typeof approved !== "string")
    return refuseShape(where, shape);
  const trimmed = approved?.trim();
  return { count, approved: trimmed === "" ? undefined : trimmed };
}

function parseCountTable(value: unknown, where: string, shape: string) {
  const table: CountTable = new Map();
  for (const [key, kindsValue] of asOwnMap(value, where, shape)) {
    const kinds = new Map<string, CountEntry>();
    for (const [kind, record] of asOwnMap(kindsValue, where, shape))
      kinds.set(kind, parseCountEntry(record, where, shape));
    table.set(key, kinds);
  }
  return table;
}

function parseHealthHits(text: string, rev: string): CountTable {
  const where = `${HEALTH_FILE} at ${rev}`;
  const shape = `{ ${HEALTH_KEYS.join(", ")}? } as fallow health --baseline-mode identity --save-baseline writes it`;
  const own = asOwnMap(parseJson(text, where), where, shape, HEALTH_KEYS);
  if (own.get("kind") !== "health") return refuseShape(where, shape);
  const counts = own.get("finding_counts");
  const findingCounts =
    counts === undefined ? undefined : parseCountTable(counts, where, shape);
  for (const field of ["runtime_coverage_findings", "target_keys"]) {
    const list = own.get(field);
    if (!Array.isArray(list) || list.some((item) => typeof item !== "string"))
      return refuseShape(where, shape);
  }
  const identities = own.get("identity_finding_counts");
  if (identities === undefined) {
    if (findingCounts !== undefined && findingCounts.size > 0)
      return refuseShape(where, shape);
    return new Map();
  }
  return parseCountTable(identities, where, shape);
}

function findingNum(own: ReadonlyMap<string, unknown>, k: string, rev: string) {
  const v = own.get(k);
  return typeof v === "number" && Number.isFinite(v) && v >= 0
    ? v
    : badFallowField(rev, k);
}

function findingStr(own: ReadonlyMap<string, unknown>, k: string, rev: string) {
  const v = own.get(k);
  return typeof v === "string" && v !== "" ? v : badFallowField(rev, k);
}

function parseFallowFindings(stdout: string, rev: string) {
  const where = `fallow health output at ${rev}`;
  const findings = asOwnMap(
    parseJson(stdout, where),
    where,
    '{ "findings": [...] }',
  ).get("findings");
  if (!Array.isArray(findings)) badFallowField(rev, "findings");
  const byIdentity = new Map<string, FindingMetric[]>();
  for (const item of findings) {
    const own = asOwnMap(item, where, "a finding");
    const key = `${findingStr(own, "path", rev)}\0${findingStr(own, "name", rev)}`;
    const metric = {
      lineCount: findingNum(own, "line_count", rev),
      cyclomatic: findingNum(own, "cyclomatic", rev),
      cognitive: findingNum(own, "cognitive", rev),
    };
    const list = byIdentity.get(key);
    if (list === undefined) byIdentity.set(key, [metric]);
    else list.push(metric);
  }
  return byIdentity;
}

function runFallowHealth(fallowBin: string, treeDir: string, rev: string) {
  let run: Bun.SyncSubprocess<"pipe", "pipe">;
  try {
    run = Bun.spawnSync([fallowBin, ...FALLOW_ARGS, "--root", treeDir], {
      cwd: treeDir,
      stdout: "pipe",
      stderr: "pipe",
      timeout: FALLOW_MS,
      killSignal: "SIGKILL",
    });
  } catch (error) {
    fail(
      `cannot run fallow at ${fallowBin}: ${error instanceof Error ? error.message : String(error)}. Repair: run bun install --frozen-lockfile, then run this check again.`,
    );
  }
  if (run.exitedDueToTimeout)
    fail(
      `fallow health at ${rev} did not finish within ${FALLOW_MS} ms. Repair: run fallow health by hand to see where it waits, then run this check again.`,
    );
  if (run.exitCode !== 0)
    fail(
      `fallow health at ${rev} exited ${run.exitCode}: ${run.stderr.toString().trim()}. Repair: run bun install --frozen-lockfile and verify .fallowrc.json, then run this check again.`,
    );
  return run.stdout.toString();
}

function mustGit(
  root: string,
  args: readonly string[],
  extra: Readonly<Record<string, string>>,
  repair: string,
) {
  const res = runGit(root, args, extra);
  if (res.exitCode !== 0)
    fail(
      `git ${args[0] ?? ""} failed: ${res.stderr.trim() || `exit ${res.exitCode}`}. Repair: ${repair}, then run this check again.`,
    );
}

function measureHealthAt(root: string, rev: string, fallowBin: string) {
  const tempDir = mkdtempSync(join(tmpdir(), "recorded-health-sizes-"));
  try {
    const extra = { GIT_INDEX_FILE: join(tempDir, "index") };
    const tree = join(tempDir, "tree");
    mkdirSync(tree, { recursive: true });
    mustGit(root, ["read-tree", rev], extra, `fetch ${rev} with full history`);
    mustGit(
      root,
      ["checkout-index", "-a", `--prefix=${tree}/`],
      extra,
      "run git fsck",
    );
    return parseFallowFindings(runFallowHealth(fallowBin, tree, rev), rev);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function metricGrowth(
  baseList: readonly FindingMetric[],
  headList: readonly FindingMetric[],
  read: (metric: FindingMetric) => number,
): readonly [number, number] | undefined {
  const baseValues = baseList.map(read).toSorted((a, b) => b - a);
  const headValues = headList.map(read).toSorted((a, b) => b - a);
  for (let i = 0; i < headValues.length; i += 1) {
    const after = headValues[i];
    const before = baseValues[i] ?? 0;
    if (after !== undefined && after > before) return [before, after];
  }
  return undefined;
}

function hasNewHealthApproval(
  baseKinds: ReadonlyMap<string, CountEntry> | undefined,
  headKinds: ReadonlyMap<string, CountEntry> | undefined,
) {
  if (headKinds === undefined) return false;
  const held = new Set<string>();
  for (const entry of baseKinds?.values() ?? [])
    if (entry.approved !== undefined) held.add(entry.approved);
  for (const entry of headKinds.values())
    if (entry.approved !== undefined && !held.has(entry.approved)) return true;
  return false;
}

function grownMetricsFor(
  name: string,
  baseList: readonly FindingMetric[],
  headList: readonly FindingMetric[],
) {
  const checks: readonly [string, (m: FindingMetric) => number][] =
    name === "<file>"
      ? [["file lines", (m) => m.lineCount]]
      : [
          ["function lines", (m) => m.lineCount],
          ["cyclomatic complexity", (m) => m.cyclomatic],
          ["cognitive complexity", (m) => m.cognitive],
        ];
  return checks.flatMap(([label, read]) => {
    const change = metricGrowth(baseList, headList, read);
    return change === undefined
      ? []
      : [`${label} ${change[0]} to ${change[1]}`];
  });
}

function healthRefusalFor(identity: string, data: HealthData) {
  const headList = data.headMetrics.get(identity);
  if (headList === undefined || headList.length === 0) return undefined;
  const sep = identity.indexOf("\0");
  const path = sep === -1 ? identity : identity.slice(0, sep);
  const name = sep === -1 ? "" : identity.slice(sep + 1);
  const grown = grownMetricsFor(
    name,
    data.baseMetrics.get(identity) ?? [],
    headList,
  );
  if (
    grown.length === 0 ||
    hasNewHealthApproval(
      data.baseHealth.get(identity),
      data.headHealth?.get(identity),
    )
  )
    return undefined;
  const finding = name === "<file>" ? "(<file>)" : `function ${name}`;
  const target = name === "<file>" ? path : `${name} in ${path}`;
  return `${HEALTH_FILE}: ${path} ${finding} grew from ${data.options.base} to ${data.options.head}: ${grown.join(", ")}. Repair: shrink ${target}, or make a reviewed change that gives its entry in ${HEALTH_FILE} a new "approved" field naming the ticket or pull request and its reason.`;
}

function readPair(
  options: Options,
  file: string,
  parse: (text: string, rev: string) => CountTable,
) {
  const load = (rev: string) => {
    const text = readCommittedFile(options.root, rev, file);
    return text === undefined ? undefined : parse(text, rev);
  };
  return [load(options.base), load(options.head)] as const;
}

function compareHealthSizes(
  options: Options,
  baseSha: string,
  headSha: string,
) {
  const [baseHealth, headHealth] = readPair(
    options,
    HEALTH_FILE,
    parseHealthHits,
  );
  if (baseHealth === undefined) return [];
  const identities = [...baseHealth.entries()]
    .filter(([, kinds]) => [...kinds.values()].some((entry) => entry.count > 0))
    .map(([identity]) => identity)
    .toSorted(byCodeUnit);
  if (identities.length === 0) return [];
  const data: HealthData = {
    options,
    baseHealth,
    headHealth,
    baseMetrics: measureHealthAt(options.root, baseSha, options.fallow),
    headMetrics: measureHealthAt(options.root, headSha, options.fallow),
  };
  return identities.flatMap((id) => {
    const refusal = healthRefusalFor(id, data);
    return refusal === undefined ? [] : [refusal];
  });
}

function suppressionRefusalFor(
  file: string,
  rule: string,
  headEntry: CountEntry,
  baseEntry: CountEntry | undefined,
  options: Options,
) {
  const baseCount = baseEntry?.count ?? 0;
  if (
    headEntry.count <= baseCount ||
    (headEntry.approved !== undefined &&
      headEntry.approved !== baseEntry?.approved)
  )
    return undefined;
  const shrink =
    baseCount === 0
      ? "fix the lint error and remove the suppression"
      : `fix the lint error to shrink the count to ${baseCount} or fewer`;
  return `${ESLINT_FILE}: ${file} rule ${rule} suppression count grew from ${baseCount} at ${options.base} to ${headEntry.count} at ${options.head}. Repair: ${shrink}, or make a reviewed change that gives its entry in ${ESLINT_FILE} a new "approved" field naming the ticket or pull request and its reason.`;
}

function compareEslintSuppressions(options: Options) {
  const [baseTable, headTable] = readPair(options, ESLINT_FILE, (text, rev) =>
    parseCountTable(
      parseJson(text, `${ESLINT_FILE} at ${rev}`),
      `${ESLINT_FILE} at ${rev}`,
      '{ "<path>": { "<rule>": { count, approved? } } }',
    ),
  );
  if (headTable === undefined) return [];
  return [...headTable.keys()].toSorted(byCodeUnit).flatMap((file) => {
    const headRules = headTable.get(file);
    if (headRules === undefined) return [];
    return [...headRules.keys()].toSorted(byCodeUnit).flatMap((rule) => {
      const headEntry = headRules.get(rule);
      const refusal =
        headEntry === undefined
          ? undefined
          : suppressionRefusalFor(
              file,
              rule,
              headEntry,
              baseTable?.get(file)?.get(rule),
              options,
            );
      return refusal === undefined ? [] : [refusal];
    });
  });
}

function parseArguments(args: readonly string[], defaultRoot: string) {
  if (args.length === 0 || args.length % 2 !== 0) return undefined;
  const flags = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const [flag = "", val = ""] = [args[i], args[i + 1]];
    if (
      !KNOWN_FLAGS.has(flag) ||
      flags.has(flag) ||
      !val ||
      val.startsWith("-")
    )
      return undefined;
    flags.set(flag, val);
  }
  const base = flags.get("--base");
  if (base === undefined) return undefined;
  const root = resolve(flags.get("--root") ?? defaultRoot);
  const fallow = resolve(
    flags.get("--fallow") ?? join(root, "node_modules/.bin/fallow"),
  );
  return { base, head: flags.get("--head") ?? "HEAD", root, fallow };
}

function main(args: readonly string[], defaultRoot: string): number {
  const options = parseArguments(args, defaultRoot);
  if (options === undefined) {
    process.stderr.write(
      "Usage: bun scripts/check-recorded-health-sizes.ts --base <revision> [--head <revision>] [--root <folder>] [--fallow <path>]\n",
    );
    return 2;
  }
  try {
    const baseSha = resolveCommit(options.root, options.base);
    const headSha = resolveCommit(options.root, options.head);
    const refusals = [
      ...compareHealthSizes(options, baseSha, headSha),
      ...compareEslintSuppressions(options),
    ];
    if (refusals.length === 0) return 0;
    process.stderr.write(`${refusals.join("\n")}\n`);
    return 1;
  } catch (error) {
    process.stderr.write(
      `check-recorded-health-sizes: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 2;
  }
}

if (import.meta.main)
  process.exitCode = main(process.argv.slice(2), process.cwd());
