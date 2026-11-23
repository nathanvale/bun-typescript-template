import { existsSync, type Stats } from "node:fs";
import { join } from "node:path";
import type { ProcessEnvMap } from "./template-upgrade-git.ts";
import {
  plainFileIdentityChange,
  plainFileEntry,
} from "./template-upgrade-plain-file.ts";
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

function admitPaths(
  worktree: string,
  keyMergedPaths: readonly string[],
): {
  readonly admitted: ReadonlyMap<string, Stats>;
  readonly refused: readonly TemplateUpgradeApplyStep[];
} {
  const admitted = new Map<string, Stats>();
  const refused: TemplateUpgradeApplyStep[] = [];
  for (const path of keyMergedPaths) {
    const admission = plainFileEntry(worktree, path);
    if (admission === "absent") continue;
    if ("refused" in admission) {
      refused.push(
        createTemplateUpgradeApplyStep(
          JSON_FORMAT_STEP,
          false,
          "skipped",
          admission.refused,
        ),
      );
    } else admitted.set(path, admission);
  }
  return { admitted, refused };
}

export function runJsonFormatStep(
  worktree: string,
  keyMergedPaths: readonly string[],
  env: ProcessEnvMap,
):
  | { readonly ok: true; readonly steps: readonly TemplateUpgradeApplyStep[] }
  | { readonly ok: false; readonly result: TemplateUpgradeBunResult } {
  const { admitted, refused } = admitPaths(worktree, keyMergedPaths);
  const paths = [...admitted.keys()];
  if (paths.length === 0) return { ok: true, steps: refused };
  const biome = join(worktree, BIOME_BIN);
  if (!existsSync(biome)) {
    return {
      ok: true,
      steps: [
        ...skipJsonFormatSteps(paths, `${BIOME_BIN} not found`),
        ...refused,
      ],
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
  const changed = plainFileIdentityChange(worktree, admitted);
  if (changed !== undefined) {
    const output = `${changed} is no longer the regular file with one link that ${JSON_FORMAT_STEP} was given`;
    return { ok: false, result: { ...result, ok: false, output } };
  }
  return {
    ok: true,
    steps: [
      createTemplateUpgradeApplyStep(JSON_FORMAT_STEP, true, "passed"),
      ...refused,
    ],
  };
}
