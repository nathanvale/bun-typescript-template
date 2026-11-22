import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  worktrees,
} from "../../support/git-fixture.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

interface PlanJson {
  status: string;
  conflicts: string[];
  rows: { path: string; ownerLabel: string; outcome: string }[];
  dependencyChanges: {
    section: string;
    packageName: string;
    before: string | null;
    after: string | null;
  }[];
  templateCopyChanges: { path: string; diff: string }[];
}

function templateUpgradeEnv() {
  return {
    ...process.env,
    ...gitEnv,
    KERNEL_REPOSITORY: siblingKernel(),
  };
}

async function makeOwnerEditedRepository() {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateUpgradeChanges(templateClone);
  const base7 = baseCommit.slice(0, 7);
  const target7 = targetCommit.slice(0, 7);
  const branch = `template-upgrade/${base7}-${target7}`;
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "demo-app",
  );
  const currentPackage = JSON.parse(
    readFileSync(join(repo, "package.json"), "utf8"),
  ) as Record<string, unknown>;
  const withBin: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(currentPackage)) {
    withBin[key] = value;
    if (key === "version") {
      withBin.bin = { "demo-app": "./src/cli.ts" };
    }
  }
  const addOnLines = readFileSync(
    join(repo, "tests/add-on-start-up.test.ts"),
    "utf8",
  ).split("\n");
  const describeIndex = addOnLines.findIndex((line) =>
    line.includes("describe("),
  );
  const editIndex = describeIndex >= 0 ? describeIndex : 0;
  addOnLines[editIndex] = (addOnLines[editIndex] ?? "").replace(
    '"',
    '"owner-edited ',
  );
  commitIn(repo, "owner edits", {
    "package.json": `${JSON.stringify(withBin, null, 2)}\n`,
    "tests/add-on-start-up.test.ts": addOnLines.join("\n"),
    "src/owner-domain.ts": "export const domain = 'demo-app';\n",
  });
  return {
    templateClone,
    baseCommit,
    targetCommit,
    base7,
    target7,
    branch,
    repo,
    resolvedAddOnContent: addOnLines.join("\n"),
  };
}

function assertPlanRows(planJson: PlanJson): void {
  const rowByPath = new Map(planJson.rows.map((row) => [row.path, row]));
  expect(rowByPath.get("package.json")).toEqual({
    path: "package.json",
    ownerLabel: "shared",
    outcome: "merge",
  });
  expect(rowByPath.get("bunfig.toml")).toEqual({
    path: "bunfig.toml",
    ownerLabel: "shared",
    outcome: "untouched",
  });
  expect(rowByPath.get("README.md")).toEqual({
    path: "README.md",
    ownerLabel: "repository",
    outcome: "untouched",
  });
  expect(rowByPath.get("config/platform-rules.mjs")).toEqual({
    path: "config/platform-rules.mjs",
    ownerLabel: "template",
    outcome: "delete",
  });
  expect(rowByPath.get("config/host-platform-rules.mjs")).toEqual({
    path: "config/host-platform-rules.mjs",
    ownerLabel: "template",
    outcome: "take",
  });
  expect(rowByPath.get("eslint.config.mjs")).toEqual({
    path: "eslint.config.mjs",
    ownerLabel: "template",
    outcome: "take",
  });
  expect(rowByPath.get("tests/pointer-skills.test.ts")).toEqual({
    path: "tests/pointer-skills.test.ts",
    ownerLabel: "template",
    outcome: "delete",
  });
  expect(rowByPath.get("tests/add-on-start-up.test.ts")).toEqual({
    path: "tests/add-on-start-up.test.ts",
    ownerLabel: "template",
    outcome: "conflict",
  });
  expect(rowByPath.get(".cli-design-template.json")).toEqual({
    path: ".cli-design-template.json",
    ownerLabel: "generated",
    outcome: "take",
  });
  expect(rowByPath.has("src/owner-domain.ts")).toBe(false);
}

function assertUpgradedBranchContents(
  repo: string,
  branch: string,
  targetCommit: string,
): void {
  const upgradedPackage = JSON.parse(
    git(repo, "show", `${branch}:package.json`),
  ) as Record<string, unknown>;
  expect(upgradedPackage.bin).toEqual({ "demo-app": "./src/cli.ts" });
  expect(upgradedPackage.engines).toEqual({ bun: ">=1.4.4" });
  expect(
    (upgradedPackage.devDependencies as Record<string, string>)[
      "@biomejs/biome"
    ],
  ).toBe("2.6.8");
  expect(
    JSON.parse(git(repo, "show", `${branch}:.cli-design-template.json`)),
  ).toMatchObject({ templateRevision: targetCommit });
  expect(git(repo, "show", `${branch}:eslint.config.mjs`)).toContain(
    "./config/host-platform-rules.mjs",
  );
  expect(git(repo, "show", `${branch}:src/owner-domain.ts`)).toContain(
    "demo-app",
  );
  const treeFiles = git(repo, "ls-tree", "-r", "--name-only", branch).split(
    "\n",
  );
  expect(treeFiles).toContain("config/host-platform-rules.mjs");
  expect(treeFiles).not.toContain("config/platform-rules.mjs");
  expect(treeFiles).not.toContain("tests/pointer-skills.test.ts");
}

async function setupStartingCopyUpdate() {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "starter-app",
  );
  const originalReadme = readFileSync(join(repo, "README.md"), "utf8");
  const customCli = `${readFileSync(join(repo, "src/cli.ts"), "utf8")}\nexport const ownerCli = true;\n`;
  commitIn(repo, "owner edits cli", { "src/cli.ts": customCli });
  const templateReadmePath = join(
    templateClone,
    "generated-repository/settings/README.md",
  );
  const templateCliPath = join(
    templateClone,
    "generated-repository/application/src/cli.ts",
  );
  writeFileSync(
    templateReadmePath,
    `${readFileSync(templateReadmePath, "utf8")}\n## New template section\n`,
  );
  writeFileSync(
    templateCliPath,
    `${readFileSync(templateCliPath, "utf8")}\nexport const templateUpdatedCli = true;\n`,
  );
  git(
    templateClone,
    "add",
    "--",
    "generated-repository/settings/README.md",
    "generated-repository/application/src/cli.ts",
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "update starting copies in template",
  );
  const targetCommit = git(templateClone, "rev-parse", "HEAD");
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
  return {
    templateClone,
    repo,
    targetCommit,
    branch,
    originalReadme,
    customCli,
  };
}

test(
  "template upgrade plan reports rows, dependency changes, and conflicts without writing to the repository",
  async () => {
    const { templateClone, targetCommit, base7, target7, repo } =
      await makeOwnerEditedRepository();
    const env = templateUpgradeEnv();
    const headBefore = git(repo, "rev-parse", "HEAD");
    const branchesBefore = git(repo, "branch", "--list");
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(planRun.exitCode).toBe(0);
    expect(planRun.stderr).toBe("");
    const planJson = JSON.parse(planRun.stdout) as PlanJson;
    expect(planJson.status).toBe("conflicts");
    expect(planJson.conflicts).toEqual(["tests/add-on-start-up.test.ts"]);
    assertPlanRows(planJson);
    expect(planJson.templateCopyChanges).toEqual([]);
    expect(planJson.dependencyChanges).toEqual([
      {
        section: "devDependencies",
        packageName: "@biomejs/biome",
        before: "2.6.7",
        after: "2.6.8",
      },
    ]);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "branch", "--list")).toBe(branchesBefore);
    expect(existsSync(join(repo, ".worktrees"))).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);

    const planTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit],
      { templateRoot: templateClone, env },
    );
    expect(planTextRun.exitCode).toBe(0);
    expect(planTextRun.stdout).toContain(
      `Template upgrade plan: ${base7} -> ${target7}`,
    );
    expect(planTextRun.stdout).toContain("devDependencies.@biomejs/biome");
  },
  processWatchdog(4),
);

function applyNoCheckJsonArgs(repo: string, targetCommit: string): string[] {
  return [
    "apply",
    "--repository",
    repo,
    "--to",
    targetCommit,
    "--no-check",
    "--json",
  ];
}

function seedLeftoverWorktree(
  targetRepo: string,
  sourceRepo: string,
  branch: string,
  target7: string,
): string {
  const leftover = join(
    targetRepo,
    ".worktrees",
    `template-upgrade-${target7}`,
  );
  git(targetRepo, "worktree", "add", "--quiet", "--detach", leftover, "HEAD");
  git(
    leftover,
    "fetch",
    "--quiet",
    sourceRepo,
    `refs/heads/${branch}:refs/tmp/ref`,
  );
  git(leftover, "read-tree", "--reset", "-u", "refs/tmp/ref");
  git(leftover, "update-ref", "-d", "refs/tmp/ref");
  git(leftover, "reset", "--quiet", "HEAD");
  return leftover;
}

test(
  "template upgrade apply stops on conflicts without nesting markers and detects resolution-in-progress",
  async () => {
    const { templateClone, targetCommit, target7, repo } =
      await makeOwnerEditedRepository();
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const applyArgs = applyNoCheckJsonArgs(repo, targetCommit);
    const expectedWorktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${target7}`,
    );
    const conflictPath = join(
      expectedWorktree,
      "tests/add-on-start-up.test.ts",
    );

    const firstRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(firstRun.exitCode).toBe(2);
    expect(firstRun.stderr).toBe("");
    expect(JSON.parse(firstRun.stdout)).toMatchObject({
      status: "conflicts",
      conflicts: ["tests/add-on-start-up.test.ts"],
      worktree: expectedWorktree,
    });
    expect(
      readFileSync(conflictPath, "utf8").match(/^<<<<<<< ours$/gm)?.length,
    ).toBe(1);

    const secondRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(secondRun.exitCode).toBe(2);
    expect(JSON.parse(secondRun.stdout)).toMatchObject({
      status: "conflicts",
      conflicts: ["tests/add-on-start-up.test.ts"],
    });
    expect(
      readFileSync(conflictPath, "utf8").match(/^<<<<<<< ours$/gm)?.length,
    ).toBe(1);

    writeFileSync(
      join(expectedWorktree, "README.md"),
      `${readFileSync(join(expectedWorktree, "README.md"), "utf8")}# owner note\n`,
    );
    const halfRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(halfRun.exitCode).toBe(5);
    expect(JSON.parse(halfRun.stdout)).toMatchObject({
      status: "resolution-in-progress",
      conflicts: ["tests/add-on-start-up.test.ts"],
      worktree: expectedWorktree,
    });
    expect(readFileSync(join(expectedWorktree, "README.md"), "utf8")).toContain(
      "# owner note",
    );
  },
  processWatchdog(4),
);

test(
  "template upgrade apply creates the branch once conflicts are resolved and reports already-done on rerun",
  async () => {
    const setup = await makeOwnerEditedRepository();
    const { templateClone, targetCommit, base7, target7, branch, repo } = setup;
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const applyArgs = applyNoCheckJsonArgs(repo, targetCommit);
    const expectedWorktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${target7}`,
    );

    await invokeTemplateUpgradeMain(stdout, stderr, applyArgs, runtime);
    writeFileSync(
      join(expectedWorktree, "tests/add-on-start-up.test.ts"),
      setup.resolvedAddOnContent,
    );
    const resolvedRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(resolvedRun.exitCode).toBe(0);
    expect(JSON.parse(resolvedRun.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(existsSync(expectedWorktree)).toBe(false);
    expect(worktrees(repo)).toHaveLength(1);
    expect(git(repo, "status", "--porcelain")).toBe("");
    expect(git(repo, "branch", "--show-current")).toBe("main");
    expect(git(repo, "log", "-1", "--format=%s", branch)).toBe(
      `Upgrade template ${base7} to ${target7}`,
    );
    assertUpgradedBranchContents(repo, branch, targetCommit);

    const againRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyArgs,
      runtime,
    );
    expect(againRun.exitCode).toBe(0);
    expect(JSON.parse(againRun.stdout)).toMatchObject({
      status: "already-done",
      branch,
    });
  },
  processWatchdog(4),
);

test(
  "template upgrade apply converges to the same tree when an identical leftover worktree exists",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const target7 = targetCommit.slice(0, 7);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${target7}`;
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const cleanRepo1 = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "clean-app",
    );
    const cleanRepo2 = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "clean-app",
    );
    await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(cleanRepo1, targetCommit),
      runtime,
    );
    const referenceTree = git(cleanRepo1, "rev-parse", `${branch}^{tree}`);
    const leftover = seedLeftoverWorktree(
      cleanRepo2,
      cleanRepo1,
      branch,
      target7,
    );
    const convergeRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(cleanRepo2, targetCommit),
      runtime,
    );
    expect(convergeRun.exitCode).toBe(0);
    expect(JSON.parse(convergeRun.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(git(cleanRepo2, "rev-parse", `${branch}^{tree}`)).toBe(
      referenceTree,
    );
    expect(existsSync(leftover)).toBe(false);
  },
  processWatchdog(4),
);

test(
  "template upgrade plan shows git diff for changed repository-owned starting copies",
  async () => {
    const { templateClone, repo, targetCommit } =
      await setupStartingCopyUpdate();
    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as PlanJson;
    expect(planJson.status).toBe("planned");
    expect(planJson.conflicts).toEqual([]);
    const rowByPath = new Map(planJson.rows.map((row) => [row.path, row]));
    expect(rowByPath.get("README.md")).toEqual({
      path: "README.md",
      ownerLabel: "repository",
      outcome: "template-copy-changed",
    });
    expect(rowByPath.get("src/cli.ts")).toEqual({
      path: "src/cli.ts",
      ownerLabel: "repository",
      outcome: "template-copy-changed",
    });
    expect(planJson.templateCopyChanges.map((entry) => entry.path)).toEqual([
      "README.md",
      "src/cli.ts",
    ]);
    expect(planJson.templateCopyChanges[0]?.diff).toContain(
      "+## New template section",
    );

    const planTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit],
      { templateRoot: templateClone, env },
    );
    expect(planTextRun.exitCode).toBe(0);
    expect(planTextRun.stdout).toContain("template-copy-changed");
    expect(planTextRun.stdout).toContain(
      "diff --git old/README.md new/README.md",
    );
    expect(planTextRun.stdout).toContain("+## New template section");
  },
  processWatchdog(4),
);

test(
  "template upgrade apply leaves changed repository-owned starting copies untouched on the branch",
  async () => {
    const {
      templateClone,
      repo,
      targetCommit,
      branch,
      originalReadme,
      customCli,
    } = await setupStartingCopyUpdate();
    const env = templateUpgradeEnv();
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applyTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--no-check"],
      { templateRoot: templateClone, env },
    );
    expect(applyTextRun.exitCode).toBe(0);
    expect(applyTextRun.stdout).toContain(`created branch ${branch}`);
    expect(applyTextRun.stdout).toContain("README.md");
    expect(applyTextRun.stdout).toContain("bun run upgrade plan");
    expect(gitOutput(repo, "show", `${branch}:README.md`)).toBe(originalReadme);
    expect(gitOutput(repo, "show", `${branch}:src/cli.ts`)).toBe(customCli);
  },
  processWatchdog(4),
);
