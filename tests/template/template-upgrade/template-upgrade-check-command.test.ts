import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git } from "../../support/git-fixture.ts";
import {} from "../../support/kernel-sibling.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

test(
  "always runs bun install before bun run check even without a package.json change, and commits a bun.lock updated by install",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "no-package-change-app",
    );
    const targetCommit = commitTemplateLintChange(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-no-pkg-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  printf 'updated-by-install\\n' >> bun.lock
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  if ! grep -q '^updated-by-install$' bun.lock; then
    echo "eslint: command not found" >&2
    exit 127
  fi
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
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "applied",
      branch,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "passed" },
      ],
    });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run check",
    ]);
    expect(git(repo, "show", `${branch}:bun.lock`)).toContain(
      "updated-by-install",
    );

    const textRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "no-package-text-app",
    );
    const textRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", textRepo, "--to", targetCommit],
      { templateRoot: templateClone, env },
    );
    expect(textRun.exitCode).toBe(0);
    expect(textRun.stdout).toContain(`Target commit: ${targetCommit}`);
    expect(textRun.stdout).toContain("bun install: passed");
    expect(textRun.stdout).toContain("bun run check: passed");

    const skippedRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "no-check-steps-app",
    );
    const skippedJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        skippedRepo,
        "--to",
        targetCommit,
        "--no-check",
        "--json",
      ],
      { templateRoot: templateClone, env },
    );
    expect(skippedJsonRun.exitCode).toBe(0);
    expect(JSON.parse(skippedJsonRun.stdout)).toMatchObject({
      status: "applied",
      steps: [
        {
          command: "bun install",
          ran: false,
          outcome: "skipped",
          reason: "--no-check",
        },
        {
          command: "bun run check",
          ran: false,
          outcome: "skipped",
          reason: "--no-check",
        },
      ],
    });

    const skippedTextRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "no-check-text-app",
    );
    const skippedTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        skippedTextRepo,
        "--to",
        targetCommit,
        "--no-check",
      ],
      { templateRoot: templateClone, env },
    );
    expect(skippedTextRun.exitCode).toBe(0);
    expect(skippedTextRun.stdout).toContain(
      "bun install: skipped (--no-check)",
    );
    expect(skippedTextRun.stdout).toContain(
      "bun run check: skipped (--no-check)",
    );
  },
  processWatchdog(4),
);

test(
  "runs bun install and bun run check when --no-check is omitted, and reports check-failed leaving the worktree",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "checked-app",
    );
    const failFlag = join(folder("scripted-bun-flag-"), "fail-check");
    writeFileSync(failFlag, "1\n");
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "check" ] && [ -f ${JSON.stringify(failFlag)} ]; then
  echo "planted check failure" >&2
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
    const runtime = { templateRoot: templateClone, env };
    const expectedWorktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );

    const failRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(failRun.exitCode).toBe(1);
    expect(JSON.parse(failRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
      worktree: expectedWorktree,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "failed" },
      ],
    });
    expect(existsSync(expectedWorktree)).toBe(true);
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run check",
    ]);

    const failTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit],
      runtime,
    );
    expect(failTextRun.exitCode).toBe(1);
    expect(failTextRun.stdout).toContain(`Target commit: ${targetCommit}`);
    expect(failTextRun.stdout).toContain("bun install: passed");
    expect(failTextRun.stdout).toContain("bun run check: failed");

    rmSync(failFlag);
    const passRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(passRun.exitCode).toBe(0);
    expect(JSON.parse(passRun.stdout)).toMatchObject({
      status: "applied",
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "passed" },
      ],
    });
    expect(existsSync(expectedWorktree)).toBe(false);
  },
  processWatchdog(4),
);

test(
  "reports bun install failed and bun run check skipped when bun install fails",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "install-fail-app",
    );
    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-install-fail-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  echo "planted install failure" >&2
  exit 1
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const runtime = { templateRoot: templateClone, env };

    const jsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(jsonRun.exitCode).toBe(1);
    expect(JSON.parse(jsonRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun install",
      steps: [
        { command: "bun install", ran: true, outcome: "failed" },
        {
          command: "bun run check",
          ran: false,
          outcome: "skipped",
          reason: "bun install failed",
        },
      ],
    });

    const textRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit],
      runtime,
    );
    expect(textRun.exitCode).toBe(1);
    expect(textRun.stdout).toContain(`Target commit: ${targetCommit}`);
    expect(textRun.stdout).toContain("bun install: failed");
    expect(textRun.stdout).toContain(
      "bun run check: skipped (bun install failed)",
    );
  },
  processWatchdog(4),
);

test(
  "production entry src/template-upgrade.ts runs as a CLI process for --help and refusals",
  async () => {
    const help = await spawnBounded(
      [process.execPath, "run", "src/template-upgrade.ts", "--help"],
      { cwd: ROOT, processGroup: true },
    );
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("bun run upgrade plan --repository PATH");

    const nonRepo = folder("cli-non-repo-");
    const refused = await spawnBounded(
      [
        process.execPath,
        "run",
        "src/template-upgrade.ts",
        "plan",
        "--repository",
        nonRepo,
        "--json",
      ],
      { cwd: ROOT, processGroup: true },
    );
    expect(refused.exit).toBe(2);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr)).toMatchObject({
      schemaVersion: 1,
      status: "refused",
      error: { code: "not_git_repository" },
    });
  },
  processWatchdog(2),
);
