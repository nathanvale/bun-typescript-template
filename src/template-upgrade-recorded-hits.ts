import { existsSync, lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PIN_SETTINGS,
  RECORDED_HITS_FILES,
  RECORDED_HITS_SCRIPT,
} from "./recipe.ts";
import {
  type ProcessEnvMap,
  readCommittedBytesAt,
} from "./template-upgrade-git.ts";
import {
  createTemplateUpgradeApplyStep,
  skipTemplateUpgradeSteps,
  type TemplateUpgradeApplyStep,
} from "./template-upgrade-report.ts";
import {
  resolveRefIfPresent,
  runBunStep,
} from "./template-upgrade-worktree.ts";

export const RECORDED_HITS_STEP = `bun run ${RECORDED_HITS_SCRIPT}` as const;

function definesRecordedHitsScript(worktree: string): boolean {
  const packagePath = join(worktree, "package.json");
  if (!existsSync(packagePath)) return false;
  const manifest: unknown = JSON.parse(readFileSync(packagePath, "utf8"));
  if (typeof manifest !== "object" || manifest === null) return false;
  const scripts: unknown = Reflect.get(manifest, "scripts");
  if (typeof scripts !== "object" || scripts === null) return false;
  return Object.hasOwn(scripts, RECORDED_HITS_SCRIPT);
}

export interface RecordedHitsRequest {
  readonly worktree: string;
  readonly templateRoot: string;
  readonly targetCommit: string;
  readonly repository: string;
  readonly repositoryHead: string;
  readonly env: ProcessEnvMap;
}

export function recordedHitsRequestFor(
  worktree: string,
  inputs: {
    readonly templateRoot: string;
    readonly targetCommit: string;
    readonly repository: string;
    readonly repositoryHead: string;
  },
  env: ProcessEnvMap,
): RecordedHitsRequest {
  return {
    worktree,
    templateRoot: inputs.templateRoot,
    targetCommit: inputs.targetCommit,
    repository: inputs.repository,
    repositoryHead: inputs.repositoryHead,
    env,
  };
}

function readWorktreeRegularFileBytes(
  fullPath: string,
): Uint8Array | undefined {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(fullPath);
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
  if (!stats.isFile()) return undefined;
  return readFileSync(fullPath);
}

function matchesTemplateRecordedHits(
  options: RecordedHitsRequest,
  file: string,
): boolean {
  const worktreeBytes = readWorktreeRegularFileBytes(
    join(options.worktree, file),
  );
  if (worktreeBytes === undefined) return false;
  const templateBytes = readCommittedBytesAt(
    options.templateRoot,
    options.targetCommit,
    `${PIN_SETTINGS.from}/${file}`,
    options.env,
  );
  if (templateBytes === undefined) return false;
  return Buffer.compare(worktreeBytes, templateBytes) === 0;
}

function newRecordedHitsPresent(options: RecordedHitsRequest): boolean {
  const { worktree, repository, repositoryHead, env } = options;
  if (!definesRecordedHitsScript(worktree)) return false;
  const missingInRepositoryHead = RECORDED_HITS_FILES.some(
    (file) =>
      resolveRefIfPresent(repository, `${repositoryHead}:${file}`, env) ===
      undefined,
  );
  if (!missingInRepositoryHead) return false;
  return RECORDED_HITS_FILES.every((file) =>
    matchesTemplateRecordedHits(options, file),
  );
}

export function noCheckTemplateUpgradeSteps(
  request: RecordedHitsRequest,
): readonly TemplateUpgradeApplyStep[] {
  const skipped = skipTemplateUpgradeSteps("--no-check");
  const [install, check] = skipped;
  if (install === undefined || check === undefined) return skipped;
  if (!newRecordedHitsPresent(request)) return skipped;
  return Object.freeze([
    install,
    createTemplateUpgradeApplyStep(
      RECORDED_HITS_STEP,
      false,
      "skipped",
      "--no-check",
    ),
    check,
  ]);
}

export function runRecordedHitsStep(
  request: RecordedHitsRequest,
  timeoutMilliseconds: number,
):
  | { readonly ok: true; readonly steps: readonly TemplateUpgradeApplyStep[] }
  | {
      readonly ok: false;
      readonly steps: readonly TemplateUpgradeApplyStep[];
      readonly output: string;
    } {
  if (!newRecordedHitsPresent(request)) return { ok: true, steps: [] };
  const record = runBunStep({
    worktree: request.worktree,
    args: ["run", RECORDED_HITS_SCRIPT],
    timeoutMilliseconds,
    env: request.env,
  });
  if (record.ok) {
    return {
      ok: true,
      steps: [
        createTemplateUpgradeApplyStep(RECORDED_HITS_STEP, true, "passed"),
      ],
    };
  }
  return {
    ok: false,
    output: record.output,
    steps: Object.freeze([
      createTemplateUpgradeApplyStep("bun install", true, "passed"),
      createTemplateUpgradeApplyStep(RECORDED_HITS_STEP, true, "failed"),
      createTemplateUpgradeApplyStep(
        "bun run check",
        false,
        "skipped",
        `${RECORDED_HITS_STEP} failed`,
      ),
    ]),
  };
}
