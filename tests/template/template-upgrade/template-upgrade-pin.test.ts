import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin, writeKernelPin } from "../../../src/kernel-pin.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitOutput } from "../../support/git-fixture.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
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
const PREVIOUS_KERNEL_PIN = "c0845947d44cd2b18f2a08685902f3f6efa38115";

interface PinPlanJson {
  status: string;
  rows: { path: string; ownerLabel: string; outcome: string }[];
  dependencyChanges: {
    section: string;
    packageName: string;
    before: string | null;
    after: string | null;
  }[];
  pinMoveNotice?: string;
}

async function setupTemplatePinMoveUpgrade() {
  const { templateClone } = cloneTemplateAtHead(folder);
  const currentPin = readKernelPin(templateClone);
  writeKernelPin(templateClone, {
    ...currentPin,
    commit: PREVIOUS_KERNEL_PIN,
  });
  const lockfilePath = join(templateClone, "generated-repository/bun.lock");
  writeFileSync(lockfilePath, "base-template-lock\n");
  git(
    templateClone,
    "add",
    "--",
    "kernel-pin.json",
    "generated-repository/bun.lock",
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "base template on previous Pin",
  );
  const baseCommit = git(templateClone, "rev-parse", "HEAD");

  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "pin-stable-app",
  );
  const originalPackage = JSON.parse(
    readFileSync(join(repo, "package.json"), "utf8"),
  ) as { dependencies: Record<string, string> };
  const originalLock = readFileSync(join(repo, "bun.lock"), "utf8");
  const pointerSkillPaths = git(
    repo,
    "ls-files",
    "--",
    ".agents/skills/*/SKILL.md",
  )
    .split("\n")
    .filter((entry) => entry !== "");
  const originalSkills = new Map(
    pointerSkillPaths.map((skillPath) => [
      skillPath,
      readFileSync(join(repo, skillPath), "utf8"),
    ]),
  );

  writeKernelPin(templateClone, { ...currentPin, commit: trialBase });
  writeFileSync(lockfilePath, "moved-template-lock\n");
  const rulesPath = join(templateClone, "config/template-rules.mjs");
  writeFileSync(rulesPath, `${readFileSync(rulesPath, "utf8")}\n`);
  git(
    templateClone,
    "add",
    "--",
    "kernel-pin.json",
    "generated-repository/bun.lock",
    "config/template-rules.mjs",
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "move template Pin and tweak rules",
  );
  const targetCommit = git(templateClone, "rev-parse", "HEAD");
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
  return {
    templateClone,
    repo,
    targetCommit,
    branch,
    originalKernelSpec: originalPackage.dependencies["agent-cli-kernel"],
    originalLock,
    originalSkills,
  };
}

test(
  "a template Pin move leaves package.json kernel Pin, pointer skills, and bun.lock unchanged and prints one notice",
  async () => {
    const setup = await setupTemplatePinMoveUpgrade();
    const { templateClone, repo, targetCommit, branch } = setup;
    const expectedNotice = `The template's Pin moved from ${PREVIOUS_KERNEL_PIN.slice(0, 7)} to ${trialBase.slice(0, 7)}; a Template upgrade does not move it. Move yours separately.`;
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as PinPlanJson;
    expect(planJson.status).toBe("planned");
    expect(planJson.pinMoveNotice).toBe(expectedNotice);
    expect(planJson.dependencyChanges).toEqual([]);
    const rowByPath = new Map(planJson.rows.map((row) => [row.path, row]));
    expect(rowByPath.get("package.json")?.outcome).toBe("untouched");
    expect(rowByPath.get("bun.lock")?.outcome).toBe("untouched");
    for (const skillPath of setup.originalSkills.keys()) {
      expect(rowByPath.get(skillPath)?.outcome).toBe("untouched");
    }

    const planTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", targetCommit],
      runtime,
    );
    expect(planTextRun.exitCode).toBe(0);
    expect(planTextRun.stdout.split(expectedNotice)).toHaveLength(2);

    const applyJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applyJsonRun.exitCode).toBe(0);
    expect(JSON.parse(applyJsonRun.stdout)).toMatchObject({
      status: "applied",
      branch,
      pinMoveNotice: expectedNotice,
    });

    const upgradedPackage = JSON.parse(
      gitOutput(repo, "show", `${branch}:package.json`),
    ) as { dependencies: Record<string, string> };
    expect(upgradedPackage.dependencies["agent-cli-kernel"]).toBe(
      setup.originalKernelSpec,
    );
    expect(gitOutput(repo, "show", `${branch}:bun.lock`)).toBe(
      setup.originalLock,
    );
    for (const [skillPath, originalSkill] of setup.originalSkills) {
      expect(gitOutput(repo, "show", `${branch}:${skillPath}`)).toBe(
        originalSkill,
      );
    }
    expect(
      JSON.parse(gitOutput(repo, "show", `${branch}:.template.json`)),
    ).toMatchObject({
      templateRevision: targetCommit,
      templateDirty: false,
    });
    expect(gitOutput(repo, "show", `${branch}:AGENTS.md`)).toContain(
      `Template source: ${targetCommit}`,
    );

    const applyTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--no-check"],
      runtime,
    );
    expect(applyTextRun.exitCode).toBe(0);
    expect(applyTextRun.stdout.split(expectedNotice)).toHaveLength(2);
  },
  processWatchdog(4),
);
