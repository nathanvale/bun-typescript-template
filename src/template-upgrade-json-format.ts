import { existsSync, lstatSync } from "node:fs";
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

function lstatIfPresent(
  fullPath: string,
): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(fullPath);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

// Platform: Biome writes through a symbolic link and formats a folder's files.
function formatAdmission(
  worktree: string,
  path: string,
): "admitted" | "absent" | { readonly skipped: string } {
  const segments = path.split("/");
  for (let index = 1; index < segments.length; index += 1) {
    const ancestor = segments.slice(0, index).join("/");
    if (lstatIfPresent(join(worktree, ancestor))?.isSymbolicLink()) {
      return { skipped: `${path} is below symbolic link ${ancestor}` };
    }
  }
  const stats = lstatIfPresent(join(worktree, path));
  if (stats === undefined) return "absent";
  if (stats.isSymbolicLink()) return { skipped: `${path} is a symbolic link` };
  if (!stats.isFile()) return { skipped: `${path} is not a regular file` };
  return "admitted";
}

export function runJsonFormatStep(
  worktree: string,
  keyMergedPaths: readonly string[],
  env: ProcessEnvMap,
):
  | { readonly ok: true; readonly steps: readonly TemplateUpgradeApplyStep[] }
  | { readonly ok: false; readonly result: TemplateUpgradeBunResult } {
  const paths: string[] = [];
  const refused: TemplateUpgradeApplyStep[] = [];
  for (const path of keyMergedPaths) {
    const admission = formatAdmission(worktree, path);
    if (admission === "admitted") paths.push(path);
    else if (admission !== "absent") {
      refused.push(
        createTemplateUpgradeApplyStep(
          JSON_FORMAT_STEP,
          false,
          "skipped",
          admission.skipped,
        ),
      );
    }
  }
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
  return {
    ok: true,
    steps: [
      createTemplateUpgradeApplyStep(JSON_FORMAT_STEP, true, "passed"),
      ...refused,
    ],
  };
}
