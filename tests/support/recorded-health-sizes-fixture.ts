import { readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { ownedFolders } from "./fixture-files.ts";
import { asRecord, own } from "./generated-hosted-check.ts";
import { commitIn, gitEnv, inherited, initRepository } from "./git-fixture.ts";
import { spawnBounded } from "./process.ts";

const folder = ownedFolders();

const SHIPPED_WORKFLOW_PATH = join(
  ROOT,
  "generated-repository/hosted-check/ci.yml",
);
export const SHIPPED_SETTINGS_DIR = join(ROOT, "generated-repository/settings");
const SHIPPED_SCRIPTS = [
  "check-recorded-health-sizes.ts",
  "fallow-health-at-base-settings.ts",
] as const;
const RECORDED_HITS_FILES = [
  "fallow-dead-code-recorded-hits.json",
  "fallow-duplicates-recorded-hits.json",
  "fallow-health-recorded-hits.json",
] as const;

function readRecordedHitsGrowthStepRun(): string {
  const parsed = asRecord(
    Bun.YAML.parse(readFileSync(SHIPPED_WORKFLOW_PATH, "utf8")),
  );
  const jobs = parsed === undefined ? undefined : asRecord(own(parsed, "jobs"));
  const check = jobs === undefined ? undefined : asRecord(own(jobs, "check"));
  const rawSteps = check === undefined ? undefined : own(check, "steps");
  if (!Array.isArray(rawSteps))
    throw new Error("generated-repository/hosted-check/ci.yml has no steps");
  const growthStep = rawSteps
    .map(asRecord)
    .find(
      (step) =>
        step !== undefined &&
        own(step, "name") === "Check Fallow recorded hits did not grow",
    );
  const run = growthStep === undefined ? undefined : own(growthStep, "run");
  if (typeof run !== "string" || run.trim() === "")
    throw new Error(
      "generated-repository/hosted-check/ci.yml has no recorded-hits growth step",
    );
  return run;
}

function stepEnvironment(
  base: string | undefined,
): Record<string, string | undefined> {
  const baseEnv = inherited();
  const bunBin = dirname(process.execPath);
  const currentPath = baseEnv.PATH ?? "";
  const nextPath = currentPath.includes(bunBin)
    ? currentPath
    : `${bunBin}:${currentPath}`;
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    ...gitEnv,
    NO_COLOR: "1",
    PATH: nextPath,
  };
  if (base === undefined) Reflect.deleteProperty(env, "BASE");
  else env.BASE = base;
  return env;
}

function switchCases(count: number): string {
  return Array.from(
    { length: count },
    (_, index) => `    case ${index}: return ${index};`,
  ).join("\n");
}

export function routeSource(cases: number, padLines: number): string {
  const padding = Array.from(
    { length: padLines },
    (_, index) => `  const step${index} = value + ${index};`,
  ).join("\n");
  const fallback = padLines > 0 ? `step${padLines - 1}` : "value + 1";
  const prefix = padding === "" ? "" : `${padding}\n`;
  return `export function route(value: number): number {
${prefix}  switch (value) {
${switchCases(cases)}
    default: return ${fallback};
  }
}
`;
}

export function nestSource(nestedExtra: boolean): string {
  if (nestedExtra) {
    return `export function nest(value: number): number {
  if (value > 1) {
    if (value > 2) {
      if (value > 3) {
        if (value > 4) {
          if (value > 5) return 5;
          if (value === 99) return 99;
        }
      }
    }
  }
  return 0;
}
`;
  }
  return `export function nest(value: number): number {
  if (value > 1) {
    if (value > 2) {
      if (value > 3) {
        if (value > 4) {
          if (value > 5) return 5;
        }
      }
    }
  }
  if (value === 99) return 99;
  return 0;
}
`;
}

export function longFileSource(lineCount: number): string {
  const body = Array.from(
    { length: lineCount - 1 },
    (_, index) => `const value${index} = ${index};`,
  ).join("\n");
  return `${body}\nexport const total = value0;\n`;
}

export function longTestSource(lineCount: number): string {
  const pads = Array.from(
    { length: lineCount - 4 },
    (_, index) => `const pad${index} = ${index};`,
  );
  const lines = [
    'import { expect, test } from "bun:test";',
    ...pads,
    'test("pads", () => {',
    "  expect(pad0).toBe(0);",
    "});",
  ];
  return `${lines.join("\n")}\n`;
}

export function withFallowSettings(
  change: (shipped: {
    readonly ignorePatterns: readonly string[];
    readonly health: Readonly<Record<string, unknown>>;
    readonly rules: Readonly<Record<string, unknown>>;
  }) => object,
): string {
  const shipped = JSON.parse(
    readFileSync(join(SHIPPED_SETTINGS_DIR, ".fallowrc.json"), "utf8"),
  ) as Parameters<typeof change>[0];
  return `${JSON.stringify(change(shipped), null, 2)}\n`;
}

export function shippedScripts(): Record<string, string> {
  return Object.fromEntries(
    SHIPPED_SCRIPTS.map((name) => [
      `scripts/${name}`,
      readFileSync(join(ROOT, "generated-repository/scripts", name), "utf8"),
    ]),
  );
}

export function simpleCommandsSource(): string {
  return `export function route(value: number): number {
  return value + 1;
}
export function nest(value: number): number {
  return value + 2;
}
`;
}

function fixturePackageJson(): string {
  const shipped = JSON.parse(
    readFileSync(join(SHIPPED_SETTINGS_DIR, "package.json"), "utf8"),
  ) as { scripts: Record<string, string>; [key: string]: unknown };
  return `${JSON.stringify(
    {
      ...shipped,
      name: "demo-app",
      dependencies: {},
    },
    null,
    2,
  )}\n`;
}

export function withHealthApproval(
  healthJson: string,
  overrides: {
    readonly routeApproved?: string;
    readonly nestApproved?: string;
    readonly longApproved?: string;
  },
): string {
  const parsed = JSON.parse(healthJson) as {
    identity_finding_counts: Record<
      string,
      Record<string, { count: number; approved?: string }>
    >;
  };
  const setApproved = (identity: string, approved: string | undefined) => {
    if (approved === undefined) return;
    const kinds = parsed.identity_finding_counts[identity];
    const firstKind = kinds === undefined ? undefined : Object.keys(kinds)[0];
    const entry = firstKind === undefined ? undefined : kinds?.[firstKind];
    if (entry !== undefined) entry.approved = approved;
  };
  setApproved("src/commands.ts\u0000route", overrides.routeApproved);
  setApproved("src/commands.ts\u0000nest", overrides.nestApproved);
  setApproved("src/long.ts\u0000<file>", overrides.longApproved);
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

let cachedBaseRecordedHits: Promise<Record<string, string>> | undefined;

async function baseRecordedHits(): Promise<Record<string, string>> {
  cachedBaseRecordedHits ??= (async () => {
    const repo = folder("recorded-health-sizes-seed-");
    initRepository(repo);
    symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
    commitIn(repo, "seed", {
      ".gitignore": "node_modules\n",
      ".fallowrc.json": readFileSync(
        join(SHIPPED_SETTINGS_DIR, ".fallowrc.json"),
        "utf8",
      ),
      "package.json": fixturePackageJson(),
      "tsconfig.base.json": readFileSync(
        join(SHIPPED_SETTINGS_DIR, "tsconfig.base.json"),
        "utf8",
      ),
      "tsconfig.json": readFileSync(
        join(SHIPPED_SETTINGS_DIR, "tsconfig.json"),
        "utf8",
      ),
      "src/cli.ts":
        'import { nest, route } from "./commands.ts";\nimport { total } from "./long.ts";\nexport function main(): number {\n  return route(1) + nest(1) + total;\n}\nmain();\n',
      "src/commands.ts": `${routeSource(20, 1)}\n${nestSource(false)}`,
      "src/long.ts": longFileSource(510),
      "tests/cli.test.ts":
        'import { expect, test } from "bun:test";\nimport { nest, route } from "../src/commands.ts";\nimport { total } from "../src/long.ts";\ntest("uses modules", () => {\n  expect(route(1) + nest(1) + total).toBeGreaterThanOrEqual(0);\n});\n',
      ...Object.fromEntries(
        RECORDED_HITS_FILES.map((file) => [
          file,
          readFileSync(join(SHIPPED_SETTINGS_DIR, file), "utf8"),
        ]),
      ),
    });
    return recordHitsIn(repo);
  })();
  return cachedBaseRecordedHits;
}

export async function recordHitsIn(
  repo: string,
): Promise<Record<string, string>> {
  const run = await spawnBounded(
    [process.execPath, "run", "quality:fallow:record-hits"],
    {
      cwd: repo,
      env: stepEnvironment(undefined),
      processGroup: true,
    },
  );
  if (run.exit !== 0) {
    throw new Error(
      `quality:fallow:record-hits failed with exit ${run.exit}: ${run.stderr}\n${run.stdout}`,
    );
  }
  return Object.fromEntries(
    RECORDED_HITS_FILES.map((file) => [
      file,
      readFileSync(join(repo, file), "utf8"),
    ]),
  );
}

export async function createFixture(options?: {
  readonly eslintSuppressions?: string;
  readonly healthApprovals?: {
    readonly routeApproved?: string;
    readonly nestApproved?: string;
    readonly longApproved?: string;
  };
}): Promise<{
  readonly repo: string;
  readonly baseSha: string;
  readonly recordedHits: Record<string, string>;
}> {
  const recordedHits = await baseRecordedHits();
  const repo = folder("recorded-health-sizes-");
  initRepository(repo);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));

  const files: Record<string, string> = {
    ".gitignore": "node_modules\n",
    ".fallowrc.json": readFileSync(
      join(SHIPPED_SETTINGS_DIR, ".fallowrc.json"),
      "utf8",
    ),
    "package.json": fixturePackageJson(),
    "tsconfig.base.json": readFileSync(
      join(SHIPPED_SETTINGS_DIR, "tsconfig.base.json"),
      "utf8",
    ),
    "tsconfig.json": readFileSync(
      join(SHIPPED_SETTINGS_DIR, "tsconfig.json"),
      "utf8",
    ),
    ".github/workflows/ci.yml": readFileSync(SHIPPED_WORKFLOW_PATH, "utf8"),
    "src/cli.ts":
      'import { nest, route } from "./commands.ts";\nimport { total } from "./long.ts";\nexport function main(): number {\n  return route(1) + nest(1) + total;\n}\nmain();\n',
    "src/commands.ts": `${routeSource(20, 1)}\n${nestSource(false)}`,
    "src/long.ts": longFileSource(510),
    "tests/cli.test.ts":
      'import { expect, test } from "bun:test";\nimport { nest, route } from "../src/commands.ts";\nimport { total } from "../src/long.ts";\ntest("uses modules", () => {\n  expect(route(1) + nest(1) + total).toBeGreaterThanOrEqual(0);\n});\n',
    ...recordedHits,
  };

  if (options?.healthApprovals !== undefined) {
    files["fallow-health-recorded-hits.json"] = withHealthApproval(
      recordedHits["fallow-health-recorded-hits.json"] ?? "",
      options.healthApprovals,
    );
  }

  Object.assign(files, shippedScripts());

  if (options?.eslintSuppressions !== undefined) {
    files["eslint-suppressions.json"] = options.eslintSuppressions;
  }

  const { sha: baseSha } = commitIn(repo, "base commit", files);
  return { repo, baseSha, recordedHits };
}

export function runHostedGrowthStep(
  repo: string,
  base: string,
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const stepRun = readRecordedHitsGrowthStepRun();
  return spawnBounded(["bash", "-e", "-c", stepRun], {
    cwd: repo,
    env: stepEnvironment(base),
    processGroup: true,
  });
}

export function runScriptDirect(
  repo: string,
  args: readonly string[],
  env: Readonly<Record<string, string>> = {},
): Promise<{ stdout: string; stderr: string; exit: number }> {
  return spawnBounded(
    [process.execPath, "scripts/check-recorded-health-sizes.ts", ...args],
    {
      cwd: repo,
      env: { ...stepEnvironment(undefined), ...env },
      processGroup: true,
    },
  );
}
