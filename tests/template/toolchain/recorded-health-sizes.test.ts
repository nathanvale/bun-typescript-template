import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const folder = ownedFolders();

const SHIPPED_WORKFLOW_PATH = join(
  ROOT,
  "generated-repository/hosted-check/ci.yml",
);
const SHIPPED_SETTINGS_DIR = join(ROOT, "generated-repository/settings");
const SHIPPED_SCRIPT_PATH = join(
  ROOT,
  "generated-repository/scripts/check-recorded-health-sizes.ts",
);
const RECORDED_HITS_FILES = [
  "fallow-dead-code-recorded-hits.json",
  "fallow-duplicates-recorded-hits.json",
  "fallow-health-recorded-hits.json",
] as const;

type PlainObject = Record<string, unknown>;

function asRecord(value: unknown): PlainObject | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  return Object.fromEntries(Object.entries(value));
}

function own(record: PlainObject, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

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

function routeSource(cases: number, padLines: number): string {
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

function nestSource(nestedExtra: boolean): string {
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

function longFileSource(lineCount: number): string {
  const body = Array.from(
    { length: lineCount - 1 },
    (_, index) => `const value${index} = ${index};`,
  ).join("\n");
  return `${body}\nexport const total = value0;\n`;
}

function simpleCommandsSource(): string {
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

function withHealthApproval(
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
  })();
  return cachedBaseRecordedHits;
}

async function createFixture(options?: {
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

  if (existsSync(SHIPPED_SCRIPT_PATH)) {
    files["scripts/check-recorded-health-sizes.ts"] = readFileSync(
      SHIPPED_SCRIPT_PATH,
      "utf8",
    );
  }

  if (options?.eslintSuppressions !== undefined) {
    files["eslint-suppressions.json"] = options.eslintSuppressions;
  }

  const { sha: baseSha } = commitIn(repo, "base commit", files);
  return { repo, baseSha, recordedHits };
}

function runHostedGrowthStep(
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

function runScriptDirect(
  repo: string,
  args: readonly string[],
): Promise<{ stdout: string; stderr: string; exit: number }> {
  return spawnBounded(
    [process.execPath, "scripts/check-recorded-health-sizes.ts", ...args],
    {
      cwd: repo,
      env: stepEnvironment(undefined),
      processGroup: true,
    },
  );
}

test(
  "refuses function line growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow function lines", {
      "src/commands.ts": `${routeSource(20, 4)}\n${nestSource(false)}`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("route");
    expect(result.stderr).toContain("function lines 26 to 29");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses cyclomatic complexity growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow cyclomatic complexity without growing lines", {
      "src/commands.ts": `${routeSource(21, 0)}\n${nestSource(false)}`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("route");
    expect(result.stderr).toContain("cyclomatic complexity 21 to 22");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses cognitive complexity growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow cognitive complexity without growing lines", {
      "src/commands.ts": `${routeSource(20, 1)}\n${nestSource(true)}`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("nest");
    expect(result.stderr).toContain("cognitive complexity 16 to 20");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses file line growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow file lines", {
      "src/long.ts": longFileSource(520),
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/long.ts");
    expect(result.stderr).toContain("<file>");
    expect(result.stderr).toContain("file lines 510 to 520");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses a higher suppression count in eslint-suppressions.json",
  async () => {
    const { repo, baseSha } = await createFixture({
      eslintSuppressions: `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 1 } } },
        null,
        2,
      )}\n`,
    });
    commitIn(repo, "raise eslint suppression count", {
      "eslint-suppressions.json": `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 2 } } },
        null,
        2,
      )}\n`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("eslint-suppressions.json");
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("no-console");
    expect(result.stderr).toContain("from 1");
    expect(result.stderr).toContain("to 2");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses a new file and rule pair in eslint-suppressions.json",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "add new eslint suppression pair", {
      "eslint-suppressions.json": `${JSON.stringify(
        { "src/long.ts": { "no-console": { count: 1 } } },
        null,
        2,
      )}\n`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("eslint-suppressions.json");
    expect(result.stderr).toContain("src/long.ts");
    expect(result.stderr).toContain("no-console");
    expect(result.stderr).toContain("from 0");
    expect(result.stderr).toContain("to 1");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses growth when the base revision already holds the same approved value, even with spaces around it",
  async () => {
    const { repo, baseSha, recordedHits } = await createFixture({
      healthApprovals: { longApproved: "PR #10" },
      eslintSuppressions: `${JSON.stringify(
        {
          "src/commands.ts": {
            "no-console": { count: 1, approved: "PR #10" },
          },
        },
        null,
        2,
      )}\n`,
    });
    commitIn(repo, "grow with stale approval", {
      "src/long.ts": longFileSource(515),
      "fallow-health-recorded-hits.json": withHealthApproval(
        recordedHits["fallow-health-recorded-hits.json"] ?? "",
        { longApproved: " PR #10 " },
      ),
      "eslint-suppressions.json": `${JSON.stringify(
        {
          "src/commands.ts": {
            "no-console": { count: 2, approved: " PR #10 " },
          },
        },
        null,
        2,
      )}\n`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/long.ts");
    expect(result.stderr).toContain("file lines 510 to 515");
    expect(result.stderr).toContain("eslint-suppressions.json");
    expect(result.stderr).toContain("src/commands.ts");
  },
  processWatchdog(3),
);

test(
  "passes for unchanged sizes, shrinks, removed findings, and growth with a new approved field",
  async () => {
    const { repo, baseSha, recordedHits } = await createFixture({
      eslintSuppressions: `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 2 } } },
        null,
        2,
      )}\n`,
    });

    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);

    commitIn(repo, "shrink recorded file and suppression", {
      "src/long.ts": longFileSource(505),
      "eslint-suppressions.json": `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 1 } } },
        null,
        2,
      )}\n`,
    });
    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);

    commitIn(repo, "grow with new approvals", {
      "src/commands.ts": `${routeSource(21, 4)}\n${nestSource(true)}`,
      "src/long.ts": longFileSource(520),
      "fallow-health-recorded-hits.json": withHealthApproval(
        recordedHits["fallow-health-recorded-hits.json"] ?? "",
        {
          routeApproved: "PR #20: temporary growth",
          nestApproved: "PR #20: temporary growth",
          longApproved: "PR #20: temporary growth",
        },
      ),
      "eslint-suppressions.json": `${JSON.stringify(
        {
          "src/commands.ts": {
            "no-console": { count: 3, approved: "PR #20: temporary growth" },
          },
          "src/long.ts": {
            "no-console": { count: 1, approved: "PR #20: temporary growth" },
          },
        },
        null,
        2,
      )}\n`,
    });
    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);

    commitIn(repo, "remove findings completely", {
      "src/commands.ts": simpleCommandsSource(),
      "src/long.ts": "export const total = 0;\n",
      "fallow-health-recorded-hits.json": readFileSync(
        join(SHIPPED_SETTINGS_DIR, "fallow-health-recorded-hits.json"),
        "utf8",
      ),
      "eslint-suppressions.json": "{}\n",
    });
    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);
  },
  processWatchdog(5),
);

test(
  "fails closed with exit 2 on an unreadable base file, naming the file and git reason",
  async () => {
    const { repo, baseSha } = await createFixture();
    const blob = git(
      repo,
      "rev-parse",
      `${baseSha}:fallow-health-recorded-hits.json`,
    );
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));

    const result = await runScriptDirect(repo, ["--base", baseSha]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("fallow-health-recorded-hits.json");
    expect(result.stderr).toContain("git cannot read");
  },
  processWatchdog(2),
);

test(
  "fails closed with exit 2 on malformed recorded lists",
  async () => {
    const { repo, baseSha } = await createFixture({
      eslintSuppressions: "{}\n",
    });
    commitIn(repo, "malformed eslint suppressions", {
      "eslint-suppressions.json": JSON.stringify({
        "src/commands.ts": { "no-console": { count: -1 } },
      }),
    });

    const badCount = await runScriptDirect(repo, ["--base", baseSha]);
    expect(badCount.exit).toBe(2);
    expect(badCount.stderr).toContain("eslint-suppressions.json");
    expect(badCount.stderr).toContain("is not");

    commitIn(
      repo,
      "non-identity health baseline without identity_finding_counts",
      {
        "eslint-suppressions.json": "{}\n",
        "fallow-health-recorded-hits.json": JSON.stringify({
          kind: "health",
          finding_counts: {
            "src/long.ts": { complexity_moderate: { count: 1 } },
          },
          runtime_coverage_findings: [],
          target_keys: [],
        }),
      },
    );

    const nonIdentity = await runScriptDirect(repo, ["--base", baseSha]);
    expect(nonIdentity.exit).toBe(2);
    expect(nonIdentity.stderr).toContain("fallow-health-recorded-hits.json");
    expect(nonIdentity.stderr).toContain("is not");
  },
  processWatchdog(2),
);
