import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TemplateChangesetEntry } from "../../../src/template-upgrade-changesets.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

interface PlanWithChangesetsJson {
  readonly status: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly rows: readonly {
    readonly path: string;
    readonly ownerLabel: string;
    readonly outcome: string;
  }[];
  readonly changesets?: readonly TemplateChangesetEntry[];
  readonly sharedMerges?: readonly string[];
  readonly templateHeadNotice?: string;
}

interface ApplyWithChangesetsJson {
  readonly status: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly branch: string;
  readonly changesets?: readonly TemplateChangesetEntry[];
  readonly templateHeadNotice?: string;
}

function writeChangeset(
  templateClone: string,
  file: string,
  content: string,
): string {
  const relativePath = `.changeset/${file}`;
  mkdirSync(dirname(join(templateClone, relativePath)), { recursive: true });
  writeFileSync(join(templateClone, relativePath), content);
  return relativePath;
}

async function setupChangesetsUpgrade() {
  const { templateClone } = cloneTemplateAtHead(folder);
  const basePath = writeChangeset(
    templateClone,
    "2026-11-20-base-changeset.md",
    '---\n"bun-typescript-template": minor\n---\n\nAlready in base commit.\n',
  );
  git(templateClone, "add", "--", basePath);
  git(templateClone, "commit", "--quiet", "-m", "base changeset");
  const baseCommit = git(templateClone, "rev-parse", "HEAD");

  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "changesets-demo",
  );

  const minorPath = writeChangeset(
    templateClone,
    "2026-11-22-added-feature.md",
    '---\n"bun-typescript-template": minor\n---\n\nAdded upgrade summary output.\n\nAction: Review the summary after upgrading.\n',
  );
  const majorPath = writeChangeset(
    templateClone,
    "2026-11-23-breaking-change.md",
    '---\n"bun-typescript-template": major\n---\n\nChanged generated lint layout.\n\nAction: Update custom lint imports before running check.\n',
  );
  const rulesPath = join(templateClone, "config/template-rules.mjs");
  writeFileSync(rulesPath, `${readFileSync(rulesPath, "utf8")}\n`);
  git(
    templateClone,
    "add",
    "--",
    minorPath,
    majorPath,
    "config/template-rules.mjs",
  );
  git(templateClone, "commit", "--quiet", "-m", "target with changesets");
  const targetCommit = git(templateClone, "rev-parse", "HEAD");

  writeChangeset(
    templateClone,
    "2026-11-24-uncommitted.md",
    '---\n"bun-typescript-template": minor\n---\n\nUncommitted working tree changeset must not appear.\n',
  );

  return {
    templateClone,
    baseCommit,
    targetCommit,
    branch: `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`,
    repo,
  };
}

test(
  "plan and apply list added changesets major-first in JSON and text, ignoring working-tree changesets, and write them to the commit body",
  async () => {
    const setup = await setupChangesetsUpgrade();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "plan",
        "--repository",
        setup.repo,
        "--to",
        setup.targetCommit,
        "--json",
      ],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as PlanWithChangesetsJson;
    expect(planJson.changesets?.map((entry) => entry.file)).toEqual([
      "2026-11-23-breaking-change.md",
      "2026-11-22-added-feature.md",
    ]);
    expect(planJson.changesets?.[0]).toEqual({
      file: "2026-11-23-breaking-change.md",
      level: "major",
      summary:
        "Changed generated lint layout.\n\nAction: Update custom lint imports before running check.",
      action: "Update custom lint imports before running check.",
    });
    expect(planJson.changesets?.[1]).toEqual({
      file: "2026-11-22-added-feature.md",
      level: "minor",
      summary:
        "Added upgrade summary output.\n\nAction: Review the summary after upgrading.",
      action: "Review the summary after upgrading.",
    });

    const planTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", setup.repo, "--to", setup.targetCommit],
      runtime,
    );
    expect(planTextRun.exitCode).toBe(0);
    expect(planTextRun.stdout).toContain(
      `Target commit: ${setup.targetCommit}`,
    );
    const majorPos = planTextRun.stdout.indexOf(
      "Changed generated lint layout.",
    );
    const minorPos = planTextRun.stdout.indexOf(
      "Added upgrade summary output.",
    );
    expect(majorPos).toBeGreaterThan(-1);
    expect(minorPos).toBeGreaterThan(majorPos);
    expect(planTextRun.stdout).toContain(
      "Action: Update custom lint imports before running check.",
    );
    expect(planTextRun.stdout).toContain(
      "Action: Review the summary after upgrading.",
    );
    expect(planTextRun.stdout).not.toContain("Already in base commit.");
    expect(planTextRun.stdout).not.toContain(
      "Uncommitted working tree changeset must not appear.",
    );

    const applyJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      runtime,
    );
    expect(applyJsonRun.exitCode).toBe(0);
    const applyJson = JSON.parse(
      applyJsonRun.stdout,
    ) as ApplyWithChangesetsJson;
    expect(applyJson.changesets?.map((entry) => entry.file)).toEqual([
      "2026-11-23-breaking-change.md",
      "2026-11-22-added-feature.md",
    ]);

    const commitBody = gitOutput(
      setup.repo,
      "log",
      "-1",
      "--format=%b",
      setup.branch,
    );
    const bodyMajorPos = commitBody.indexOf("Changed generated lint layout.");
    const bodyMinorPos = commitBody.indexOf("Added upgrade summary output.");
    expect(bodyMajorPos).toBeGreaterThan(-1);
    expect(bodyMinorPos).toBeGreaterThan(bodyMajorPos);
    expect(commitBody).toContain(
      "Action: Update custom lint imports before running check.",
    );
    expect(commitBody).toContain("Action: Review the summary after upgrading.");
    expect(commitBody).not.toContain("Already in base commit.");

    const secondRepo = await bootstrapGeneratedRepository(
      folder,
      setup.templateClone,
      setup.baseCommit,
      "changesets-text-demo",
    );
    const applyTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        secondRepo,
        "--to",
        setup.targetCommit,
        "--no-check",
      ],
      runtime,
    );
    expect(applyTextRun.exitCode).toBe(0);
    expect(applyTextRun.stdout).toContain(
      `Target commit: ${setup.targetCommit}`,
    );
    const applyMajorPos = applyTextRun.stdout.indexOf(
      "Changed generated lint layout.",
    );
    const applyMinorPos = applyTextRun.stdout.indexOf(
      "Added upgrade summary output.",
    );
    expect(applyMajorPos).toBeGreaterThan(-1);
    expect(applyMinorPos).toBeGreaterThan(applyMajorPos);
    expect(applyTextRun.stdout).toContain(
      "Action: Update custom lint imports before running check.",
    );
  },
  processWatchdog(4),
);

test(
  "AGENTS.md and .changeset/config.json take when untouched, merge when repository edited them, and plan names edited shared files in sharedMerges",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const configPath = join(
      templateClone,
      "generated-repository/changeset/config.json",
    );
    const config = JSON.parse(readFileSync(configPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      configPath,
      `${JSON.stringify({ ...config, ignore: ["example-ignored"] }, null, 2)}\n`,
    );
    git(
      templateClone,
      "add",
      "--",
      "generated-repository/changeset/config.json",
    );
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const untouchedRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "shared-untouched",
    );
    const editedRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "shared-edited",
    );
    const addedSection =
      "\n## Repository rules\n\nKeep custom gateway routes in src/routes.ts.\n";
    const repoConfig = JSON.parse(
      readFileSync(join(editedRepo, ".changeset/config.json"), "utf8"),
    ) as Record<string, unknown>;
    commitIn(editedRepo, "edit AGENTS.md and .changeset/config.json", {
      "AGENTS.md": `${readFileSync(join(editedRepo, "AGENTS.md"), "utf8")}${addedSection}`,
      ".changeset/config.json": `${JSON.stringify({ ...repoConfig, linked: [["a", "b"]] }, null, 2)}\n`,
    });

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const untouchedPlan = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", untouchedRepo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(untouchedPlan.exitCode).toBe(0);
    const untouchedJson = JSON.parse(
      untouchedPlan.stdout,
    ) as PlanWithChangesetsJson;
    expect(untouchedJson.rows.find((row) => row.path === "AGENTS.md")).toEqual({
      path: "AGENTS.md",
      ownerLabel: "shared",
      outcome: "take",
    });
    expect(
      untouchedJson.rows.find((row) => row.path === ".changeset/config.json"),
    ).toEqual({
      path: ".changeset/config.json",
      ownerLabel: "shared",
      outcome: "take",
    });
    expect(untouchedJson.sharedMerges).toEqual([]);

    const editedPlanJson = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", editedRepo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(editedPlanJson.exitCode).toBe(0);
    const editedJson = JSON.parse(
      editedPlanJson.stdout,
    ) as PlanWithChangesetsJson;
    expect(editedJson.rows.find((row) => row.path === "AGENTS.md")).toEqual({
      path: "AGENTS.md",
      ownerLabel: "shared",
      outcome: "merge",
    });
    expect(
      editedJson.rows.find((row) => row.path === ".changeset/config.json"),
    ).toEqual({
      path: ".changeset/config.json",
      ownerLabel: "shared",
      outcome: "merge",
    });
    expect(editedJson.sharedMerges).toEqual([
      ".changeset/config.json",
      "AGENTS.md",
    ]);

    const editedPlanText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", editedRepo, "--to", targetCommit],
      runtime,
    );
    expect(editedPlanText.exitCode).toBe(0);
    expect(editedPlanText.stdout).toContain(
      "Shared files edited by this repository (will be merged):",
    );
    expect(editedPlanText.stdout).toContain("  .changeset/config.json");
    expect(editedPlanText.stdout).toContain("  AGENTS.md");

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(editedRepo, targetCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(0);
    const mergedAgents = gitOutput(editedRepo, "show", `${branch}:AGENTS.md`);
    expect(mergedAgents).toContain(`Template source: ${targetCommit}`);
    expect(mergedAgents).toContain("## Repository rules");
    const mergedConfig = JSON.parse(
      gitOutput(editedRepo, "show", `${branch}:.changeset/config.json`),
    ) as Record<string, unknown>;
    expect(mergedConfig).toMatchObject({
      ignore: ["example-ignored"],
      linked: [["a", "b"]],
    });
  },
  processWatchdog(4),
);

test(
  "defaults --to HEAD, always prints target commit, and warns when template HEAD is behind origin/main",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "behind-head-demo",
    );
    const headTarget = commitTemplateUpgradeChanges(templateClone);
    git(templateClone, "checkout", "--quiet", "-b", "origin-advance");
    const aheadOne = commitIn(templateClone, "origin ahead 1", {
      "docs/ahead-one.md": "1\n",
    }).sha;
    const aheadTwo = commitIn(templateClone, "origin ahead 2", {
      "docs/ahead-two.md": "2\n",
    }).sha;
    git(templateClone, "update-ref", "refs/remotes/origin/main", aheadTwo);
    git(templateClone, "checkout", "--quiet", "--detach", headTarget);
    expect(aheadOne).not.toBe(aheadTwo);

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo],
      runtime,
    );
    expect(planText.exitCode).toBe(0);
    expect(planText.stdout).toContain(`Target commit: ${headTarget}`);
    expect(planText.stdout).toContain("2 commits behind origin/main");
    expect(planText.stdout).toContain("git pull");
    expect(planText.stdout).toContain("--to origin/main");

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--json"],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as PlanWithChangesetsJson;
    expect(planJson.targetCommit).toBe(headTarget);
    expect(planJson.templateHeadNotice).toContain(
      "2 commits behind origin/main",
    );

    const planOriginMain = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", "origin/main", "--json"],
      runtime,
    );
    expect(planOriginMain.exitCode).toBe(0);
    const originMainJson = JSON.parse(
      planOriginMain.stdout,
    ) as PlanWithChangesetsJson;
    expect(originMainJson.targetCommit).toBe(aheadTwo);
    expect(originMainJson.templateHeadNotice).toBeUndefined();

    const applyText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--no-check"],
      runtime,
    );
    expect(applyText.exitCode).toBe(0);
    expect(applyText.stdout).toContain(`Target commit: ${headTarget}`);
    expect(applyText.stdout).toContain("2 commits behind origin/main");
  },
  processWatchdog(4),
);

test(
  "upgrade fills __PACKAGE_NAME__ from package.json in .changeset/README.md while keeping __REPOSITORY_NAME__ elsewhere",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const changesetReadmePath = join(
      templateClone,
      "generated-repository/changeset/README.md",
    );
    const currentReadme = readFileSync(changesetReadmePath, "utf8");
    const preFixReadme = currentReadme.replaceAll(
      "__PACKAGE_NAME__",
      "__REPOSITORY_NAME__",
    );
    writeFileSync(changesetReadmePath, preFixReadme);
    git(templateClone, "add", "--", "generated-repository/changeset/README.md");
    git(
      templateClone,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base before package name token",
    );
    const baseCommit = git(templateClone, "rev-parse", "HEAD");

    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "skills-private",
    );
    const packageJson = JSON.parse(
      readFileSync(join(repo, "package.json"), "utf8"),
    ) as Record<string, unknown>;
    commitIn(repo, "rename package in package.json", {
      "package.json": `${JSON.stringify({ ...packageJson, name: "nathanvale-skills-private" }, null, 2)}\n`,
    });

    writeFileSync(changesetReadmePath, currentReadme);
    git(templateClone, "add", "--", "generated-repository/changeset/README.md");
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(0);

    const upgradedReadme = gitOutput(
      repo,
      "show",
      `${branch}:.changeset/README.md`,
    );
    expect(upgradedReadme).toContain(
      'bun run --bun changeset add --minor nathanvale-skills-private -m "<past-tense summary>"',
    );
    expect(upgradedReadme).toContain("--package nathanvale-skills-private");
    expect(upgradedReadme).not.toContain("__PACKAGE_NAME__");
    expect(upgradedReadme).not.toContain("__REPOSITORY_NAME__");
    expect(upgradedReadme).not.toContain("--minor skills-private");
    expect(upgradedReadme).not.toContain("--patch skills-private");
    expect(upgradedReadme).not.toContain("--package skills-private");

    expect(gitOutput(repo, "show", `${branch}:src/cli.ts`)).toContain(
      'cli: "skills-private",',
    );
    expect(gitOutput(repo, "show", `${branch}:README.md`)).toContain(
      "# `skills-private`",
    );
    expect(
      JSON.parse(gitOutput(repo, "show", `${branch}:package.json`)) as Record<
        string,
        unknown
      >,
    ).toMatchObject({ name: "nathanvale-skills-private" });
    expect(
      JSON.parse(gitOutput(repo, "show", `${branch}:.template.json`)) as Record<
        string,
        unknown
      >,
    ).toMatchObject({ name: "skills-private" });
  },
  processWatchdog(4),
);
