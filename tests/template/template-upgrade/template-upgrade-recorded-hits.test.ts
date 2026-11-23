import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  noCheckTemplateUpgradeSteps,
  recordedHitsRequestFor,
  runRecordedHitsStep,
} from "../../../src/template-upgrade-recorded-hits.ts";
import {} from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, initRepository } from "../../support/git-fixture.ts";
import {} from "../../support/kernel-sibling.ts";
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

const RECORDED_HITS_FILES = [
  "fallow-dead-code-recorded-hits.json",
  "fallow-duplicates-recorded-hits.json",
  "fallow-health-recorded-hits.json",
] as const;

test(
  "runs the recorded-hits script after bun install and before bun run check when an upgrade adds new recorded-hits files, commits them, and reports the step",
  async () => {
    const { templateClone, baseCommit, targetCommit, branch } =
      createRecordedHitsUpgradeFixture(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "new-recorded-hits-app",
    );
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-record-hits-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  printf '{"recorded":true,"file":"dead-code"}\\n' > fallow-dead-code-recorded-hits.json
  printf '{"recorded":true,"file":"duplicates"}\\n' > fallow-duplicates-recorded-hits.json
  printf '{"recorded":true,"file":"health"}\\n' > fallow-health-recorded-hits.json
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  if ! grep -q '"recorded":true' fallow-dead-code-recorded-hits.json; then
    echo "existing findings were not recorded before check" >&2
    exit 1
  fi
  exit 0
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const jsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(jsonRun.exitCode).toBe(0);
    expect(JSON.parse(jsonRun.stdout)).toMatchObject({
      status: "applied",
      branch,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
        },
        { command: "bun run check", ran: true, outcome: "passed" },
        {
          command: "fallow audit",
          ran: false,
          outcome: "skipped",
          reason: "node_modules/.bin/fallow not found",
        },
      ],
    });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run quality:fallow:record-hits",
      "run check",
    ]);
    expect(
      git(repo, "show", `${branch}:fallow-dead-code-recorded-hits.json`),
    ).toContain('"recorded":true');
    expect(
      git(repo, "show", `${branch}:fallow-duplicates-recorded-hits.json`),
    ).toContain('"recorded":true');
    expect(
      git(repo, "show", `${branch}:fallow-health-recorded-hits.json`),
    ).toContain('"recorded":true');

    const textRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "new-recorded-hits-text-app",
    );
    const textRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", textRepo, "--to", targetCommit],
      { templateRoot: templateClone, env },
    );
    expect(textRun.exitCode).toBe(0);
    expect(textRun.stdout).toContain("bun install: passed");
    expect(textRun.stdout).toContain(
      "bun run quality:fallow:record-hits: passed",
    );
    expect(textRun.stdout).toContain("bun run check: passed");

    const failRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "record-hits-fail-app",
    );
    const failingBun = writeScriptedBun(
      folder,
      "scripted-bun-record-fail-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  echo "planted record-hits failure" >&2
  exit 1
fi
exit 0
`,
    );
    const failRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", failRepo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env: failingBun.env },
    );
    expect(failRun.exitCode).toBe(1);
    expect(JSON.parse(failRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run quality:fallow:record-hits",
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "failed",
        },
        {
          command: "bun run check",
          ran: false,
          outcome: "skipped",
          reason: "bun run quality:fallow:record-hits failed",
        },
      ],
    });
    expect(readFileSync(failingBun.ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run quality:fallow:record-hits",
    ]);
  },
  processWatchdog(4),
);

test(
  "does not run the recorded-hits script when the repository already has the recorded-hits files, when the script is absent, or when --no-check is passed",
  async () => {
    const { templateClone: existingTemplate, baseCommit: existingBase } =
      cloneTemplateAtHead(folder);
    const existingRepo = await bootstrapGeneratedRepository(
      folder,
      existingTemplate,
      existingBase,
      "existing-recorded-hits-app",
    );
    const customDeadCodeRecord = '{"custom":"owner-record"}\n';
    commitIn(existingRepo, "owner recorded hit", {
      "fallow-dead-code-recorded-hits.json": customDeadCodeRecord,
    });
    const existingTarget = commitTemplateLintChange(existingTemplate);
    const existingBranch = `template-upgrade/${existingBase.slice(0, 7)}-${existingTarget.slice(0, 7)}`;
    const existingBun = writeScriptedBun(
      folder,
      "scripted-bun-existing-records-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  echo "record-hits must not overwrite existing repository records" >&2
  exit 1
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const existingRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", existingRepo, "--to", existingTarget, "--json"],
      { templateRoot: existingTemplate, env: existingBun.env },
    );
    expect(existingRun.exitCode).toBe(0);
    expect(JSON.parse(existingRun.stdout)).toMatchObject({
      status: "applied",
      branch: existingBranch,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "passed" },
        {
          command: "fallow audit",
          ran: false,
          outcome: "skipped",
          reason: "node_modules/.bin/fallow not found",
        },
      ],
    });
    expect(readFileSync(existingBun.ledger, "utf8").trim().split("\n")).toEqual(
      ["install", "run check"],
    );
    expect(
      `${git(existingRepo, "show", `${existingBranch}:fallow-dead-code-recorded-hits.json`)}\n`,
    ).toBe(customDeadCodeRecord);

    const newFilesFixture = createRecordedHitsUpgradeFixture(folder);
    const skippedRepo = await bootstrapGeneratedRepository(
      folder,
      newFilesFixture.templateClone,
      newFilesFixture.baseCommit,
      "no-check-record-hits-app",
    );
    const noCheckBun = writeScriptedBun(
      folder,
      "scripted-bun-no-check-record-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
exit 0
`,
    );
    const skippedJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        skippedRepo,
        "--to",
        newFilesFixture.targetCommit,
        "--no-check",
        "--json",
      ],
      { templateRoot: newFilesFixture.templateClone, env: noCheckBun.env },
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
          command: "bun run quality:fallow:record-hits",
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
    expect(existsSync(noCheckBun.ledger)).toBe(false);

    const skippedTextRepo = await bootstrapGeneratedRepository(
      folder,
      newFilesFixture.templateClone,
      newFilesFixture.baseCommit,
      "no-check-record-hits-text-app",
    );
    const skippedTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        skippedTextRepo,
        "--to",
        newFilesFixture.targetCommit,
        "--no-check",
      ],
      { templateRoot: newFilesFixture.templateClone, env: noCheckBun.env },
    );
    expect(skippedTextRun.exitCode).toBe(0);
    expect(skippedTextRun.stdout).toContain(
      "bun run quality:fallow:record-hits: skipped (--no-check)",
    );

    const withoutScriptFixture = createRecordedHitsUpgradeFixture(folder, {
      omitRecordScriptInTarget: true,
    });
    const withoutScriptRepo = await bootstrapGeneratedRepository(
      folder,
      withoutScriptFixture.templateClone,
      withoutScriptFixture.baseCommit,
      "missing-record-script-app",
    );
    const withoutScriptBun = writeScriptedBun(
      folder,
      "scripted-bun-missing-script-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
exit 0
`,
    );
    const withoutScriptRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        withoutScriptRepo,
        "--to",
        withoutScriptFixture.targetCommit,
        "--json",
      ],
      {
        templateRoot: withoutScriptFixture.templateClone,
        env: withoutScriptBun.env,
      },
    );
    expect(withoutScriptRun.exitCode).toBe(0);
    expect(JSON.parse(withoutScriptRun.stdout)).toMatchObject({
      status: "applied",
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "passed" },
        {
          command: "fallow audit",
          ran: false,
          outcome: "skipped",
          reason: "node_modules/.bin/fallow not found",
        },
      ],
    });
    expect(
      readFileSync(withoutScriptBun.ledger, "utf8").trim().split("\n"),
    ).toEqual(["install", "run check"]);
  },
  processWatchdog(4),
);

test(
  "does not rerun the recorded-hits script before bun run check on retry after check-failed, and records again only after the retried check passes",
  async () => {
    const { templateClone, baseCommit, targetCommit, branch } =
      createRecordedHitsUpgradeFixture(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "retry-recorded-hits-app",
    );
    const failFlag = join(folder("scripted-bun-retry-flag-"), "fail-check");
    writeFileSync(failFlag, "1\n");
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-retry-record-hits-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  if grep -q '"pass":1' fallow-dead-code-recorded-hits.json 2>/dev/null; then
    printf '{"pass":2,"file":"dead-code"}\\n' > fallow-dead-code-recorded-hits.json
  else
    printf '{"pass":1,"file":"dead-code"}\\n' > fallow-dead-code-recorded-hits.json
  fi
  exit 0
fi
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
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
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
    ).toBe('{"pass":1,"file":"dead-code"}\n');

    rmSync(failFlag);
    const retryRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(retryRun.exitCode).toBe(0);
    expect(JSON.parse(retryRun.stdout)).toMatchObject({
      status: "applied",
      branch,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
          reason: "recorded again after a repair that bun run check passed",
        },
        {
          command: "fallow audit",
          ran: false,
          outcome: "skipped",
          reason: "node_modules/.bin/fallow not found",
        },
      ],
    });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run quality:fallow:record-hits",
      "run check",
      "install",
      "run check",
      "run quality:fallow:record-hits",
    ]);
    expect(
      git(repo, "show", `${branch}:fallow-dead-code-recorded-hits.json`),
    ).toBe('{"pass":2,"file":"dead-code"}');
  },
  processWatchdog(4),
);

test(
  "runRecordedHitsStep records only while every worktree recorded-hits file matches the target template empty file",
  () => {
    const { templateClone, targetCommit } =
      createRecordedHitsUpgradeFixture(folder);
    const repo = folder("recorded-hits-step-repo-");
    initRepository(repo);
    const { sha: repositoryHead } = commitIn(repo, "initial without hits", {
      "package.json": '{"name":"unit-app"}\n',
    });
    const worktree = folder("recorded-hits-step-worktree-");
    git(
      repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      worktree,
      repositoryHead,
    );
    writeFileSync(
      join(worktree, "package.json"),
      readFileSync(
        join(templateClone, "generated-repository/settings/package.json"),
      ),
    );
    for (const file of RECORDED_HITS_FILES) {
      writeFileSync(
        join(worktree, file),
        readFileSync(
          join(templateClone, "generated-repository/settings", file),
        ),
      );
    }
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-step-retry-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "quality:fallow:record-hits" ]; then
  if grep -q '"pass":1' fallow-dead-code-recorded-hits.json 2>/dev/null; then
    printf '{"pass":2,"file":"dead-code"}\\n' > fallow-dead-code-recorded-hits.json
  else
    printf '{"pass":1,"file":"dead-code"}\\n' > fallow-dead-code-recorded-hits.json
  fi
  exit 0
fi
exit 0
`,
    );
    const inputs = {
      templateRoot: templateClone,
      targetCommit,
      repository: repo,
      repositoryHead,
    };
    const request = recordedHitsRequestFor(worktree, inputs, env);

    expect(
      noCheckTemplateUpgradeSteps(request, []).map((step) => step.command),
    ).toEqual([
      "bun install",
      "bun run quality:fallow:record-hits",
      "bun run check",
    ]);

    const first = runRecordedHitsStep(request, 10_000);
    expect(first).toEqual({
      ok: true,
      steps: [
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
        },
      ],
    });
    expect(
      readFileSync(
        join(worktree, "fallow-dead-code-recorded-hits.json"),
        "utf8",
      ),
    ).toBe('{"pass":1,"file":"dead-code"}\n');

    const retry = runRecordedHitsStep(request, 10_000);
    expect(retry).toEqual({ ok: true, steps: [] });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "run quality:fallow:record-hits",
    ]);
    expect(
      readFileSync(
        join(worktree, "fallow-dead-code-recorded-hits.json"),
        "utf8",
      ),
    ).toBe('{"pass":1,"file":"dead-code"}\n');
    expect(
      noCheckTemplateUpgradeSteps(request, []).map((step) => step.command),
    ).toEqual(["bun install", "bun run check"]);
  },
  processWatchdog(2),
);
