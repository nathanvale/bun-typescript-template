import { existsSync, lstatSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PIN_SETTINGS,
  RECORDED_HITS_FILES,
  RECORDED_HITS_SCRIPT,
} from "./recipe.ts";
import {
  fallowPackageChange,
  isFallowGatePath,
} from "./template-upgrade-gates.ts";
import {
  type ProcessEnvMap,
  readCommittedBytes,
  readCommittedBytesAt,
  runGitText,
  toolchainEnvironment,
} from "./template-upgrade-git.ts";
import type { PackageDependencyChange } from "./template-upgrade-json-merge.ts";
import type { TemplateUpgradeRow } from "./template-upgrade-merge.ts";
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

const RECORDING_DONE_MARK = "template-upgrade-recorded-hits-done";
const REFRESHED_IDENTITY_REASON =
  "refreshed analysis identity; kept existing recorded hits";
const METADATA_KEYS = new Set([
  "kind",
  "identity",
  "analysis_identity",
  "schema_version",
  "version",
]);
const FALLOW_SCRIPT_KEYS = ["quality:fallow", RECORDED_HITS_SCRIPT] as const;

type RecordedHitsAction = "none" | "record-new" | "refresh-changed";

function parseJsonObjectText(
  text: string,
): Readonly<Record<string, unknown>> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(parsed));
}

function readPackageScripts(
  text: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (text === undefined) return undefined;
  const manifest = parseJsonObjectText(text);
  if (manifest === undefined || !Object.hasOwn(manifest, "scripts")) {
    return undefined;
  }
  const scripts = manifest.scripts;
  if (
    typeof scripts !== "object" ||
    scripts === null ||
    Array.isArray(scripts)
  ) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(scripts));
}

function definesRecordedHitsScript(worktree: string): boolean {
  const packagePath = join(worktree, "package.json");
  if (!existsSync(packagePath)) return false;
  const scripts = readPackageScripts(readFileSync(packagePath, "utf8"));
  return scripts !== undefined && Object.hasOwn(scripts, RECORDED_HITS_SCRIPT);
}

export interface RecordedHitsRequest {
  readonly worktree: string;
  readonly templateRoot: string;
  readonly targetCommit: string;
  readonly repository: string;
  readonly repositoryHead: string;
  readonly rows: readonly TemplateUpgradeRow[];
  readonly dependencyChanges: readonly PackageDependencyChange[];
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
  merge?: {
    readonly rows: readonly TemplateUpgradeRow[];
    readonly dependencyChanges: readonly PackageDependencyChange[];
  },
): RecordedHitsRequest {
  return {
    worktree,
    templateRoot: inputs.templateRoot,
    targetCommit: inputs.targetCommit,
    repository: inputs.repository,
    repositoryHead: inputs.repositoryHead,
    rows: merge?.rows ?? Object.freeze([]),
    dependencyChanges: merge?.dependencyChanges ?? Object.freeze([]),
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

function recordingDoneMarkPath(options: RecordedHitsRequest): string {
  return runGitText(
    options.worktree,
    ["rev-parse", "--path-format=absolute", "--git-path", RECORDING_DONE_MARK],
    {
      code: "worktree_git_path_failed",
      message: `cannot locate the recorded-hits mark for ${options.worktree}`,
      repair: `inspect ${options.worktree} with git rev-parse --git-dir, then rerun`,
    },
    { env: options.env },
  );
}

function recordingDone(options: RecordedHitsRequest): boolean {
  const markPath = recordingDoneMarkPath(options);
  try {
    lstatSync(markPath);
    return true;
  } catch (error) {
    const code: unknown = Reflect.get(Object(error), "code");
    if (code === "ENOENT") return false;
    throw error;
  }
}

function markRecordingDone(options: RecordedHitsRequest): void {
  writeFileSync(recordingDoneMarkPath(options), `${options.targetCommit}\n`, {
    flag: "wx",
  });
}

function fallowScriptsChanged(options: RecordedHitsRequest): boolean {
  const beforeBytes = readCommittedBytes(
    options.repository,
    "package.json",
    options.env,
  );
  const afterBytes = readWorktreeRegularFileBytes(
    join(options.worktree, "package.json"),
  );
  if (beforeBytes === undefined || afterBytes === undefined) return false;
  const utf8 = new TextDecoder("utf-8");
  const beforeScripts = readPackageScripts(utf8.decode(beforeBytes));
  const afterScripts = readPackageScripts(utf8.decode(afterBytes));
  if (beforeScripts === undefined || afterScripts === undefined) return false;
  return FALLOW_SCRIPT_KEYS.some(
    (key) => beforeScripts[key] !== afterScripts[key],
  );
}

function fallowSettingsChanged(options: RecordedHitsRequest): boolean {
  const changedGatePath = options.rows.some(
    (row) =>
      row.outcome !== "untouched" &&
      row.outcome !== "already-applied" &&
      isFallowGatePath(row.path),
  );
  if (changedGatePath) return true;
  if (fallowPackageChange(options.dependencyChanges)) return true;
  const packageChanged = options.rows.some(
    (row) =>
      row.path === "package.json" &&
      row.outcome !== "untouched" &&
      row.outcome !== "already-applied",
  );
  return packageChanged && fallowScriptsChanged(options);
}

function recordedHitsAction(options: RecordedHitsRequest): RecordedHitsAction {
  const { worktree, repository, repositoryHead, env } = options;
  if (!definesRecordedHitsScript(worktree)) return "none";
  if (recordingDone(options)) return "none";
  const missingInRepositoryHead = RECORDED_HITS_FILES.some(
    (file) =>
      resolveRefIfPresent(repository, `${repositoryHead}:${file}`, env) ===
      undefined,
  );
  if (missingInRepositoryHead) {
    const matchesEmpty = RECORDED_HITS_FILES.every((file) =>
      matchesTemplateRecordedHits(options, file),
    );
    return matchesEmpty ? "record-new" : "none";
  }
  const allPresentInWorktree = RECORDED_HITS_FILES.every(
    (file) => readWorktreeRegularFileBytes(join(worktree, file)) !== undefined,
  );
  if (!allPresentInWorktree) return "none";
  return fallowSettingsChanged(options) ? "refresh-changed" : "none";
}

function arrayAddedEntries(
  beforeValue: unknown,
  afterValue: readonly unknown[],
): boolean {
  const beforeItems = Array.isArray(beforeValue) ? beforeValue : [];
  const beforeSet = new Set(beforeItems.map((item) => JSON.stringify(item)));
  return afterValue.some((item) => !beforeSet.has(JSON.stringify(item)));
}

function countMapGrew(
  beforeValue: unknown,
  afterValue: Readonly<Record<string, unknown>>,
): boolean {
  const beforeRecord: Readonly<Record<string, unknown>> =
    typeof beforeValue === "object" &&
    beforeValue !== null &&
    !Array.isArray(beforeValue)
      ? Object.fromEntries(Object.entries(beforeValue))
      : {};
  for (const [key, value] of Object.entries(afterValue)) {
    if (typeof value !== "number") return true;
    const prior: unknown = Object.hasOwn(beforeRecord, key)
      ? beforeRecord[key]
      : 0;
    const priorNumber = typeof prior === "number" ? prior : 0;
    if (value > priorNumber) return true;
  }
  return false;
}

function propertyAddedFindings(
  beforeValue: unknown,
  afterValue: unknown,
): boolean {
  if (Array.isArray(afterValue)) {
    return arrayAddedEntries(beforeValue, afterValue);
  }
  if (typeof afterValue === "object" && afterValue !== null) {
    return countMapGrew(
      beforeValue,
      Object.fromEntries(Object.entries(afterValue)),
    );
  }
  return JSON.stringify(beforeValue) !== JSON.stringify(afterValue);
}

function fileAddedFindings(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): boolean {
  const utf8 = new TextDecoder("utf-8");
  const before = parseJsonObjectText(utf8.decode(beforeBytes));
  const after = parseJsonObjectText(utf8.decode(afterBytes));
  if (before === undefined || after === undefined) return true;
  return Object.entries(after).some(([key, afterValue]) => {
    if (METADATA_KEYS.has(key)) return false;
    const beforeValue = Object.hasOwn(before, key) ? before[key] : undefined;
    return propertyAddedFindings(beforeValue, afterValue);
  });
}

function formatRewrittenFiles(
  worktree: string,
  files: readonly string[],
  timeoutMilliseconds: number,
  env: ProcessEnvMap,
): void {
  if (files.length === 0) return;
  const biomeBin = join(worktree, "node_modules/.bin/biome");
  if (!existsSync(biomeBin)) return;
  Bun.spawnSync([biomeBin, "format", "--write", ...files], {
    cwd: worktree,
    env: toolchainEnvironment(env),
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMilliseconds,
    killSignal: "SIGKILL",
  });
}

function keepIdentityOnly(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array>,
  timeoutMilliseconds: number,
  env: ProcessEnvMap,
): void {
  const utf8 = new TextDecoder("utf-8");
  const rewritten: string[] = [];
  for (const [file, beforeBytes] of snapshots) {
    const fullPath = join(worktree, file);
    const afterBytes = readWorktreeRegularFileBytes(fullPath);
    const beforeObj = parseJsonObjectText(utf8.decode(beforeBytes));
    const afterObj =
      afterBytes === undefined
        ? undefined
        : parseJsonObjectText(utf8.decode(afterBytes));
    if (
      beforeObj !== undefined &&
      afterObj !== undefined &&
      Object.hasOwn(afterObj, "analysis_identity") &&
      JSON.stringify(beforeObj.analysis_identity) !==
        JSON.stringify(afterObj.analysis_identity)
    ) {
      const updated = Object.fromEntries(
        Object.entries(beforeObj).map(([key, value]) =>
          key === "analysis_identity"
            ? [key, afterObj.analysis_identity]
            : [key, value],
        ),
      );
      if (!Object.hasOwn(updated, "analysis_identity")) {
        updated.analysis_identity = afterObj.analysis_identity;
      }
      writeFileSync(fullPath, `${JSON.stringify(updated, null, 2)}\n`);
      rewritten.push(file);
    } else {
      writeFileSync(fullPath, beforeBytes);
    }
  }
  formatRewrittenFiles(worktree, rewritten, timeoutMilliseconds, env);
}

export function noCheckTemplateUpgradeSteps(
  request: RecordedHitsRequest,
): readonly TemplateUpgradeApplyStep[] {
  const skipped = skipTemplateUpgradeSteps("--no-check");
  const [install, check] = skipped;
  if (install === undefined || check === undefined) return skipped;
  if (recordedHitsAction(request) === "none") return skipped;
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

function restoreSnapshots(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array>,
): void {
  for (const [file, beforeBytes] of snapshots) {
    writeFileSync(join(worktree, file), beforeBytes);
  }
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
  const action = recordedHitsAction(request);
  if (action === "none") return { ok: true, steps: [] };
  const snapshots = new Map<string, Uint8Array>();
  for (const file of RECORDED_HITS_FILES) {
    const bytes = readWorktreeRegularFileBytes(join(request.worktree, file));
    if (bytes !== undefined) snapshots.set(file, bytes);
  }
  const record = runBunStep({
    worktree: request.worktree,
    args: ["run", RECORDED_HITS_SCRIPT],
    timeoutMilliseconds,
    env: request.env,
  });
  if (!record.ok) {
    restoreSnapshots(request.worktree, snapshots);
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
  let reason: string | undefined;
  if (action === "refresh-changed") {
    const addedNewFindings = [...snapshots.entries()].some(
      ([file, beforeBytes]) => {
        const afterBytes = readWorktreeRegularFileBytes(
          join(request.worktree, file),
        );
        return (
          afterBytes === undefined || fileAddedFindings(beforeBytes, afterBytes)
        );
      },
    );
    if (addedNewFindings) {
      keepIdentityOnly(
        request.worktree,
        snapshots,
        timeoutMilliseconds,
        request.env,
      );
      reason = REFRESHED_IDENTITY_REASON;
    }
  }
  markRecordingDone(request);
  return {
    ok: true,
    steps: [
      createTemplateUpgradeApplyStep(
        RECORDED_HITS_STEP,
        true,
        "passed",
        reason,
      ),
    ],
  };
}
