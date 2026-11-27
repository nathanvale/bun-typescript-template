import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import { TEMPLATE_UPGRADE_FLOOR } from "../../../src/template-upgrade-git.ts";
import { resolveTemplateUpgradeInputs } from "../../../src/template-upgrade-inputs.ts";
import { main } from "../../../src/template-upgrade.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  initRepository,
} from "../../support/git-fixture.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
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
if [ "$1" = "run" ] && [ "$2" = "--bun" ] && [ "$3" = "changeset" ]; then
  exec ${JSON.stringify(process.execPath)} "$@"
fi
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
        {
          command: "fallow audit",
          ran: false,
          outcome: "skipped",
          reason: "node_modules/.bin/fallow not found",
        },
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

test(
  "applies templateUpgrade.checkTimeoutSeconds to bun run check, names the key on timeout, and succeeds when raised",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateLintChange(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "check-timeout-app",
    );
    const setCheckTimeout = (seconds: number) => {
      const packagePath = join(repo, "package.json");
      const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as Record<
        string,
        unknown
      >;
      manifest.templateUpgrade = { checkTimeoutSeconds: seconds };
      writeFileSync(packagePath, `${JSON.stringify(manifest, null, 2)}\n`);
      git(repo, "add", "--", "package.json");
      git(repo, "commit", "--quiet", "-m", `set check limit to ${seconds}s`);
    };
    setCheckTimeout(1);

    const { env } = writeScriptedBun(
      folder,
      "scripted-bun-timeout-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  sleep 2
  exit 0
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const runtime = { templateRoot: templateClone, env };

    const timeoutJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(timeoutJsonRun.exitCode).toBe(1);
    const timeoutPayload = JSON.parse(timeoutJsonRun.stdout) as {
      status: string;
      failedStep: string;
      checkCommandOutput: string;
    };
    expect(timeoutPayload.status).toBe("check-failed");
    expect(timeoutPayload.failedStep).toBe("bun run check");
    expect(timeoutPayload.checkCommandOutput).toContain(
      "did not finish within 1 second",
    );
    expect(timeoutPayload.checkCommandOutput).toContain(
      "templateUpgrade.checkTimeoutSeconds",
    );
    expect(timeoutPayload.checkCommandOutput).toContain("package.json");

    const timeoutTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit],
      runtime,
    );
    expect(timeoutTextRun.exitCode).toBe(1);
    expect(timeoutTextRun.stdout).toContain("did not finish within 1 second");
    expect(timeoutTextRun.stdout).toContain(
      "templateUpgrade.checkTimeoutSeconds",
    );
    expect(timeoutTextRun.stdout).toContain("package.json");
    expect(timeoutTextRun.stdout).toContain("upgrade recover");

    const recoverRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["recover", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(recoverRun.exitCode).toBe(0);

    setCheckTimeout(5);
    const passRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(passRun.exitCode).toBe(0);
    expect(JSON.parse(passRun.stdout)).toMatchObject({
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
  },
  processWatchdog(4),
);

function captureCliError(run: () => unknown): CliError {
  try {
    run();
  } catch (error) {
    if (error instanceof CliError) {
      return error;
    }
    throw error;
  }
  throw new Error("Expected a CliError refusal.");
}

test("defaults templateUpgrade.checkTimeoutSeconds to 900 seconds when absent and reads a positive integer", () => {
  const targetCommit = git(ROOT, "rev-parse", "HEAD");
  const baseStamp = {
    name: "demo",
    templateRevision: TEMPLATE_UPGRADE_FLOOR,
    templateDirty: false,
    sourcePacket: "/abs/packet",
  };
  const baseManifest = {
    name: "demo",
    dependencies: {
      "agent-cli-kernel": `github:nathanvale/agent-cli-kernel#${trialBase}`,
    },
  };
  const readResolvedLimit = (manifest: Record<string, unknown>) => {
    const repository = folder("check-limit-default-");
    initRepository(repository);
    commitIn(repository, "initial", {
      ".template.json": `${JSON.stringify(baseStamp, null, 2)}\n`,
      "package.json": `${JSON.stringify(manifest, null, 2)}\n`,
    });
    const inputs = resolveTemplateUpgradeInputs({
      templateRoot: ROOT,
      repository,
      targetRef: targetCommit,
      env: gitEnv,
    });
    return new Map<string, unknown>(Object.entries(inputs)).get(
      "checkLimitSeconds",
    );
  };

  expect(readResolvedLimit(baseManifest)).toBe(900);
  expect(readResolvedLimit({ ...baseManifest, templateUpgrade: {} })).toBe(900);
  expect(
    readResolvedLimit({
      ...baseManifest,
      templateUpgrade: { checkTimeoutSeconds: 1 },
    }),
  ).toBe(1);
  expect(
    readResolvedLimit({
      ...baseManifest,
      templateUpgrade: { checkTimeoutSeconds: 2_147_483 },
    }),
  ).toBe(2_147_483);
});

test("refuses non-positive-integer templateUpgrade.checkTimeoutSeconds before any work", async () => {
  const targetCommit = git(ROOT, "rev-parse", "HEAD");
  const baseStamp = {
    name: "demo",
    templateRevision: TEMPLATE_UPGRADE_FLOOR,
    templateDirty: false,
    sourcePacket: "/abs/packet",
  };
  const kernelPin = `github:nathanvale/agent-cli-kernel#${trialBase}`;
  for (const invalidValue of [0, -1, "60", 1.5, null, true, 2_147_484]) {
    const repository = folder("check-limit-invalid-");
    initRepository(repository);
    commitIn(repository, "initial", {
      ".template.json": `${JSON.stringify(baseStamp, null, 2)}\n`,
      "package.json": `${JSON.stringify(
        {
          name: "demo",
          dependencies: { "agent-cli-kernel": kernelPin },
          templateUpgrade: { checkTimeoutSeconds: invalidValue },
        },
        null,
        2,
      )}\n`,
    });
    const refusal = captureCliError(() =>
      resolveTemplateUpgradeInputs({
        templateRoot: ROOT,
        repository,
        targetRef: targetCommit,
        env: gitEnv,
      }),
    );
    expect(refusal.code).toBe("check_limit_invalid");
    expect(refusal.message).toContain("templateUpgrade.checkTimeoutSeconds");
    expect(refusal.message).toContain(JSON.stringify(invalidValue));
    expect(refusal.repair).toContain("templateUpgrade.checkTimeoutSeconds");
  }

  for (const invalidSection of ["60", null, []]) {
    const repository = folder("check-limit-section-invalid-");
    initRepository(repository);
    commitIn(repository, "initial", {
      ".template.json": `${JSON.stringify(baseStamp, null, 2)}\n`,
      "package.json": `${JSON.stringify(
        {
          name: "demo",
          dependencies: { "agent-cli-kernel": kernelPin },
          templateUpgrade: invalidSection,
        },
        null,
        2,
      )}\n`,
    });
    const refusal = captureCliError(() =>
      resolveTemplateUpgradeInputs({
        templateRoot: ROOT,
        repository,
        targetRef: targetCommit,
        env: gitEnv,
      }),
    );
    expect(refusal.code).toBe("check_limit_invalid");
    expect(refusal.message).toContain("templateUpgrade.checkTimeoutSeconds");
    expect(refusal.message).toContain(JSON.stringify(invalidSection));
    expect(refusal.repair).toContain("templateUpgrade.checkTimeoutSeconds");
  }

  const beforeWorkRepo = folder("check-limit-before-work-");
  initRepository(beforeWorkRepo);
  commitIn(beforeWorkRepo, "initial", {
    ".template.json": `${JSON.stringify(baseStamp, null, 2)}\n`,
    "package.json": `${JSON.stringify(
      {
        name: "demo",
        dependencies: { "agent-cli-kernel": kernelPin },
        templateUpgrade: { checkTimeoutSeconds: 0 },
      },
      null,
      2,
    )}\n`,
  });
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const exitCode = await main(
    ["apply", "--repository", beforeWorkRepo, "--to", targetCommit, "--json"],
    { templateRoot: ROOT, env: gitEnv },
  );
  expect(exitCode).toBe(2);
  expect(stdout()).toBe("");
  expect(JSON.parse(stderr())).toMatchObject({
    status: "refused",
    error: { code: "check_limit_invalid" },
  });
  expect(existsSync(join(beforeWorkRepo, ".worktrees"))).toBe(false);
});
