import { expect, test } from "bun:test";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitOutput } from "../../support/git-fixture.ts";
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
const PRE_REVIEW_IGNORE_BASE = "e80e4e82";

test(
  "upgrading from a template commit without .review/ in .gitignore adds it cleanly without a conflict",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const baseCommit = git(templateClone, "rev-parse", PRE_REVIEW_IGNORE_BASE);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "review-ignore-app",
    );
    const runtime = {
      templateRoot: templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applied = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(
      gitOutput(repo, "show", `${branch}:.gitignore`).split(/\r?\n/),
    ).toContain(".review/");
    expect(gitOutput(repo, "show", `${branch}:eslint.config.mjs`)).toContain(
      '".review/**"',
    );
  },
  processWatchdog(4),
);
