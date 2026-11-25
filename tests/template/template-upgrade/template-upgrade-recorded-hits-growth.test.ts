import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
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

function commitFallowGateChange(templateClone: string): string {
  const fallowRcPath = join(
    templateClone,
    "generated-repository/settings/.fallowrc.json",
  );
  const current = readFileSync(fallowRcPath, "utf8");
  writeFileSync(fallowRcPath, `${current.trimEnd()}\n\n`);
  git(
    templateClone,
    "add",
    "--",
    "generated-repository/settings/.fallowrc.json",
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "change fallow settings for recorded-hits test",
  );
  return git(templateClone, "rev-parse", "HEAD");
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
    const baseHealthBytes = readFileSync(
      join(repo, "fallow-health-recorded-hits.json"),
    );
    const targetCommit = commitFallowGateChange(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const addedKeys = [
      "scripts/check-recorded-health-sizes.ts",
      "tests/skills.test.ts",
      "eslint.config.mjs",
    ];
    const grownHealth = `${JSON.stringify(
      {
        kind: "health",
        finding_counts: {},
        identity_finding_counts: {},
        runtime_coverage_findings: [],
        target_keys: addedKeys,
      },
      null,
      2,
    )}\n`;
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-grow-health-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  cat <<'EOF' > fallow-health-recorded-hits.json
${grownHealth}EOF
  exit 0
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );

    expect(run.exitCode).not.toBe(0);
    const refusal = JSON.parse(run.stderr) as {
      readonly status: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly repair: string;
      };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.error.code).toBe("recorded_hits_would_grow");
    expect(refusal.error.message).toContain("fallow-health-recorded-hits.json");
    for (const key of addedKeys) {
      expect(refusal.error.message).toContain(key);
    }
    expect(refusal.error.repair).toContain("later commit");
    expect(refusal.error.repair).toContain("rerun");
    expect(git(repo, "branch", "--list", branch)).toBe("");
    const afterBytes = readFileSync(
      join(worktree, "fallow-health-recorded-hits.json"),
    );
    expect(Buffer.compare(afterBytes, baseHealthBytes)).toBe(0);
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
    const expectedBaseHealth = readFileSync(
      join(
        templateClone,
        "generated-repository/settings/fallow-health-recorded-hits.json",
      ),
    );
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const failCheckFlag = join(folder("grow-repair-flag-"), "fail-check");
    writeFileSync(failCheckFlag, "1\n");
    const addedKeys = [
      "scripts/check-recorded-health-sizes.ts",
      "tests/skills.test.ts",
    ];
    const grownHealth = `${JSON.stringify(
      {
        kind: "health",
        finding_counts: {},
        identity_finding_counts: {},
        runtime_coverage_findings: [],
        target_keys: addedKeys,
      },
      null,
      2,
    )}\n`;
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-grow-repair-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  if [ ! -f ${JSON.stringify(failCheckFlag)} ]; then
    cat <<'EOF' > fallow-health-recorded-hits.json
${grownHealth}EOF
  fi
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "check" ] && [ -f ${JSON.stringify(failCheckFlag)} ]; then
  echo "planted lint problem" >&2
  exit 1
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = [
      "apply",
      "--repository",
      repo,
      "--to",
      targetCommit,
      "--json",
    ];

    const first = await invokeTemplateUpgradeMain(stdout, stderr, args, {
      templateRoot: templateClone,
      env,
    });
    expect(first.exitCode).toBe(1);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
    });

    rmSync(failCheckFlag);
    const second = await invokeTemplateUpgradeMain(stdout, stderr, args, {
      templateRoot: templateClone,
      env,
    });
    expect(second.exitCode).not.toBe(0);
    const refusal = JSON.parse(second.stderr) as {
      readonly status: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly repair: string;
      };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.error.code).toBe("recorded_hits_would_grow");
    expect(refusal.error.message).toContain("fallow-health-recorded-hits.json");
    for (const key of addedKeys) {
      expect(refusal.error.message).toContain(key);
    }
    expect(git(repo, "branch", "--list", branch)).toBe("");
    const afterBytes = readFileSync(
      join(worktree, "fallow-health-recorded-hits.json"),
    );
    expect(Buffer.compare(afterBytes, expectedBaseHealth)).toBe(0);
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
    const baseHealth = `${JSON.stringify(
      {
        kind: "health",
        finding_counts: { complexity: 1 },
        identity_finding_counts: { "src/legacy.ts\u0000legacyHelper": 1 },
        runtime_coverage_findings: [],
        target_keys: ["src/legacy.ts"],
      },
      null,
      2,
    )}\n`;
    commitIn(repo, "owner recorded hits", {
      "fallow-dead-code-recorded-hits.json": baseDeadCode,
      "fallow-health-recorded-hits.json": baseHealth,
    });
    const targetCommit = commitFallowGateChange(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const refreshedDeadCode = baseDeadCode
      .replace('"old-config-hash"', '"new-config-hash"')
      .replace('"dc1"', '"dc2"');
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-reidentify-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  cat <<'EOF' > fallow-dead-code-recorded-hits.json
${refreshedDeadCode}EOF
  exit 0
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    const committedDeadCode = JSON.parse(
      git(repo, "show", `${branch}:fallow-dead-code-recorded-hits.json`),
    ) as {
      readonly analysis_identity: { readonly project_config_hash: string };
      readonly identity: string;
      readonly unused_exports: readonly {
        readonly path: string;
        readonly export: string;
      }[];
    };
    expect(committedDeadCode.analysis_identity.project_config_hash).toBe(
      "new-config-hash",
    );
    expect(committedDeadCode.identity).toBe("dc2");
    expect(committedDeadCode.unused_exports).toEqual([
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
    const baseHealthBytes = readFileSync(
      join(repo, "fallow-health-recorded-hits.json"),
    );
    const targetCommit = commitTemplateLintChange(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-no-record-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  echo "recording step must not run" >&2
  exit 1
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );

    expect(run.exitCode).toBe(0);
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run check",
    ]);
    const committedHealth = Buffer.from(
      `${git(repo, "show", `${branch}:fallow-health-recorded-hits.json`)}\n`,
    );
    expect(Buffer.compare(committedHealth, baseHealthBytes)).toBe(0);
  },
  processWatchdog(4),
);
