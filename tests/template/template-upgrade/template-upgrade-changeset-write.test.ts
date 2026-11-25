import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

function branchChangesetFiles(repo: string, branch: string): string[] {
  return gitOutput(repo, "ls-tree", "-r", "--name-only", branch, ".changeset")
    .split("\n")
    .filter(
      (path) =>
        path.startsWith(".changeset/") &&
        path.endsWith(".md") &&
        path !== ".changeset/README.md",
    );
}

test(
  "writes a patch changeset on covered upgrade changes so check:changesets passes",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const base7 = baseCommit.slice(0, 7);
    const target7 = targetCommit.slice(0, 7);
    const branch = `template-upgrade/${base7}-${target7}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "changeset-covered-app",
    );
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");

    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      { templateRoot: templateClone, env },
    );
    expect(applyRun.stderr).toBe("");
    expect(applyRun.exitCode).toBe(0);
    expect(JSON.parse(applyRun.stdout)).toMatchObject({
      status: "applied",
      branch,
    });

    const expectedPath = `.changeset/template-upgrade-${target7}.md`;
    expect(branchChangesetFiles(repo, branch)).toEqual([expectedPath]);
    const content = gitOutput(repo, "show", `${branch}:${expectedPath}`);
    expect(content).toContain('"changeset-covered-app": patch');
    expect(content).toContain(`Upgraded template ${base7} to ${target7}`);

    git(repo, "checkout", "--quiet", branch);
    const checkRun = await spawnBounded(
      [process.execPath, "run", "check:changesets"],
      { cwd: repo, env, processGroup: true },
    );
    expect(checkRun.exit).toBe(0);
  },
  processWatchdog(4),
);

test(
  "writes no changeset when an upgrade changes only uncovered paths",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateLintChange(templateClone);
    const base7 = baseCommit.slice(0, 7);
    const target7 = targetCommit.slice(0, 7);
    const branch = `template-upgrade/${base7}-${target7}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "changeset-uncovered-app",
    );

    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      { templateRoot: templateClone, env },
    );
    expect(applyRun.exitCode).toBe(0);
    expect(JSON.parse(applyRun.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(branchChangesetFiles(repo, branch)).toEqual([]);
  },
  processWatchdog(4),
);

test(
  "leaves exactly one changeset when upgrade apply is rerun on the same target",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const base7 = baseCommit.slice(0, 7);
    const target7 = targetCommit.slice(0, 7);
    const branch = `template-upgrade/${base7}-${target7}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "changeset-rerun-app",
    );

    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(repo, targetCommit);

    const firstRun = await invokeTemplateUpgradeMain(stdout, stderr, args, {
      templateRoot: templateClone,
      env,
    });
    expect(firstRun.exitCode).toBe(0);
    expect(JSON.parse(firstRun.stdout)).toMatchObject({
      status: "applied",
      branch,
    });

    const secondRun = await invokeTemplateUpgradeMain(stdout, stderr, args, {
      templateRoot: templateClone,
      env,
    });
    expect(secondRun.exitCode).toBe(0);
    expect(JSON.parse(secondRun.stdout)).toMatchObject({
      status: "already-done",
      branch,
    });
    expect(branchChangesetFiles(repo, branch)).toEqual([
      `.changeset/template-upgrade-${target7}.md`,
    ]);
  },
  processWatchdog(4),
);

test(
  "keeps an existing changeset added since base and writes no second one",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const base7 = baseCommit.slice(0, 7);
    const target7 = targetCommit.slice(0, 7);
    const branch = `template-upgrade/${base7}-${target7}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "changeset-existing-app",
    );
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "--quiet", "-b", "feat/existing-changeset");
    commitIn(repo, "add existing changeset", {
      ".changeset/existing-work.md":
        '---\n"changeset-existing-app": minor\n---\n\nExisting branch change.\n',
    });

    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      { templateRoot: templateClone, env },
    );
    expect(applyRun.exitCode).toBe(0);
    expect(JSON.parse(applyRun.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(branchChangesetFiles(repo, branch)).toEqual([
      ".changeset/existing-work.md",
    ]);
  },
  processWatchdog(4),
);

test(
  "upgrade plan prints the Changeset line when apply would write one and omits it otherwise",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const coveredTarget = commitTemplateUpgradeChanges(templateClone);
    const base7 = baseCommit.slice(0, 7);
    const covered7 = coveredTarget.slice(0, 7);

    const coveredRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "plan-covered-app",
    );
    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const coveredPlan = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", coveredRepo, "--to", coveredTarget],
      { templateRoot: templateClone, env },
    );
    expect(coveredPlan.exitCode).toBe(0);
    expect(coveredPlan.stdout).toContain(
      `Changeset: .changeset/template-upgrade-${covered7}.md (patch, Upgraded template ${base7} to ${covered7})`,
    );

    const uncoveredTemplate = cloneTemplateAtHead(folder);
    const uncoveredTarget = commitTemplateLintChange(
      uncoveredTemplate.templateClone,
    );
    const uncoveredRepo = await bootstrapGeneratedRepository(
      folder,
      uncoveredTemplate.templateClone,
      uncoveredTemplate.baseCommit,
      "plan-uncovered-app",
    );
    const uncoveredPlan = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", uncoveredRepo, "--to", uncoveredTarget],
      { templateRoot: uncoveredTemplate.templateClone, env },
    );
    expect(uncoveredPlan.exitCode).toBe(0);
    expect(uncoveredPlan.stdout).not.toContain("Changeset:");

    git(coveredRepo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(coveredRepo, "checkout", "--quiet", "-b", "feat/already-has-changeset");
    commitIn(coveredRepo, "add branch changeset", {
      ".changeset/branch-note.md":
        '---\n"plan-covered-app": minor\n---\n\nAlready documented.\n',
    });
    const existingPlan = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", coveredRepo, "--to", coveredTarget],
      { templateRoot: templateClone, env },
    );
    expect(existingPlan.exitCode).toBe(0);
    expect(existingPlan.stdout).not.toContain("Changeset:");
  },
  processWatchdog(4),
);

async function runScriptedChangesetApply(options: {
  readonly templateClone: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly name: string;
  readonly prefix: string;
  readonly script: string;
  readonly stdout: () => string;
  readonly stderr: () => string;
}) {
  const repo = await bootstrapGeneratedRepository(
    folder,
    options.templateClone,
    options.baseCommit,
    options.name,
  );
  const bun = writeScriptedBun(folder, options.prefix, options.script);
  return await invokeTemplateUpgradeMain(
    options.stdout,
    options.stderr,
    applyNoCheckJsonArgs(repo, options.targetCommit),
    { templateRoot: options.templateClone, env: bun.env },
  );
}

test(
  "refuses with a repair line when changeset add fails or creates an unexpected number of files",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const failingRun = await runScriptedChangesetApply({
      templateClone,
      baseCommit,
      targetCommit,
      name: "changeset-fail-app",
      prefix: "changeset-fail-bun-",
      script:
        '#!/bin/sh\necho "$*" >> __LEDGER__\necho "changeset CLI failed" >&2\nexit 1\n',
      stdout,
      stderr,
    });
    expect(failingRun.exitCode).not.toBe(0);
    expect(failingRun.stderr).toContain("changeset");
    expect(failingRun.stderr).toContain("repair");

    const zeroRun = await runScriptedChangesetApply({
      templateClone,
      baseCommit,
      targetCommit,
      name: "changeset-zero-app",
      prefix: "changeset-zero-bun-",
      script: '#!/bin/sh\necho "$*" >> __LEDGER__\nexit 0\n',
      stdout,
      stderr,
    });
    expect(zeroRun.exitCode).not.toBe(0);
    expect(zeroRun.stderr).toContain("0");
    expect(zeroRun.stderr).toContain("repair");

    const twoRun = await runScriptedChangesetApply({
      templateClone,
      baseCommit,
      targetCommit,
      name: "changeset-two-app",
      prefix: "changeset-two-bun-",
      script:
        '#!/bin/sh\necho "$*" >> __LEDGER__\nprintf -- \'---\\n"changeset-two-app": patch\\n---\\n\\nOne\\n\' > .changeset/one-file.md\nprintf -- \'---\\n"changeset-two-app": patch\\n---\\n\\nTwo\\n\' > .changeset/two-file.md\nexit 0\n',
      stdout,
      stderr,
    });
    expect(twoRun.exitCode).not.toBe(0);
    expect(twoRun.stderr).toContain("2");
    expect(twoRun.stderr).toContain("repair");
  },
  processWatchdog(4),
);

test(
  "matches custom changedFilePatterns from .changeset/config.json",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateLintChange(templateClone);
    const base7 = baseCommit.slice(0, 7);
    const target7 = targetCommit.slice(0, 7);
    const branch = `template-upgrade/${base7}-${target7}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "changeset-pattern-app",
    );
    const configPath = join(repo, ".changeset/config.json");
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, changedFilePatterns: ["src/**", "package.json", "config/**"] }, null, 2)}\n`,
    );
    git(repo, "add", "--", ".changeset/config.json");
    git(
      repo,
      "commit",
      "--quiet",
      "-m",
      "add config/** to changedFilePatterns",
    );

    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit],
      { templateRoot: templateClone, env },
    );
    expect(planRun.exitCode).toBe(0);
    expect(planRun.stdout).toContain(
      `Changeset: .changeset/template-upgrade-${target7}.md (patch, Upgraded template ${base7} to ${target7})`,
    );

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      { templateRoot: templateClone, env },
    );
    expect(applyRun.exitCode).toBe(0);
    expect(branchChangesetFiles(repo, branch)).toEqual([
      `.changeset/template-upgrade-${target7}.md`,
    ]);
  },
  processWatchdog(4),
);
