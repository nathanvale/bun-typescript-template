import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { classifyTemplateUpgradeGateFailure } from "../../../src/template-upgrade-gates.ts";
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
  cloneTemplateAtHead,
  commitTemplateLintChange,
  invokeTemplateUpgradeMain,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

test(
  "classifyTemplateUpgradeGateFailure stays check-failed for Fallow errors, ESLint crashes, template-owned file failures, and upgrades without gate changes, and check-failed text prints unlock steps",
  async () => {
    const worktree = folder("classify-gate-worktree-");
    const fallowRows = [
      {
        path: ".fallowrc.json",
        ownerLabel: "shared" as const,
        outcome: "take" as const,
      },
      {
        path: "tests/git-fixture.test.ts",
        ownerLabel: "template" as const,
        outcome: "take" as const,
      },
    ];
    expect(
      classifyTemplateUpgradeGateFailure({
        rows: fallowRows,
        dependencyChanges: [],
        checkCommandOutput:
          '{"error":true,"message":"baseline analysis identity is incompatible in: project_config_hash","exit_code":2}\n',
        worktree,
        exitCode: 2,
        timedOut: false,
        signalCode: null,
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: fallowRows,
        dependencyChanges: [],
        checkCommandOutput: `${JSON.stringify({
          kind: "combined",
          gate_outcomes: {
            "error-severity-findings": { status: "fail", enforced: true },
            "type-aware-require": { status: "pass", enforced: true },
          },
          check: {
            unused_files: [{ path: "tests/git-fixture.test.ts" }],
          },
        })}\n`,
        worktree,
        exitCode: 1,
        timedOut: false,
        signalCode: null,
        predatedProblems: [
          {
            gate: "fallow",
            code: "unused-files",
            path: "tests/git-fixture.test.ts",
            message: "unused-files in tests/git-fixture.test.ts",
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: [
          {
            path: "eslint.config.mjs",
            ownerLabel: "template" as const,
            outcome: "take" as const,
          },
        ],
        dependencyChanges: [],
        checkCommandOutput:
          "Oops! Something went wrong! :(\nError: broken config\n",
        worktree,
        exitCode: 2,
        timedOut: false,
        signalCode: null,
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: [
          {
            path: "README.md",
            ownerLabel: "repository" as const,
            outcome: "template-copy-changed" as const,
          },
        ],
        dependencyChanges: [],
        checkCommandOutput:
          "src/foo.ts(4,3): error TS7027: Unreachable code detected.\n",
        worktree,
        exitCode: 2,
        timedOut: false,
        signalCode: null,
        predatedProblems: [
          {
            gate: "typecheck",
            code: "TS7027",
            path: "src/foo.ts",
            message: "line 4: Unreachable code detected.",
          },
        ],
      }),
    ).toBeUndefined();

    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateLintChange(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "check-failed-unlock-app",
    );
    const failCheckBun = writeScriptedBun(
      folder,
      "scripted-bun-unlock-check-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  echo "unexpected crash in check" >&2
  exit 1
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const expectedWorktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const target7 = targetCommit.slice(0, 7);
    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit],
      { templateRoot: templateClone, env: failCheckBun.env },
    );
    expect(run.exitCode).toBe(1);
    expect(run.stdout).toContain("bun run check failed");
    expect(run.stdout).toContain(
      "Repair the failure in that worktree, then rerun the same upgrade apply command.",
    );
    expect(run.stdout).toContain(
      `bun run upgrade recover --repository ${repo} --to ${target7}`,
    );
    expect(run.stdout).toContain("save any edits");
    expect(run.stdout).not.toContain("--force");
    expect(run.stdout).toContain(expectedWorktree);
    writeFileSync(join(worktree, "done.txt"), "ok\n");
  },
  processWatchdog(4),
);

test(
  "restores snapshots after a failed recording, inspects all clone instances for modified template files, and classifies script-only gate changes",
  () => {
    const worktree = folder("p1-gate-worktree-");
    expect(
      classifyTemplateUpgradeGateFailure({
        rows: [
          {
            path: ".fallowrc.json",
            ownerLabel: "shared",
            outcome: "take",
          },
          {
            path: "tests/git-fixture.test.ts",
            ownerLabel: "template",
            outcome: "take",
          },
        ],
        dependencyChanges: [],
        checkCommandOutput: `${JSON.stringify({
          kind: "combined",
          gate_outcomes: {
            "duplication-findings": { status: "fail", enforced: true },
            "type-aware-require": { status: "pass", enforced: true },
          },
          dupes: {
            clone_groups: [
              {
                instances: [
                  { file: "src/records.ts" },
                  { file: "tests/git-fixture.test.ts" },
                ],
              },
            ],
          },
        })}\n`,
        worktree,
        exitCode: 1,
        timedOut: false,
        signalCode: null,
        predatedProblems: [
          {
            gate: "fallow",
            code: "duplicate-code",
            path: "src/records.ts",
            message: "duplicate code group in src/records.ts",
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: [
          {
            path: "package.json",
            ownerLabel: "shared",
            outcome: "merge",
          },
        ],
        dependencyChanges: [],
        beforePackage: JSON.stringify({
          scripts: { "quality:fallow": "fallow --quiet" },
        }),
        afterPackage: JSON.stringify({
          scripts: { "quality:fallow": "fallow --quiet --fail-on-issues" },
        }),
        checkCommandOutput: `${JSON.stringify({
          kind: "combined",
          gate_outcomes: {
            "error-severity-findings": { status: "fail", enforced: true },
            "type-aware-require": { status: "pass", enforced: true },
          },
          check: {
            boundary_violations: [
              {
                from_path: "src/commands/records.ts",
                to_path: "src/records/find.ts",
                from_zone: "subject/commands",
                to_zone: "subject/records",
              },
            ],
          },
        })}\n`,
        worktree,
        exitCode: 1,
        timedOut: false,
        signalCode: null,
        predatedProblems: [
          {
            gate: "fallow",
            code: "boundary-violation",
            path: "src/commands/records.ts",
            message:
              "src/commands/records.ts imports src/records/find.ts (subject/commands -> subject/records)",
          },
        ],
      }),
    ).toMatchObject({
      gate: "fallow",
      gateFiles: ["package.json"],
      problems: [
        {
          code: "boundary-violation",
          path: "src/commands/records.ts",
        },
      ],
    });

    const partialRepo = folder("partial-record-repo-");
    initRepository(partialRepo);
    const originalDeadCode =
      '{"kind":"dead-code","analysis_identity":{"project_config_hash":"old"},"boundary_violations":[]}\n';
    const { sha: partialHead } = commitIn(partialRepo, "committed hits", {
      "package.json":
        '{"name":"partial-app","scripts":{"quality:fallow:record-hits":"true"}}\n',
      "fallow-dead-code-recorded-hits.json": originalDeadCode,
      "fallow-duplicates-recorded-hits.json":
        '{"kind":"dupes","clone_groups":[]}\n',
      "fallow-health-recorded-hits.json":
        '{"kind":"health","target_keys":[]}\n',
    });
    const partialWorktree = folder("partial-record-wt-");
    git(
      partialRepo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      partialWorktree,
      partialHead,
    );
    const partialBun = writeScriptedBun(
      folder,
      "scripted-bun-partial-record-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  printf '{"kind":"dead-code","analysis_identity":{"project_config_hash":"new"},"boundary_violations":["b1"]}\\n' > fallow-dead-code-recorded-hits.json
  echo "second command failed" >&2
  exit 1
fi
exit 0
`,
    );
    const partialResult = runRecordedHitsStep(
      recordedHitsRequestFor(
        partialWorktree,
        {
          templateRoot: ROOT,
          targetCommit: git(ROOT, "rev-parse", "HEAD"),
          repository: partialRepo,
          repositoryHead: partialHead,
        },
        partialBun.env,
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
      ),
      10_000,
    );
    expect(partialResult.ok).toBe(false);
    expect(
      readFileSync(
        join(partialWorktree, "fallow-dead-code-recorded-hits.json"),
        "utf8",
      ),
    ).toBe(originalDeadCode);
  },
  processWatchdog(2),
);

test(
  "refuses gate-adoption-required on timeout, crash after findings, unchanged template file failing a new gate, or unestablished predating findings",
  () => {
    const worktree = folder("misclassification-wt-");
    const fallowCombined = JSON.stringify({
      kind: "combined",
      gate_outcomes: {
        "error-severity-findings": { status: "fail", enforced: true },
        "type-aware-require": { status: "pass", enforced: true },
      },
      check: {
        boundary_violations: [
          {
            from_path: "src/commands/records.ts",
            to_path: "src/records/find.ts",
            from_zone: "subject/commands",
            to_zone: "subject/records",
          },
        ],
      },
    });
    const predatedFallow = [
      {
        gate: "fallow" as const,
        code: "boundary-violation",
        path: "src/commands/records.ts",
        message:
          "src/commands/records.ts imports src/records/find.ts (subject/commands -> subject/records)",
      },
    ];
    const fallowRows = [
      {
        path: ".fallowrc.json",
        ownerLabel: "shared" as const,
        outcome: "take" as const,
      },
    ];

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: fallowRows,
        dependencyChanges: [],
        checkCommandOutput: `bun run check did not finish within 240000 ms\n${fallowCombined}\n`,
        worktree,
        exitCode: null,
        timedOut: true,
        signalCode: "SIGKILL",
        predatedProblems: predatedFallow,
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: fallowRows,
        dependencyChanges: [],
        checkCommandOutput: `${fallowCombined}\nTypeError: unexpected crash\n`,
        worktree,
        exitCode: 1,
        timedOut: false,
        signalCode: null,
        predatedProblems: predatedFallow,
      }),
    ).toBeUndefined();

    for (const exit of [
      { exitCode: null, timedOut: true, signalCode: "SIGKILL" },
      { exitCode: null, timedOut: false, signalCode: "SIGTERM" },
      { exitCode: 137, timedOut: false, signalCode: null },
      { exitCode: 2, timedOut: false, signalCode: null },
    ]) {
      expect(
        classifyTemplateUpgradeGateFailure({
          rows: fallowRows,
          dependencyChanges: [],
          checkCommandOutput: `${fallowCombined}\n`,
          worktree,
          ...exit,
          predatedProblems: predatedFallow,
        }),
      ).toBeUndefined();
    }

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: fallowRows,
        dependencyChanges: [],
        checkCommandOutput: `${fallowCombined}\n`,
        worktree,
        exitCode: 1,
        timedOut: false,
        signalCode: null,
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: [
          {
            path: "tsconfig.base.json",
            ownerLabel: "shared",
            outcome: "take",
          },
          {
            path: "tests/add-on-start-up.test.ts",
            ownerLabel: "template",
            outcome: "untouched",
          },
        ],
        dependencyChanges: [],
        checkCommandOutput:
          "tests/add-on-start-up.test.ts(10,3): error TS7027: Unreachable code detected.\n",
        worktree,
        exitCode: 2,
        timedOut: false,
        signalCode: null,
        predatedProblems: [
          {
            gate: "typecheck",
            code: "TS7027",
            path: "tests/add-on-start-up.test.ts",
            message: "line 10: Unreachable code detected.",
          },
        ],
      }),
    ).toBeUndefined();

    expect(
      classifyTemplateUpgradeGateFailure({
        rows: [
          {
            path: "tsconfig.base.json",
            ownerLabel: "shared",
            outcome: "take",
          },
          {
            path: "tests/support/test-folder.ts",
            ownerLabel: "template",
            outcome: "take",
          },
        ],
        dependencyChanges: [],
        checkCommandOutput:
          'tests/owner.test.ts(2,10): error TS2305: Module "./support/test-folder.ts" has no exported member "testFolder".\n',
        worktree,
        exitCode: 2,
        timedOut: false,
        signalCode: null,
        predatedProblems: [],
      }),
    ).toBeUndefined();

    const valid = classifyTemplateUpgradeGateFailure({
      rows: fallowRows,
      dependencyChanges: [],
      checkCommandOutput: `${fallowCombined}\n`,
      worktree,
      exitCode: 1,
      timedOut: false,
      signalCode: null,
      predatedProblems: predatedFallow,
    });
    expect(valid?.gate).toBe("fallow");
    expect(valid?.repair).toContain("Fix the listed problems");
    expect(valid?.repair).toContain("Only if you intentionally choose");
    expect(valid?.repair).toContain("never to hide new mistakes");
  },
  processWatchdog(2),
);
