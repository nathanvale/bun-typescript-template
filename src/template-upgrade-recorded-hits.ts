import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CliError } from "./cli-error.ts";
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
import { keepBaseHealthKeys } from "./template-upgrade-recorded-hits-health.ts";
import {
  asRecord,
  decodeJsonObjectBytes,
  findRecordedHitsGrowth,
  parseJsonObjectText,
  type RecordedHitsFileGrowth,
  readWorktreeFileBytes,
} from "./template-upgrade-recorded-hits-growth.ts";
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
const RECORDING_PENDING_DIR = "template-upgrade-recorded-hits-pending";
const PENDING_STATE_FILE = "state.json";
const PENDING_FILES_DIR = "files";
const REFRESHED_IDENTITY_REASON =
  "refreshed analysis identity; kept existing recorded hits";
const RECORDED_AFTER_REPAIR_REASON =
  "recorded again after a repair that bun run check passed";
const RECORDED_HITS_WOULD_GROW_REPAIR =
  "record each hit by hand in a later commit, or change the code so it is not reported, then rerun the upgrade";
const FALLOW_SCRIPT_KEYS = ["quality:fallow", RECORDED_HITS_SCRIPT] as const;

type RecordedHitsAction = "none" | "record-new" | "refresh-changed";

function readPackageScripts(
  text: string | undefined,
): Readonly<Record<string, unknown>> | undefined {
  if (text === undefined) return undefined;
  const manifest = parseJsonObjectText(text);
  return manifest === undefined || !Object.hasOwn(manifest, "scripts")
    ? undefined
    : asRecord(manifest.scripts);
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

function matchesTemplateRecordedHits(
  options: RecordedHitsRequest,
  file: string,
): boolean {
  const worktreeBytes = readWorktreeFileBytes(join(options.worktree, file));
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

function gitWorktreePath(options: RecordedHitsRequest, name: string): string {
  return runGitText(
    options.worktree,
    ["rev-parse", "--path-format=absolute", "--git-path", name],
    {
      code: "worktree_git_path_failed",
      message: `cannot locate the recorded-hits mark for ${options.worktree}`,
      repair: `inspect ${options.worktree} with git rev-parse --git-dir, then rerun`,
    },
    { env: options.env },
  );
}

function recordingDoneMarkPath(options: RecordedHitsRequest): string {
  return gitWorktreePath(options, RECORDING_DONE_MARK);
}

function recordingPendingDirPath(options: RecordedHitsRequest): string {
  return gitWorktreePath(options, RECORDING_PENDING_DIR);
}

interface PendingSnapshotState {
  readonly action: Exclude<RecordedHitsAction, "none">;
  readonly snapshots: ReadonlyMap<string, Uint8Array | undefined>;
}

function parsePendingAction(
  value: unknown,
): Exclude<RecordedHitsAction, "none"> | undefined {
  return value === "record-new" || value === "refresh-changed"
    ? value
    : undefined;
}

function persistPendingSnapshots(
  pendingDir: string,
  targetCommit: string,
  action: Exclude<RecordedHitsAction, "none">,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
): void {
  const filesDir = join(pendingDir, PENDING_FILES_DIR);
  rmSync(pendingDir, { force: true, recursive: true });
  mkdirSync(filesDir, { recursive: true });
  const filePresence: Record<string, boolean> = {};
  for (const [file, bytes] of snapshots) {
    filePresence[file] = bytes !== undefined;
    if (bytes !== undefined) {
      writeFileSync(join(filesDir, file), bytes);
    }
  }
  const statePath = join(pendingDir, PENDING_STATE_FILE);
  const tempStatePath = `${statePath}.tmp`;
  writeFileSync(
    tempStatePath,
    `${JSON.stringify({ targetCommit, action, files: filePresence }, null, 2)}\n`,
  );
  renameSync(tempStatePath, statePath);
}

function readPendingSnapshots(
  pendingDir: string,
): PendingSnapshotState | undefined {
  const statePath = join(pendingDir, PENDING_STATE_FILE);
  if (!existsSync(statePath)) {
    if (existsSync(pendingDir)) {
      rmSync(pendingDir, { force: true, recursive: true });
    }
    return undefined;
  }
  const parsed = parseJsonObjectText(readFileSync(statePath, "utf8"));
  const action =
    parsed === undefined ? undefined : parsePendingAction(parsed.action);
  const filesMap = parsed === undefined ? undefined : asRecord(parsed.files);
  if (action === undefined || filesMap === undefined) {
    return undefined;
  }
  const snapshots = new Map<string, Uint8Array | undefined>();
  for (const file of RECORDED_HITS_FILES) {
    const present = Object.hasOwn(filesMap, file) && filesMap[file] === true;
    snapshots.set(
      file,
      present
        ? readFileSync(join(pendingDir, PENDING_FILES_DIR, file))
        : undefined,
    );
  }
  return { action, snapshots };
}

function captureWorktreeSnapshots(
  worktree: string,
): Map<string, Uint8Array | undefined> {
  const snapshots = new Map<string, Uint8Array | undefined>();
  for (const file of RECORDED_HITS_FILES) {
    snapshots.set(file, readWorktreeFileBytes(join(worktree, file)));
  }
  return snapshots;
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

export function recordedHitsRecordedBeforeRepair(
  request: RecordedHitsRequest,
): boolean {
  return definesRecordedHitsScript(request.worktree) && recordingDone(request);
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
  const afterBytes = readWorktreeFileBytes(
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
    (file) => readWorktreeFileBytes(join(worktree, file)) !== undefined,
  );
  if (!allPresentInWorktree) return "none";
  return fallowSettingsChanged(options) ? "refresh-changed" : "none";
}

function snapshotsRefreshedAnalysisIdentity(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
): boolean {
  for (const [file, beforeBytes] of snapshots) {
    if (beforeBytes === undefined) continue;
    const afterBytes = readWorktreeFileBytes(join(worktree, file));
    if (afterBytes === undefined) continue;
    const beforeObj = decodeJsonObjectBytes(beforeBytes);
    const afterObj = decodeJsonObjectBytes(afterBytes);
    if (
      beforeObj !== undefined &&
      afterObj !== undefined &&
      Object.hasOwn(afterObj, "analysis_identity") &&
      JSON.stringify(beforeObj.analysis_identity) !==
        JSON.stringify(afterObj.analysis_identity)
    ) {
      return true;
    }
  }
  return false;
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
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
  timeoutMilliseconds: number,
  env: ProcessEnvMap,
): void {
  const rewritten: string[] = [];
  for (const [file, beforeBytes] of snapshots) {
    const fullPath = join(worktree, file);
    if (beforeBytes === undefined) {
      rmSync(fullPath, { force: true });
      continue;
    }
    const afterBytes = readWorktreeFileBytes(fullPath);
    const beforeObj = decodeJsonObjectBytes(beforeBytes);
    const afterObj =
      afterBytes === undefined ? undefined : decodeJsonObjectBytes(afterBytes);
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

function dropAdvisoryAdditions(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
  timeoutMilliseconds: number,
  env: ProcessEnvMap,
): void {
  const rewritten: string[] = [];
  for (const [file, beforeBytes] of snapshots) {
    if (beforeBytes === undefined) continue;
    const fullPath = join(worktree, file);
    const afterBytes = readWorktreeFileBytes(fullPath);
    if (afterBytes === undefined) continue;
    const beforeObj = decodeJsonObjectBytes(beforeBytes);
    const afterObj = decodeJsonObjectBytes(afterBytes);
    if (beforeObj === undefined || afterObj === undefined) continue;
    const dropped = keepBaseHealthKeys(beforeObj, afterObj);
    if (dropped === undefined) continue;
    if (dropped.equalToBefore) {
      writeFileSync(fullPath, beforeBytes);
    } else {
      writeFileSync(fullPath, `${JSON.stringify(dropped.restored, null, 2)}\n`);
      rewritten.push(file);
    }
  }
  formatRewrittenFiles(worktree, rewritten, timeoutMilliseconds, env);
}

function recordedHitsWouldGrowError(
  growth: readonly RecordedHitsFileGrowth[],
): CliError {
  const detail = growth
    .map((item) => `${item.file} (${item.entries.join(", ")})`)
    .join("; ");
  return new CliError(
    "recorded_hits_would_grow",
    `recording would grow recorded hits: ${detail}`,
    RECORDED_HITS_WOULD_GROW_REPAIR,
    4,
    false,
  );
}

export function noCheckTemplateUpgradeSteps(
  request: RecordedHitsRequest,
  formatSteps: readonly TemplateUpgradeApplyStep[],
): readonly TemplateUpgradeApplyStep[] {
  const skipped = skipTemplateUpgradeSteps("--no-check");
  const [install, check] = skipped;
  if (install === undefined || check === undefined) return skipped;
  const recorded =
    recordedHitsAction(request) === "none"
      ? []
      : [
          createTemplateUpgradeApplyStep(
            RECORDED_HITS_STEP,
            false,
            "skipped",
            "--no-check",
          ),
        ];
  return Object.freeze([install, ...formatSteps, ...recorded, check]);
}

function restoreSnapshots(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
): void {
  for (const [file, beforeBytes] of snapshots) {
    const fullPath = join(worktree, file);
    if (beforeBytes === undefined) {
      rmSync(fullPath, { force: true });
    } else {
      writeFileSync(fullPath, beforeBytes);
    }
  }
}

function findRecordedHitsGrowthOrRestore(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
  pendingDir?: string,
): RecordedHitsFileGrowth[] {
  try {
    return findRecordedHitsGrowth(worktree, snapshots);
  } catch (error) {
    restoreSnapshots(worktree, snapshots);
    if (pendingDir !== undefined) {
      rmSync(pendingDir, { force: true, recursive: true });
    }
    throw error;
  }
}

function preparePendingRecording(
  request: RecordedHitsRequest,
  pendingDir: string,
): PendingSnapshotState | undefined {
  const recovered = readPendingSnapshots(pendingDir);
  if (recovered !== undefined) {
    restoreSnapshots(request.worktree, recovered.snapshots);
    return recovered;
  }
  const action = recordedHitsAction(request);
  if (action === "none") return undefined;
  const snapshots = captureWorktreeSnapshots(request.worktree);
  persistPendingSnapshots(pendingDir, request.targetCommit, action, snapshots);
  return { action, snapshots };
}

// Platform: Fallow keys a recorded hit by file path and function name, and its
// audit of changed files reports a moved function as new.
export function runRecordedHitsRepairStep(
  request: RecordedHitsRequest,
  timeoutMilliseconds: number,
):
  | { readonly ok: true; readonly steps: readonly TemplateUpgradeApplyStep[] }
  | {
      readonly ok: false;
      readonly steps: readonly TemplateUpgradeApplyStep[];
      readonly output: string;
    } {
  const snapshots = captureWorktreeSnapshots(request.worktree);
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
      steps: [
        createTemplateUpgradeApplyStep(RECORDED_HITS_STEP, true, "failed"),
      ],
    };
  }
  const growth = findRecordedHitsGrowthOrRestore(request.worktree, snapshots);
  if (growth.length > 0) {
    restoreSnapshots(request.worktree, snapshots);
    throw recordedHitsWouldGrowError(growth);
  }
  dropAdvisoryAdditions(
    request.worktree,
    snapshots,
    timeoutMilliseconds,
    request.env,
  );
  return {
    ok: true,
    steps: [
      createTemplateUpgradeApplyStep(
        RECORDED_HITS_STEP,
        true,
        "passed",
        RECORDED_AFTER_REPAIR_REASON,
      ),
    ],
  };
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
  const pendingDir = recordingPendingDirPath(request);
  if (recordingDone(request)) {
    rmSync(pendingDir, { force: true, recursive: true });
    return { ok: true, steps: [] };
  }
  const pending = preparePendingRecording(request, pendingDir);
  if (pending === undefined) return { ok: true, steps: [] };
  const record = runBunStep({
    worktree: request.worktree,
    args: ["run", RECORDED_HITS_SCRIPT],
    timeoutMilliseconds,
    env: request.env,
  });
  if (!record.ok) {
    restoreSnapshots(request.worktree, pending.snapshots);
    rmSync(pendingDir, { force: true, recursive: true });
    return {
      ok: false,
      output: record.output,
      steps: Object.freeze([
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
  if (pending.action === "refresh-changed") {
    const growth = findRecordedHitsGrowthOrRestore(
      request.worktree,
      pending.snapshots,
      pendingDir,
    );
    if (growth.length > 0) {
      if (
        snapshotsRefreshedAnalysisIdentity(request.worktree, pending.snapshots)
      ) {
        keepIdentityOnly(
          request.worktree,
          pending.snapshots,
          timeoutMilliseconds,
          request.env,
        );
        reason = REFRESHED_IDENTITY_REASON;
      } else {
        restoreSnapshots(request.worktree, pending.snapshots);
        rmSync(pendingDir, { force: true, recursive: true });
        throw recordedHitsWouldGrowError(growth);
      }
    } else {
      dropAdvisoryAdditions(
        request.worktree,
        pending.snapshots,
        timeoutMilliseconds,
        request.env,
      );
    }
  }
  markRecordingDone(request);
  rmSync(pendingDir, { force: true, recursive: true });
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
