import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
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
const PRE_LOOPBACK_PROBE_BASE = "f9179270";
const LOOPBACK_PROBE_PATH = "tests/support/loopback-connect-probe.ts";

test(
  "upgrading from a template commit without the loopback connect probe adds it byte-identical to the starter kit",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const baseCommit = git(templateClone, "rev-parse", PRE_LOOPBACK_PROBE_BASE);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "loopback-probe-app",
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
    expect(gitOutput(repo, "show", `${branch}:${LOOPBACK_PROBE_PATH}`)).toBe(
      readFileSync(join(ROOT, LOOPBACK_PROBE_PATH), "utf8"),
    );
  },
  processWatchdog(4),
);
