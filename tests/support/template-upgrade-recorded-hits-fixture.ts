import { expect } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ownedFolders } from "./fixture-files.ts";
import { commitIn, git } from "./git-fixture.ts";
import type { streamWrites } from "./stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  writeScriptedBun,
} from "./template-upgrade-fixture.ts";

export const HEALTH_FILE = "fallow-health-recorded-hits.json";
export const ALL_RECORDED_HITS_FILES = [
  "fallow-dead-code-recorded-hits.json",
  "fallow-duplicates-recorded-hits.json",
  "fallow-health-recorded-hits.json",
] as const;
export const CALC_FN =
  "export function calculate(v: number): number {\n  return v;\n}\n";

export interface RefusalEnvelope {
  readonly status: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly repair: string;
  };
}

export function worktreePath(repo: string, target: string): string {
  return join(repo, ".worktrees", `template-upgrade-${target.slice(0, 7)}`);
}

export function branchName(base: string, target: string): string {
  return `template-upgrade/${base.slice(0, 7)}-${target.slice(0, 7)}`;
}

export function healthJson(fields: Readonly<Record<string, unknown>>): string {
  return `${JSON.stringify(
    {
      kind: "health",
      finding_counts: {},
      identity_finding_counts: {},
      runtime_coverage_findings: [],
      target_keys: [],
      ...fields,
    },
    null,
    2,
  )}\n`;
}

export function healthHitJson(path: string): string {
  return healthJson({
    finding_counts: { [path]: 1 },
    identity_finding_counts: { [`${path}\u0000calculate`]: 1 },
    target_keys: [path],
  });
}

export function commitFallowGateChange(templateClone: string): string {
  const rel = "generated-repository/settings/.fallowrc.json";
  const p = join(templateClone, rel);
  writeFileSync(p, `${readFileSync(p, "utf8").trimEnd()}\n\n`);
  git(templateClone, "add", "--", rel);
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "change fallow settings for recorded-hits test",
  );
  return git(templateClone, "rev-parse", "HEAD");
}

export function expectGrowthRefusal(
  run: { readonly exitCode: number; readonly stderr: string },
  repo: string,
  branch: string,
  worktree: string,
  baseBytes: Uint8Array,
  expectedDetails: readonly string[],
  checkRepair = false,
): void {
  expect(run.exitCode).not.toBe(0);
  const refusal = JSON.parse(run.stderr) as RefusalEnvelope;
  expect(refusal.status).toBe("refused");
  expect(refusal.error.code).toBe("recorded_hits_would_grow");
  expect(refusal.error.message).toContain(HEALTH_FILE);
  for (const detail of expectedDetails) {
    expect(refusal.error.message).toContain(detail);
  }
  if (checkRepair) {
    expect(refusal.error.repair).toContain("later commit");
    expect(refusal.error.repair).toContain("rerun");
  }
  expect(git(repo, "branch", "--list", branch)).toBe("");
  expect(
    Buffer.compare(readFileSync(join(worktree, HEALTH_FILE)), baseBytes),
  ).toBe(0);
}

export function createRecordedHitsGrowthHelpers(
  folder: ReturnType<typeof ownedFolders>,
  captureStream: ReturnType<typeof streamWrites>,
) {
  function applyJson(
    repo: string,
    target: string,
    templateRoot: string,
    env: Readonly<Record<string, string | undefined>>,
  ) {
    return invokeTemplateUpgradeMain(
      captureStream(process.stdout),
      captureStream(process.stderr),
      ["apply", "--repository", repo, "--to", target, "--json"],
      { templateRoot, env },
    );
  }

  async function runMoveCase(
    app: string,
    oldPath: string,
    newPath: string,
    action: string,
    oldSource = CALC_FN,
    newSource = CALC_FN,
    extraFiles: Readonly<Record<string, string>> = {},
  ) {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      app,
    );
    commitIn(repo, "owner hit", {
      ...extraFiles,
      [oldPath]: oldSource,
      [HEALTH_FILE]: healthHitJson(oldPath),
    });
    const baseBytes = readFileSync(join(repo, HEALTH_FILE));
    const target = commitFallowGateChange(templateClone);
    const branch = branchName(baseCommit, target);
    const worktree = worktreePath(repo, target);
    const { env } = writeScriptedBun(
      folder,
      `scripted-bun-${app}-`,
      `#!/bin/sh\necho "$*" >> __LEDGER__\nif [ "$1 $2" = "run quality:fallow:record-hits" ]; then\n${action}\ncat <<'EOF' > ${newPath}\n${newSource}EOF\ncat <<'EOF' > ${HEALTH_FILE}\n${healthHitJson(newPath)}EOF\nfi\nif [ "$1 $2 $3" = "run --bun changeset" ]; then\nmkdir -p .changeset && printf -- '---\\n---\\n' > .changeset/a.md\nfi\nexit 0\n`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    return { repo, branch, worktree, baseBytes, run };
  }

  return { applyJson, runMoveCase };
}
