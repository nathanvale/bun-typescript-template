import { expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
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
