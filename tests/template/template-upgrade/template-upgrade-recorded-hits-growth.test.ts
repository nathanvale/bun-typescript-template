import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  createRecordedHitsUpgradeFixture,
  invokeTemplateUpgradeMain,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();
const HEALTH_FILE = "fallow-health-recorded-hits.json";
const CALC_FN =
  "export function calculate(v: number): number {\n  return v;\n}\n";

interface RefusalEnvelope {
  readonly status: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly repair: string;
  };
}

function worktreePath(repo: string, target: string): string {
  return join(repo, ".worktrees", `template-upgrade-${target.slice(0, 7)}`);
}

function branchName(base: string, target: string): string {
  return `template-upgrade/${base.slice(0, 7)}-${target.slice(0, 7)}`;
}

function healthJson(fields: Readonly<Record<string, unknown>>): string {
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

function healthHitJson(path: string): string {
  return healthJson({
    finding_counts: { [path]: 1 },
    identity_finding_counts: { [`${path}\u0000calculate`]: 1 },
    target_keys: [path],
  });
}

function commitFallowGateChange(templateClone: string): string {
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

function expectGrowthRefusal(
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

test(
  "refuses with recorded_hits_would_grow when the recording step adds keys to fallow-health-recorded-hits.json, commits nothing, and leaves the file byte-identical to the base",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "grow-health-keys-app",
    );
    const baseBytes = readFileSync(join(repo, HEALTH_FILE));
    const target = commitFallowGateChange(templateClone);
    const addedKeys = [
      "scripts/check-recorded-health-sizes.ts",
      "tests/skills.test.ts",
      "eslint.config.mjs",
    ];
    const grownHealth = healthJson({ target_keys: addedKeys });
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-grow-health-",
      `#!/bin/sh\necho "$*" >> __LEDGER__\nif [ "$1 $2" = "run quality:fallow:record-hits" ]; then\ncat <<'EOF' > ${HEALTH_FILE}\n${grownHealth}EOF\nfi\nexit 0\n`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    expectGrowthRefusal(
      run,
      repo,
      branchName(baseCommit, target),
      worktreePath(repo, target),
      baseBytes,
      addedKeys,
      true,
    );
  },
  processWatchdog(4),
);

test(
  "refuses with recorded_hits_would_grow when the repair rerun recording step adds keys, commits nothing, and leaves the recorded-hits file byte-identical to the base",
  async () => {
    const { templateClone, baseCommit, targetCommit, branch } =
      createRecordedHitsUpgradeFixture(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "grow-after-repair-app",
    );
    const baseBytes = readFileSync(
      join(templateClone, "generated-repository/settings", HEALTH_FILE),
    );
    const worktree = worktreePath(repo, targetCommit);
    const failCheckFlag = join(folder("grow-repair-flag-"), "fail-check");
    writeFileSync(failCheckFlag, "1\n");
    const addedKeys = [
      "scripts/check-recorded-health-sizes.ts",
      "tests/skills.test.ts",
    ];
    const grownHealth = healthJson({ target_keys: addedKeys });
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-grow-repair-",
      `#!/bin/sh\necho "$*" >> __LEDGER__\nif [ "$1 $2" = "run quality:fallow:record-hits" ] && [ ! -f ${JSON.stringify(failCheckFlag)} ]; then\ncat <<'EOF' > ${HEALTH_FILE}\n${grownHealth}EOF\nexit 0\nfi\nif [ "$1 $2" = "run check" ] && [ -f ${JSON.stringify(failCheckFlag)} ]; then\necho "planted lint problem" >&2\nexit 1\nfi\nexit 0\n`,
    );
    const first = await applyJson(repo, targetCommit, templateClone, env);
    expect(first.exitCode).toBe(1);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
    });
    rmSync(failCheckFlag);
    writeFileSync(
      join(worktree, "src/repair.ts"),
      "export const repaired = true;\n",
    );
    const second = await applyJson(repo, targetCommit, templateClone, env);
    expectGrowthRefusal(second, repo, branch, worktree, baseBytes, addedKeys);
  },
  processWatchdog(4),
);

test(
  "passes and commits the refreshed identity when recording only re-identifies existing entries with the same keys and count",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "reidentify-only-app",
    );
    const baseDeadCode = `${JSON.stringify(
      {
        kind: "dead-code",
        analysis_identity: {
          mode: "type-aware",
          semantic_schema_version: 3,
          capabilities: ["symbol-use", "type-coupling"],
          project_config_hash: "old-config-hash",
          backend_family: "typescript-go",
          completeness: "complete",
          node_modules: "present",
        },
        identity: "dc1",
        unused_files: [],
        unused_exports: [{ path: "src/legacy.ts", export: "legacyHelper" }],
        unused_types: [],
        unused_dependencies: [],
        unused_dev_dependencies: [],
      },
      null,
      2,
    )}\n`;
    const baseHealth = healthJson({
      finding_counts: { complexity: 1 },
      identity_finding_counts: { "src/legacy.ts\u0000legacyHelper": 1 },
      target_keys: ["src/legacy.ts"],
    });
    commitIn(repo, "owner recorded hits", {
      "fallow-dead-code-recorded-hits.json": baseDeadCode,
      [HEALTH_FILE]: baseHealth,
    });
    const target = commitFallowGateChange(templateClone);
    const branch = branchName(baseCommit, target);
    const refreshedDeadCode = baseDeadCode
      .replace('"old-config-hash"', '"new-config-hash"')
      .replace('"dc1"', '"dc2"');
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-reidentify-",
      `#!/bin/sh\necho "$*" >> __LEDGER__\nif [ "$1 $2" = "run quality:fallow:record-hits" ]; then\ncat <<'EOF' > fallow-dead-code-recorded-hits.json\n${refreshedDeadCode}EOF\nfi\nexit 0\n`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "applied", branch });
    const committed = JSON.parse(
      git(repo, "show", `${branch}:fallow-dead-code-recorded-hits.json`),
    ) as {
      readonly analysis_identity: { readonly project_config_hash: string };
      readonly identity: string;
      readonly unused_exports: readonly {
        readonly path: string;
        readonly export: string;
      }[];
    };
    expect(committed.analysis_identity.project_config_hash).toBe(
      "new-config-hash",
    );
    expect(committed.identity).toBe("dc2");
    expect(committed.unused_exports).toEqual([
      { path: "src/legacy.ts", export: "legacyHelper" },
    ]);
  },
  processWatchdog(4),
);

test(
  "leaves an upgrade that does not run the recording step unchanged",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "no-record-step-app",
    );
    const baseBytes = readFileSync(join(repo, HEALTH_FILE));
    const target = commitTemplateLintChange(templateClone);
    const branch = branchName(baseCommit, target);
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-no-record-",
      `#!/bin/sh\necho "$*" >> __LEDGER__\nif [ "$1 $2" = "run quality:fallow:record-hits" ]; then\necho "recording step must not run" >&2\nexit 1\nfi\nexit 0\n`,
    );
    const run = await applyJson(repo, target, templateClone, env);
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "applied", branch });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run check",
    ]);
    const committed = Buffer.from(
      `${git(repo, "show", `${branch}:${HEALTH_FILE}`)}\n`,
    );
    expect(Buffer.compare(committed, baseBytes)).toBe(0);
  },
  processWatchdog(4),
);

test(
  "refuses with recorded_hits_would_grow when an old recorded function is still defined at its old path and a same-named function is added at a new path, commits nothing, and leaves the file byte-identical to the base",
  async () => {
    const { repo, branch, worktree, baseBytes, run } = await runMoveCase(
      "same-symbol-new-path-app",
      "src/old.ts",
      "src/new.ts",
      ":",
      CALC_FN,
      "export function calculate(v: number): number {\n  return v + 1;\n}\n",
    );
    expectGrowthRefusal(run, repo, branch, worktree, baseBytes, [
      "src/new.ts\u0000calculate",
    ]);
  },
  processWatchdog(4),
);

test(
  "refuses with recorded_hits_would_grow when an old recorded file is renamed keeping its function and a same-named function is added at a new path, commits nothing, and leaves the file byte-identical to the base",
  async () => {
    const { repo, branch, worktree, baseBytes, run } = await runMoveCase(
      "renamed-old-file-twin-app",
      "src/old0.ts",
      "src/new0.ts",
      "mv src/old0.ts src/renamed0.ts",
      CALC_FN,
      "export function calculate(v: number): number {\n  return v + 1;\n}\n",
    );
    expectGrowthRefusal(run, repo, branch, worktree, baseBytes, [
      "src/new0.ts\u0000calculate",
    ]);
  },
  processWatchdog(4),
);

test(
  "passes when a recorded function is truly moved out of its old file and defined only at the new path",
  async () => {
    const { branch, run } = await runMoveCase(
      "truly-moved-symbol-app",
      "src/old.ts",
      "src/new.ts",
      "printf 'export const keep = 1;\\n' > src/old.ts",
      `export const keep = 1;\n${CALC_FN}`,
    );
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "applied", branch });
  },
  processWatchdog(4),
);

test(
  "passes when an old recorded file is deleted entirely and its function is defined only at the new path",
  async () => {
    const { branch, run } = await runMoveCase(
      "deleted-old-file-move-app",
      "src/old.ts",
      "src/new.ts",
      "rm src/old.ts",
    );
    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "applied", branch });
  },
  processWatchdog(4),
);

test(
  "restores recorded-hits files byte-identical to the base when the growth check throws a read error after repair recording",
  async () => {
    const { templateClone, baseCommit, targetCommit, branch } =
      createRecordedHitsUpgradeFixture(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "grow-read-error-app",
    );
    const baseBytes = readFileSync(
      join(templateClone, "generated-repository/settings", HEALTH_FILE),
    );
    const worktree = worktreePath(repo, targetCommit);
    const healthPath = join(worktree, HEALTH_FILE);
    const failCheckFlag = join(folder("read-error-flag-"), "fail-check");
    writeFileSync(failCheckFlag, "1\n");
    const grownHealth = healthHitJson("src/added.ts");
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-read-error-",
      `#!/bin/sh\necho "$*" >> __LEDGER__\nif [ "$1 $2" = "run quality:fallow:record-hits" ] && [ ! -f ${JSON.stringify(failCheckFlag)} ]; then\ncat <<'EOF' > ${HEALTH_FILE}\n${grownHealth}EOF\nchmod 200 ${HEALTH_FILE}\nexit 0\nfi\nif [ "$1 $2" = "run check" ] && [ -f ${JSON.stringify(failCheckFlag)} ]; then\necho "planted lint problem" >&2\nexit 1\nfi\nexit 0\n`,
    );
    const first = await applyJson(repo, targetCommit, templateClone, env);
    expect(first.exitCode).toBe(1);
    rmSync(failCheckFlag);
    writeFileSync(join(worktree, "src/repair.ts"), "export const r = 1;\n");
    try {
      const second = await applyJson(repo, targetCommit, templateClone, env);
      expect(second.exitCode).not.toBe(0);
      expect(git(repo, "branch", "--list", branch)).toBe("");
      chmodSync(healthPath, 0o644);
      expect(Buffer.compare(readFileSync(healthPath), baseBytes)).toBe(0);
    } finally {
      chmodSync(healthPath, 0o644);
    }
  },
  processWatchdog(4),
);

test(
  "refuses with recorded_hits_would_grow when the old file is deleted and a third tracked file defines the symbol as a later declarator, commits nothing, and leaves the file byte-identical to the base",
  async () => {
    const { repo, branch, worktree, baseBytes, run } = await runMoveCase(
      "later-declarator-twin-app",
      "src/old.ts",
      "src/new.ts",
      "rm src/old.ts",
      CALC_FN,
      "export function calculate(v: number): number {\n  return v + 1;\n}\n",
      {
        "src/other.ts":
          "export const marker = 0, calculate = (v: number): number => v;\n",
      },
    );
    expectGrowthRefusal(run, repo, branch, worktree, baseBytes, [
      "src/new.ts\u0000calculate",
    ]);
  },
  processWatchdog(4),
);

test(
  "ignores string and comment mentions of a symbol when checking moves, refusing a new file with only a string or comment mention while allowing a real move",
  async () => {
    const mentionOnly =
      'export const note = "function calculate() {}";\n// function calculate() {}\n';
    const refused = await runMoveCase(
      "mention-only-new-app",
      "src/old.ts",
      "src/new.ts",
      "rm src/old.ts",
      CALC_FN,
      mentionOnly,
    );
    expectGrowthRefusal(
      refused.run,
      refused.repo,
      refused.branch,
      refused.worktree,
      refused.baseBytes,
      ["src/new.ts\u0000calculate"],
    );
    const allowed = await runMoveCase(
      "mention-only-other-app",
      "src/old.ts",
      "src/new.ts",
      "rm src/old.ts",
      CALC_FN,
      CALC_FN,
      { "src/note.ts": mentionOnly },
    );
    expect(allowed.run.exitCode).toBe(0);
    expect(allowed.run.stderr).toBe("");
    expect(JSON.parse(allowed.run.stdout)).toMatchObject({
      status: "applied",
      branch: allowed.branch,
    });
  },
  processWatchdog(6),
);
