import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { readRecordedHitsGrowthStepRun } from "../../support/recorded-health-sizes-fixture.ts";

const folder = ownedFolders();

function createFixture(): {
  readonly repo: string;
  readonly baseSha: string;
  readonly stubBin: string;
  readonly logFile: string;
} {
  const root = folder("growth-step-missing-base-");
  const repo = join(root, "repo");
  const stubBin = join(root, "bin");
  const logFile = join(root, "stub-bun.log");
  mkdirSync(repo, { recursive: true });
  mkdirSync(stubBin, { recursive: true });
  const stubBun = join(stubBin, "bun");
  writeFileSync(
    stubBun,
    '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$STUB_BUN_LOG"\n',
  );
  chmodSync(stubBun, 0o755);

  initRepository(repo);
  const { sha: baseSha } = commitIn(repo, "base commit", {
    "README.md": "base\n",
  });
  commitIn(repo, "head commit", {
    "README.md": "head\n",
  });
  return { repo, baseSha, stubBin, logFile };
}

function readRecordedCommands(logFile: string): string[] {
  if (!existsSync(logFile)) return [];
  return readFileSync(logFile, "utf8")
    .split("\n")
    .filter((line) => line !== "");
}

function runGrowthStep(options: {
  readonly repo: string;
  readonly stubBin: string;
  readonly logFile: string;
  readonly eventName: string;
  readonly base: string;
}): Promise<{ stdout: string; stderr: string; exit: number }> {
  const baseEnv = inherited();
  const currentPath = baseEnv.PATH ?? "";
  const env: Record<string, string | undefined> = {
    ...baseEnv,
    ...gitEnv,
    BASE: options.base,
    EVENT_NAME: options.eventName,
    PATH: `${options.stubBin}:${currentPath}`,
    STUB_BUN_LOG: options.logFile,
  };
  return spawnBounded(["bash", "-e", "-c", readRecordedHitsGrowthStepRun()], {
    cwd: options.repo,
    env,
    processGroup: true,
  });
}

test(
  "fails on pull_request when BASE is empty, printing ::error:: with the missing base and repair",
  async () => {
    const fixture = createFixture();
    const result = await runGrowthStep({
      ...fixture,
      eventName: "pull_request",
      base: "",
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain("empty");
    expect(result.stdout).toContain("fetch-depth: 0");
    expect(result.stdout).toContain("rerun");
    expect(readRecordedCommands(fixture.logFile)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "fails on pull_request when BASE is not a commit in the checkout",
  async () => {
    const fixture = createFixture();
    const missingSha = "1".repeat(40);
    const result = await runGrowthStep({
      ...fixture,
      eventName: "pull_request",
      base: missingSha,
    });
    expect(result.exit).toBe(1);
    expect(result.stdout).toContain("::error::");
    expect(result.stdout).toContain(missingSha);
    expect(result.stdout).toContain("fetch-depth: 0");
    expect(result.stdout).toContain("rerun");
    expect(readRecordedCommands(fixture.logFile)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "skips on push when BASE is forty zeros, printing ::notice:: and running no growth command",
  async () => {
    const fixture = createFixture();
    const result = await runGrowthStep({
      ...fixture,
      eventName: "push",
      base: "0".repeat(40),
    });
    expect(result.exit).toBe(0);
    expect(result.stdout).toContain("::notice::");
    expect(result.stdout).toContain("no earlier commit to compare");
    expect(readRecordedCommands(fixture.logFile)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "runs both growth commands on push when BASE is a real earlier commit",
  async () => {
    const fixture = createFixture();
    const result = await runGrowthStep({
      ...fixture,
      eventName: "push",
      base: fixture.baseSha,
    });
    expect(result.exit).toBe(0);
    expect(readRecordedCommands(fixture.logFile)).toEqual([
      `run --silent quality:fallow -- --fail-on-baseline-growth --baseline-base ${fixture.baseSha}`,
      `scripts/check-recorded-health-sizes.ts --base ${fixture.baseSha}`,
    ]);
  },
  processWatchdog(1),
);
