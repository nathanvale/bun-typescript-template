import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

const SETTINGS_PACKAGE = "generated-repository/settings/package.json";
const CONFLICT_HUNK =
  /^<{7} ours\r?\n([\s\S]*?)^={7}\r?\n[\s\S]*?^>{7} new\r?\n/gm;

function readJsonObject(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

function recordEntries(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

test(
  "package.json key conflicts report no false dependency removals, name conflicting keys with base/ours/new, and preserve owner keys on apply and rerun",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const settingsPath = join(templateClone, SETTINGS_PACKAGE);
    const basePkg = readJsonObject(settingsPath);
    const baseScripts = recordEntries(basePkg.scripts);
    const baseCheck =
      "bun run lint && bun run format:check && bun run typecheck && bun run test";
    const targetCheck = `bun run check:bundles && ${baseCheck}`;
    const ownerCheck = `bun run check:skills && ${baseCheck}`;
    const targetRegenerate = "bun run build:bundles";
    const ownerRegenerate = "bun run build:skills";

    const baseScriptsWithoutRegenerate = Object.fromEntries(
      Object.entries(baseScripts).filter(
        ([key]) =>
          key !== "regenerate" &&
          key !== "build:bundles" &&
          key !== "check:bundles",
      ),
    );
    baseScriptsWithoutRegenerate.check = baseCheck;
    const baseCommit = commitIn(templateClone, "package conflict base", {
      [SETTINGS_PACKAGE]: `${JSON.stringify(
        { ...basePkg, scripts: baseScriptsWithoutRegenerate },
        null,
        2,
      )}\n`,
    }).sha;

    const targetDevDeps = recordEntries(basePkg.devDependencies);
    const targetCommit = commitIn(templateClone, "package conflict target", {
      [SETTINGS_PACKAGE]: `${JSON.stringify(
        {
          ...basePkg,
          scripts: {
            ...baseScriptsWithoutRegenerate,
            check: targetCheck,
            "build:bundles": "bun scripts/build-bundles.ts",
            "check:bundles": "bun scripts/build-bundles.ts --check",
            regenerate: targetRegenerate,
          },
          devDependencies: {
            ...targetDevDeps,
            "@biomejs/biome": "2.6.8",
          },
        },
        null,
        2,
      )}\n`,
    }).sha;

    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "skills-package-conflict",
    );
    const ownerPkg = readJsonObject(join(repo, "package.json"));
    const ownerScripts = recordEntries(ownerPkg.scripts);
    const ownerDeps = recordEntries(ownerPkg.dependencies);
    const ownerDevDeps = recordEntries(ownerPkg.devDependencies);
    commitIn(repo, "owner adds skills scripts and dependencies", {
      "package.json": `${JSON.stringify(
        {
          ...ownerPkg,
          scripts: {
            ...ownerScripts,
            "check:skills": "bun run scripts/check-skills.ts",
            check: ownerCheck,
            regenerate: ownerRegenerate,
          },
          dependencies: {
            ...ownerDeps,
            rumdl: "0.3.5",
          },
          devDependencies: {
            ...ownerDevDeps,
            "agent-gates":
              "github:nathanvale/agent-gates#bdf422887766d6b277ddf81c76074236c22ca8c4",
          },
        },
        null,
        2,
      )}\n`,
    });

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit],
      runtime,
    );
    expect(planText.exitCode).toBe(0);
    expect(planText.stdout).not.toContain("-> (removed)");
    expect(planText.stdout).not.toContain("unavailable");
    expect(planText.stdout).toContain("devDependencies.@biomejs/biome:");
    expect(planText.stdout).toContain("-> 2.6.8");
    expect(planText.stdout).toContain("$.scripts.check");
    expect(planText.stdout).toContain("$.scripts.regenerate");
    expect(planText.stdout).toContain(JSON.stringify(baseCheck));
    expect(planText.stdout).toContain(JSON.stringify(ownerCheck));
    expect(planText.stdout).toContain(JSON.stringify(targetCheck));
    expect(planText.stdout).toContain(JSON.stringify(ownerRegenerate));
    expect(planText.stdout).toContain(JSON.stringify(targetRegenerate));

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as {
      status: string;
      conflicts: string[];
      dependencyChanges: { after: string | null }[];
    };
    expect(planJson.status).toBe("conflicts");
    expect(planJson.conflicts).toEqual(["package.json"]);
    expect(
      planJson.dependencyChanges.filter((change) => change.after === null),
    ).toEqual([]);

    const applyText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--no-check"],
      runtime,
    );
    expect(applyText.exitCode).toBe(2);
    expect(applyText.stdout).toContain("$.scripts.check");
    expect(applyText.stdout).toContain("$.scripts.regenerate");
    expect(applyText.stdout).toContain(JSON.stringify(ownerCheck));
    expect(applyText.stdout).toContain(JSON.stringify(targetCheck));

    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const conflictedPackage = readFileSync(
      join(worktree, "package.json"),
      "utf8",
    );
    expect(conflictedPackage.startsWith("<<<<<<< ours\n")).toBe(false);
    expect(conflictedPackage).toContain('"rumdl": "0.3.5"');
    expect(conflictedPackage).toContain('"agent-gates":');
    expect(conflictedPackage).toContain('"check:skills":');
    expect(conflictedPackage).toContain('"build:bundles":');
    expect(conflictedPackage).toContain('"check:bundles":');
    expect(() => {
      JSON.parse(conflictedPackage);
    }).toThrow("JSON Parse error");

    const resolvedPackage = conflictedPackage.replace(CONFLICT_HUNK, "$1");
    expect(JSON.parse(resolvedPackage)).toMatchObject({
      scripts: {
        "check:skills": "bun run scripts/check-skills.ts",
        check: ownerCheck,
        "build:bundles": "bun scripts/build-bundles.ts",
        "check:bundles": "bun scripts/build-bundles.ts --check",
        regenerate: ownerRegenerate,
      },
      dependencies: {
        rumdl: "0.3.5",
      },
      devDependencies: {
        "agent-gates":
          "github:nathanvale/agent-gates#bdf422887766d6b277ddf81c76074236c22ca8c4",
      },
    });
    writeFileSync(join(worktree, "package.json"), resolvedPackage);

    const rerun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect({
      exitCode: rerun.exitCode,
      stderr: rerun.stderr,
    }).toEqual({ exitCode: 0, stderr: "" });
    const applied = JSON.parse(rerun.stdout) as {
      status: string;
      branch: string;
    };
    expect(applied.status).toBe("applied");
    const branchPackage = JSON.parse(
      gitOutput(repo, "show", `${applied.branch}:package.json`),
    ) as Record<string, unknown>;
    expect(branchPackage).toMatchObject({
      dependencies: { rumdl: "0.3.5" },
      scripts: {
        "check:skills": "bun run scripts/check-skills.ts",
        check: ownerCheck,
        "build:bundles": "bun scripts/build-bundles.ts",
        regenerate: ownerRegenerate,
      },
    });
  },
  processWatchdog(4),
);

test(
  "upgrading AGENTS.md with owner text on the line after Template source removes the stamp cleanly without conflict",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const bootstrapPath = join(templateClone, "src/bootstrap.ts");
    const targetBootstrap = readFileSync(bootstrapPath, "utf8");
    const baseBootstrap = targetBootstrap.includes("Template source:")
      ? targetBootstrap
      : targetBootstrap.replace(
          "Source packet: ${options.sourcePacket}\\n\\n${COMMENT_GUIDANCE}",
          "Source packet: ${options.sourcePacket}\\nTemplate source: ${metadata.templateRevision}\\n\\n${COMMENT_GUIDANCE}",
        );
    expect(baseBootstrap).toContain("Template source:");
    writeFileSync(bootstrapPath, baseBootstrap);
    git(templateClone, "add", "--", "src/bootstrap.ts");
    git(
      templateClone,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "base with Template source stamp",
    );
    const baseCommit = git(templateClone, "rev-parse", "HEAD");

    writeFileSync(bootstrapPath, targetBootstrap);
    git(templateClone, "add", "--", "src/bootstrap.ts");
    git(
      templateClone,
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "target without Template source stamp",
    );
    const targetCommit = git(templateClone, "rev-parse", "HEAD");

    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "skills-agents-stamp",
    );
    const originalAgents = readFileSync(join(repo, "AGENTS.md"), "utf8");
    expect(originalAgents).toContain(`Template source: ${baseCommit}`);
    const ownerLine = "Build portable skill CLIs: `bun run build:skills`";
    const editedAgents = originalAgents.replace(
      `Template source: ${baseCommit}\n`,
      `Template source: ${baseCommit}\n${ownerLine}\n`,
    );
    commitIn(repo, "owner adds text right after Template source", {
      "AGENTS.md": editedAgents,
    });

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(planRun.exitCode).toBe(0);
    const planJson = JSON.parse(planRun.stdout) as {
      status: string;
      conflicts: string[];
    };
    expect(planJson.status).toBe("planned");
    expect(planJson.conflicts).toEqual([]);

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(0);
    const applied = JSON.parse(applyRun.stdout) as {
      status: string;
      branch: string;
    };
    expect(applied.status).toBe("applied");
    const upgradedAgents = gitOutput(
      repo,
      "show",
      `${applied.branch}:AGENTS.md`,
    );
    expect(upgradedAgents).not.toContain("Template source:");
    expect(upgradedAgents).toContain(ownerLine);
  },
  processWatchdog(4),
);
