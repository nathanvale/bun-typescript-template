import { existsSync } from "node:fs";
import { join } from "node:path";
import type { ProcessEnvMap } from "./template-upgrade-git.ts";
import {
  createTemplateUpgradeApplyStep,
  type TemplateUpgradeApplyStep,
} from "./template-upgrade-report.ts";
import {
  runWorktreeStep,
  type TemplateUpgradeBunResult,
} from "./template-upgrade-worktree.ts";

export const JSON_FORMAT_STEP = "biome format --write";

const BIOME_BIN = "node_modules/.bin/biome";
const FORMAT_TIMEOUT_MS = 120_000;

export function skipJsonFormatSteps(
  keyMergedPaths: readonly string[],
  reason: string,
): readonly TemplateUpgradeApplyStep[] {
  if (keyMergedPaths.length === 0) return [];
  return [
    createTemplateUpgradeApplyStep(JSON_FORMAT_STEP, false, "skipped", reason),
  ];
}

export function runJsonFormatStep(
  worktree: string,
  keyMergedPaths: readonly string[],
  env: ProcessEnvMap,
):
  | { readonly ok: true; readonly steps: readonly TemplateUpgradeApplyStep[] }
  | { readonly ok: false; readonly result: TemplateUpgradeBunResult } {
  const paths = keyMergedPaths.filter((path) =>
    existsSync(join(worktree, path)),
  );
  if (paths.length === 0) return { ok: true, steps: [] };
  const biome = join(worktree, BIOME_BIN);
  if (!existsSync(biome)) {
    return {
      ok: true,
      steps: skipJsonFormatSteps(paths, `${BIOME_BIN} not found`),
    };
  }
  const result = runWorktreeStep({
    worktree,
    command: [
      biome,
      "format",
      "--write",
      "--no-errors-on-unmatched",
      ...paths.map((path) => `./${path}`),
    ],
    label: JSON_FORMAT_STEP,
    timeoutMilliseconds: FORMAT_TIMEOUT_MS,
    env,
  });
  if (!result.ok) return { ok: false, result };
  return {
    ok: true,
    steps: [createTemplateUpgradeApplyStep(JSON_FORMAT_STEP, true, "passed")],
  };
}
