import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  recordedHitsRequestFor,
  runRecordedHitsStep,
} from "../../../src/template-upgrade-recorded-hits.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  createRecordedHitsUpgradeFixture,
  invokeTemplateUpgradeMain,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

test(
  "does not rerun the recorded-hits script on retry when the first recording left the template's empty files, so a finding added during the repair still fails the check",
  async () => {
    const { templateClone, baseCommit, targetCommit } =
      createRecordedHitsUpgradeFixture(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "retry-empty-recorded-hits-app",
    );
    const failFlag = join(folder("scripted-bun-empty-retry-flag-"), "fail");
    writeFileSync(failFlag, "1\n");
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-empty-retry-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  if [ -f src/repair-export.ts ]; then
    printf '{"recorded":"unusedRepairExport"}\\n' > fallow-dead-code-recorded-hits.json
  fi
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  if [ -f ${JSON.stringify(failFlag)} ]; then
    echo "planted check failure" >&2
    exit 1
  fi
  if [ -f src/repair-export.ts ] && ! grep -q unusedRepairExport fallow-dead-code-recorded-hits.json; then
    echo "new finding: unused export unusedRepairExport" >&2
    exit 1
  fi
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
    const runtime = { templateRoot: templateClone, env };
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const emptyDeadCode = readFileSync(
      join(
        templateClone,
        "generated-repository/settings/fallow-dead-code-recorded-hits.json",
      ),
      "utf8",
    );

    const firstRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(firstRun.exitCode).toBe(1);
    expect(JSON.parse(firstRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
      worktree,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
        },
        { command: "bun run check", ran: true, outcome: "failed" },
      ],
    });
    expect(
      readFileSync(
        join(worktree, "fallow-dead-code-recorded-hits.json"),
        "utf8",
      ),
    ).toBe(emptyDeadCode);

    rmSync(failFlag);
    writeFileSync(
      join(worktree, "src/repair-export.ts"),
      "export const unusedRepairExport = 1;\n",
    );
    const retryRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(retryRun.exitCode).toBe(1);
    expect(JSON.parse(retryRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
      worktree,
      checkCommandOutput: "new finding: unused export unusedRepairExport",
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "failed" },
      ],
    });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run quality:fallow:record-hits",
      "run check",
      "install",
      "run check",
    ]);
    expect(
      readFileSync(
        join(worktree, "fallow-dead-code-recorded-hits.json"),
        "utf8",
      ),
    ).toBe(emptyDeadCode);
  },
  processWatchdog(4),
);

test(
  "recovers durable pre-record snapshots after an interrupted identity-only restoration or failed-recording rollback without absorbing new findings on retry",
  () => {
    const setupInterruptedCase = (name: string, recordExitCode: number) => {
      const repo = folder(`${name}-repo-`);
      initRepository(repo);
      const originalDeadCode =
        '{"kind":"dead-code","analysis_identity":{"project_config_hash":"old"},"boundary_violations":[]}\n';
      const originalDupes =
        '{"kind":"dupes","clone_groups":[],"clone_fingerprints":[]}\n';
      const originalHealth =
        '{"kind":"health","runtime_coverage_findings":[],"target_keys":[]}\n';
      const { sha: repositoryHead } = commitIn(repo, "committed hits", {
        "package.json":
          '{"name":"interrupt-app","scripts":{"quality:fallow:record-hits":"true"}}\n',
        "fallow-dead-code-recorded-hits.json": originalDeadCode,
        "fallow-duplicates-recorded-hits.json": originalDupes,
        "fallow-health-recorded-hits.json": originalHealth,
      });
      const worktree = folder(`${name}-wt-`);
      git(
        repo,
        "worktree",
        "add",
        "--quiet",
        "--detach",
        worktree,
        repositoryHead,
      );
      const interruptFlag = join(folder(`${name}-flag-`), "interrupt");
      writeFileSync(interruptFlag, "1\n");
      const { ledger, env } = writeScriptedBun(
        folder,
        `${name}-bun-`,
        `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  printf '{"kind":"dead-code","analysis_identity":{"project_config_hash":"new"},"boundary_violations":["b1"]}\\n' > fallow-dead-code-recorded-hits.json
  printf '{"kind":"dupes","clone_groups":["g1"],"clone_fingerprints":["d1"]}\\n' > fallow-duplicates-recorded-hits.json
  printf '{"kind":"health","runtime_coverage_findings":[],"target_keys":["h1"]}\\n' > fallow-health-recorded-hits.json
  if [ -f ${JSON.stringify(interruptFlag)} ]; then
    chmod 444 fallow-duplicates-recorded-hits.json
    exit ${recordExitCode}
  fi
  exit 0
fi
exit 0
`,
      );
      const request = recordedHitsRequestFor(
        worktree,
        {
          templateRoot: ROOT,
          targetCommit: git(ROOT, "rev-parse", "HEAD"),
          repository: repo,
          repositoryHead,
        },
        env,
        {
          rows: [
            {
              path: ".fallowrc.json",
              ownerLabel: "shared",
              outcome: "take",
            },
          ],
          dependencyChanges: [],
        },
      );
      return {
        worktree,
        interruptFlag,
        ledger,
        request,
        originalDupes,
        originalHealth,
      };
    };

    for (const [name, exitCode] of [
      ["interrupt-keep-identity", 0],
      ["interrupt-failed-rollback", 1],
    ] as const) {
      const scenario = setupInterruptedCase(name, exitCode);
      const dupesPath = join(
        scenario.worktree,
        "fallow-duplicates-recorded-hits.json",
      );
      try {
        expect(() => runRecordedHitsStep(scenario.request, 10_000)).toThrow(
          /EACCES|permission denied/i,
        );
      } finally {
        chmodSync(dupesPath, 0o644);
      }
      expect(readFileSync(dupesPath, "utf8")).toContain('"d1"');

      rmSync(scenario.interruptFlag);
      const retry = runRecordedHitsStep(scenario.request, 10_000);
      expect(retry.ok).toBe(true);
      expect(
        JSON.parse(
          readFileSync(
            join(scenario.worktree, "fallow-dead-code-recorded-hits.json"),
            "utf8",
          ),
        ),
      ).toEqual({
        kind: "dead-code",
        analysis_identity: { project_config_hash: "new" },
        boundary_violations: [],
      });
      expect(readFileSync(dupesPath, "utf8")).toBe(scenario.originalDupes);
      expect(
        readFileSync(
          join(scenario.worktree, "fallow-health-recorded-hits.json"),
          "utf8",
        ),
      ).toBe(scenario.originalHealth);

      const pendingDir = git(
        scenario.worktree,
        "rev-parse",
        "--path-format=absolute",
        "--git-path",
        "template-upgrade-recorded-hits-pending",
      );
      expect(existsSync(pendingDir)).toBe(false);
      mkdirSync(pendingDir, { recursive: true });
      writeFileSync(
        join(pendingDir, "state.json"),
        '{"action":"refresh-changed"}\n',
      );

      const third = runRecordedHitsStep(scenario.request, 10_000);
      expect(third).toEqual({ ok: true, steps: [] });
      expect(existsSync(pendingDir)).toBe(false);
      expect(readFileSync(scenario.ledger, "utf8").trim().split("\n")).toEqual([
        "run quality:fallow:record-hits",
        "run quality:fallow:record-hits",
      ]);
    }
  },
  processWatchdog(4),
);
