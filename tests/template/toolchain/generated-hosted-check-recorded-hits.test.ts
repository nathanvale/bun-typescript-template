import { expect, test } from "bun:test";
import { copyFileSync, readFileSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commitIn,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { shippedScripts } from "../../support/recorded-health-sizes-fixture.ts";

const folder = ownedFolders();

const SHIPPED_WORKFLOW_PATH = join(
  ROOT,
  "generated-repository/hosted-check/ci.yml",
);
const SHIPPED_SETTINGS_DIR = join(ROOT, "generated-repository/settings");
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
      "generated-repository/hosted-check/ci.yml has no recorded-hits growth step after bun run check",
    );
  return run;
}

function complexModuleSource(name: string): string {
  return `export function ${name}(value: number): number {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  if (value === 7) return 7;
  if (value === 8) return 8;
  if (value === 9) return 9;
  if (value === 10) return 10;
  if (value === 11) return 11;
  if (value === 12) return 12;
  if (value === 13) return 13;
  if (value === 14) return 14;
  if (value === 15) return 15;
  if (value === 16) return 16;
  if (value === 17) return 17;
  if (value === 18) return 18;
  if (value === 19) return 19;
  if (value === 20) return 20;
  if (value === 21) return 21;
  return 0;
}
`;
}

function simpleModuleSource(name: string): string {
  return `export function ${name}(value: number): number {
  return value + 1;
}
`;
}

function stepEnvironment(
  base: string | undefined,
  eventName = "pull_request",
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
    EVENT_NAME: eventName,
    NO_COLOR: "1",
    PATH: nextPath,
  };
  if (base === undefined) Reflect.deleteProperty(env, "BASE");
  else env.BASE = base;
  return env;
}

function createFixtureRepository(options: {
  readonly includeRecordedHitsInBase: boolean;
  readonly complexInBase: boolean;
}): { readonly repo: string; readonly baseSha: string } {
  const repo = folder("hosted-check-recorded-hits-");
  initRepository(repo);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));

  const shippedPackage = JSON.parse(
    readFileSync(join(SHIPPED_SETTINGS_DIR, "package.json"), "utf8"),
  ) as {
    scripts: Record<string, string>;
    [key: string]: unknown;
  };
  const fixturePackage = `${JSON.stringify(
    {
      ...shippedPackage,
      name: "demo-app",
      dependencies: {},
    },
    null,
    2,
  )}\n`;

  const baseFiles: Record<string, string> = {
    ".gitignore": "node_modules\n",
    ".fallowrc.json": readFileSync(
      join(SHIPPED_SETTINGS_DIR, ".fallowrc.json"),
      "utf8",
    ),
    "package.json": fixturePackage,
    "tsconfig.base.json": readFileSync(
      join(SHIPPED_SETTINGS_DIR, "tsconfig.base.json"),
      "utf8",
    ),
    "tsconfig.json": readFileSync(
      join(SHIPPED_SETTINGS_DIR, "tsconfig.json"),
      "utf8",
    ),
    ".github/workflows/ci.yml": readFileSync(SHIPPED_WORKFLOW_PATH, "utf8"),
    ...shippedScripts(),
    "src/cli.ts":
      'import { decideBranch } from "./commands.ts";\nexport function main(): number {\n  return decideBranch(1);\n}\nmain();\n',
    "src/commands.ts": options.complexInBase
      ? complexModuleSource("decideBranch")
      : simpleModuleSource("decideBranch"),
    "tests/cli.test.ts":
      'import { expect, test } from "bun:test";\nimport { decideBranch } from "../src/commands.ts";\ntest("branch", () => {\n  expect(decideBranch(1)).toBeGreaterThan(0);\n});\n',
  };

  if (options.includeRecordedHitsInBase) {
    for (const file of RECORDED_HITS_FILES) {
      baseFiles[file] = readFileSync(join(SHIPPED_SETTINGS_DIR, file), "utf8");
    }
  }

  const { sha: baseSha } = commitIn(repo, "base commit", baseFiles);
  return { repo, baseSha };
}

async function recordHits(repo: string): Promise<void> {
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
}

function readRecordedHitsFiles(repo: string): Record<string, string> {
  return Object.fromEntries(
    RECORDED_HITS_FILES.map((file) => [
      file,
      readFileSync(join(repo, file), "utf8"),
    ]),
  );
}

function runHostedGrowthStep(
  repo: string,
  base: string | undefined,
  eventName = "pull_request",
): Promise<{ stdout: string; stderr: string; exit: number }> {
  const stepRun = readRecordedHitsGrowthStepRun();
  return spawnBounded(["bash", "-e", "-c", stepRun], {
    cwd: repo,
    env: stepEnvironment(base, eventName),
    processGroup: true,
  });
}

function copyShippedRecordedHits(repo: string): void {
  for (const file of RECORDED_HITS_FILES) {
    copyFileSync(join(SHIPPED_SETTINGS_DIR, file), join(repo, file));
  }
}

test(
  "refuses a head commit that adds a complex function and records it in recorded-hits files",
  async () => {
    const { repo, baseSha } = createFixtureRepository({
      includeRecordedHitsInBase: true,
      complexInBase: false,
    });
    write(repo, "src/commands.ts", complexModuleSource("decideBranch"));
    await recordHits(repo);
    commitIn(repo, "add complex function and record it", {
      "src/commands.ts": complexModuleSource("decideBranch"),
      ...readRecordedHitsFiles(repo),
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("Baseline growth gate failed");
    expect(result.stderr).toContain("fallow-health-recorded-hits.json");
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("complexity_moderate");
  },
  processWatchdog(3),
);

test(
  "refuses a head commit that adds a complex function without recording it",
  async () => {
    const { repo, baseSha } = createFixtureRepository({
      includeRecordedHitsInBase: true,
      complexInBase: false,
    });
    commitIn(repo, "add complex function without recording", {
      "src/commands.ts": complexModuleSource("decideBranch"),
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("decideBranch");
  },
  processWatchdog(2),
);

test(
  "passes when head fixes a recorded finding and records again so the file shrinks",
  async () => {
    const { repo } = createFixtureRepository({
      includeRecordedHitsInBase: true,
      complexInBase: true,
    });
    await recordHits(repo);
    const { sha: baseWithRecordedHit } = commitIn(
      repo,
      "record existing complex finding",
      readRecordedHitsFiles(repo),
    );

    write(repo, "src/commands.ts", simpleModuleSource("decideBranch"));
    await recordHits(repo);
    commitIn(repo, "fix complex function and record again", {
      "src/commands.ts": simpleModuleSource("decideBranch"),
      ...readRecordedHitsFiles(repo),
    });

    const result = await runHostedGrowthStep(repo, baseWithRecordedHit);
    expect(result.exit).toBe(0);
  },
  processWatchdog(4),
);

test(
  "passes when base commit has no recorded-hits files and head adds them with existing findings",
  async () => {
    const { repo, baseSha } = createFixtureRepository({
      includeRecordedHitsInBase: false,
      complexInBase: true,
    });
    copyShippedRecordedHits(repo);
    await recordHits(repo);
    commitIn(
      repo,
      "first upgrade adds recorded-hits files",
      readRecordedHitsFiles(repo),
    );

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(0);
  },
  processWatchdog(3),
);

test(
  "skips and exits 0 when BASE is forty zeros, empty, or a commit this checkout lacks (a force push)",
  async () => {
    const { repo } = createFixtureRepository({
      includeRecordedHitsInBase: true,
      complexInBase: false,
    });

    const fortyZeros = await runHostedGrowthStep(repo, "0".repeat(40), "push");
    expect(fortyZeros.exit).toBe(0);
    expect(fortyZeros.stdout.toLowerCase()).toContain("skip");

    const emptyBase = await runHostedGrowthStep(repo, "", "push");
    expect(emptyBase.exit).toBe(0);
    expect(emptyBase.stdout.toLowerCase()).toContain("skip");

    const missingBase = await runHostedGrowthStep(repo, "1".repeat(40), "push");
    expect(missingBase.exit).toBe(0);
    expect(missingBase.stdout.toLowerCase()).toContain("skip");
  },
  processWatchdog(3),
);
