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
const RECORDING_PENDING_DIR = "template-upgrade-recorded-hits-pending";
const PENDING_STATE_FILE = "state.json";
const PENDING_FILES_DIR = "files";
const RECORDED_AFTER_REPAIR_REASON =
  "recorded again after a repair that bun run check passed";
const RECORDED_HITS_WOULD_GROW_REPAIR =
  "record each hit by hand in a later commit, or change the code so it is not reported, then rerun the upgrade";
const UTF8_STRICT = new TextDecoder("utf-8", { fatal: true });
const METADATA_KEYS = new Set([
  "kind",
  "identity",
  "analysis_identity",
  "schema_version",
  "version",
]);
const FALLOW_SCRIPT_KEYS = ["quality:fallow", RECORDED_HITS_SCRIPT] as const;

type RecordedHitsAction = "none" | "record-new" | "refresh-changed";

function asRecord(
  value: unknown,
): Readonly<Record<string, unknown>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  return Object.fromEntries(Object.entries(value));
}

function parseJsonObjectText(
  text: string,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

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
    snapshots.set(file, readWorktreeRegularFileBytes(join(worktree, file)));
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

interface RecordedHitsFileGrowth {
  readonly file: string;
  readonly entries: readonly string[];
}

function decodeJsonObjectBytes(
  bytes: Uint8Array,
): Readonly<Record<string, unknown>> | undefined {
  try {
    return parseJsonObjectText(UTF8_STRICT.decode(bytes));
  } catch {
    return undefined;
  }
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value).sort((left, right) =>
      left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0,
    );
    return Object.fromEntries(
      entries.map(([key, item]) => [key, canonicalizeJson(item)]),
    );
  }
  return value;
}

function formatEntryValue(value: unknown): string {
  return typeof value === "string"
    ? value
    : JSON.stringify(canonicalizeJson(value));
}

function countArrayItems(
  items: readonly unknown[],
): Map<string, { readonly count: number; readonly sample: unknown }> {
  const counts = new Map<
    string,
    { readonly count: number; readonly sample: unknown }
  >();
  for (const item of items) {
    const key = JSON.stringify(canonicalizeJson(item));
    const existing = counts.get(key);
    counts.set(key, {
      count: (existing?.count ?? 0) + 1,
      sample: existing?.sample ?? item,
    });
  }
  return counts;
}

function arrayGrowthEntries(
  fieldPath: string,
  beforeValue: unknown,
  afterValue: readonly unknown[],
): string[] {
  if (beforeValue !== undefined && !Array.isArray(beforeValue)) {
    return [fieldPath];
  }
  const beforeCounts = countArrayItems(beforeValue ?? []);
  const afterCounts = countArrayItems(afterValue);
  const grown: string[] = [];
  for (const [key, { count, sample }] of afterCounts) {
    const prior = beforeCounts.get(key)?.count ?? 0;
    if (prior === 0) {
      grown.push(`${fieldPath}: ${formatEntryValue(sample)}`);
    } else if (count > prior) {
      grown.push(
        `${fieldPath}: ${formatEntryValue(sample)} (${prior} -> ${count})`,
      );
    }
  }
  return grown;
}

function objectGrowthEntries(
  fieldPath: string,
  beforeValue: unknown,
  afterValue: Readonly<Record<string, unknown>>,
): string[] {
  const beforeRecord = beforeValue === undefined ? {} : asRecord(beforeValue);
  if (beforeRecord === undefined) return [fieldPath];
  const grown: string[] = [];
  for (const [key, entryValue] of Object.entries(afterValue)) {
    const nestedPath = fieldPath === "" ? key : `${fieldPath}.${key}`;
    const prior = Object.hasOwn(beforeRecord, key)
      ? beforeRecord[key]
      : undefined;
    grown.push(...propertyGrowthEntries(nestedPath, prior, entryValue));
  }
  return grown;
}

function propertyGrowthEntries(
  fieldPath: string,
  beforeValue: unknown,
  afterValue: unknown,
): string[] {
  if (Array.isArray(afterValue)) {
    return arrayGrowthEntries(fieldPath, beforeValue, afterValue);
  }
  const afterRecord = asRecord(afterValue);
  if (afterRecord !== undefined) {
    return objectGrowthEntries(fieldPath, beforeValue, afterRecord);
  }
  if (beforeValue === undefined) return [fieldPath];
  if (typeof afterValue === "number" && typeof beforeValue === "number") {
    return afterValue > beforeValue
      ? [`${fieldPath} (${beforeValue} -> ${afterValue})`]
      : [];
  }
  return JSON.stringify(canonicalizeJson(beforeValue)) ===
    JSON.stringify(canonicalizeJson(afterValue))
    ? []
    : [fieldPath];
}

function fileGrowthEntries(
  beforeBytes: Uint8Array,
  afterBytes: Uint8Array,
): string[] {
  const before = decodeJsonObjectBytes(beforeBytes);
  const after = decodeJsonObjectBytes(afterBytes);
  if (before === undefined || after === undefined) {
    return ["unreadable recorded-hits JSON"];
  }
  const grown: string[] = [];
  for (const [key, afterValue] of Object.entries(after)) {
    if (METADATA_KEYS.has(key)) continue;
    const beforeValue = Object.hasOwn(before, key) ? before[key] : undefined;
    grown.push(...propertyGrowthEntries(key, beforeValue, afterValue));
  }
  return grown;
}

function findRecordedHitsGrowth(
  worktree: string,
  snapshots: ReadonlyMap<string, Uint8Array | undefined>,
): RecordedHitsFileGrowth[] {
  const growth: RecordedHitsFileGrowth[] = [];
  for (const [file, beforeBytes] of snapshots) {
    const afterBytes = readWorktreeRegularFileBytes(join(worktree, file));
    if (beforeBytes === undefined) {
      if (afterBytes !== undefined) {
        growth.push({ file, entries: ["file added"] });
      }
      continue;
    }
    if (afterBytes === undefined) {
      growth.push({ file, entries: ["file removed"] });
      continue;
    }
    const entries = fileGrowthEntries(beforeBytes, afterBytes);
    if (entries.length > 0) {
      growth.push({ file, entries });
    }
  }
  return growth;
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
  const growth = findRecordedHitsGrowth(request.worktree, snapshots);
  if (growth.length > 0) {
    restoreSnapshots(request.worktree, snapshots);
    throw recordedHitsWouldGrowError(growth);
  }
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
  const growth = findRecordedHitsGrowth(request.worktree, pending.snapshots);
  if (growth.length > 0) {
    restoreSnapshots(request.worktree, pending.snapshots);
    rmSync(pendingDir, { force: true, recursive: true });
    throw recordedHitsWouldGrowError(growth);
  }
  markRecordingDone(request);
  rmSync(pendingDir, { force: true, recursive: true });
  return {
    ok: true,
    steps: [createTemplateUpgradeApplyStep(RECORDED_HITS_STEP, true, "passed")],
  };
}
