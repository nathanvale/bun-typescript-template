import { expect, test } from "bun:test";
import {
  main,
  resolveUpgradeGateBases,
  runBelowFloorRefusalCheck,
  runUpgradeGateCase,
  UPGRADE_GATE_BASES,
} from "../../../scripts/template-upgrade-gate.ts";
import { TEMPLATE_UPGRADE_FLOOR } from "../../../src/template-upgrade-git.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { git } from "../../support/git-fixture.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { processWatchdog } from "../../support/process.ts";

test("resolveUpgradeGateBases returns the floor and every shape-boundary base strictly before HEAD", () => {
  const headCommit = git(ROOT, "rev-parse", "HEAD");
  const resolved = resolveUpgradeGateBases(ROOT, headCommit);
  expect(resolved.targetCommit).toBe(headCommit);
  expect(resolved.belowFloorCommit).toBe(
    git(ROOT, "rev-parse", `${TEMPLATE_UPGRADE_FLOOR}~1`),
  );
  expect(resolved.bases[0]?.commit).toBe(TEMPLATE_UPGRADE_FLOOR);
  const commits = resolved.bases.map((entry) => entry.commit);
  expect(new Set(commits).size).toBe(commits.length);
  expect(commits).not.toContain(headCommit);
  for (const base of UPGRADE_GATE_BASES) {
    if (base.commit !== headCommit) {
      expect(commits).toContain(base.commit);
    }
  }
});

test(
  "runBelowFloorRefusalCheck refuses the commit just below the supported floor with base_commit_unsupported",
  () => {
    const resolved = resolveUpgradeGateBases(ROOT, "HEAD");
    const result = runBelowFloorRefusalCheck({
      templateRoot: ROOT,
      belowFloorCommit: resolved.belowFloorCommit,
      targetCommit: resolved.targetCommit,
      kernelRepository: siblingKernel(),
    });
    expect(result.code).toBe("base_commit_unsupported");
  },
  processWatchdog(4),
);

test(
  "runUpgradeGateCase upgrades from the floor on its original Pin without moving the Pin and reports already-done on rerun",
  () => {
    const resolved = resolveUpgradeGateBases(ROOT, "HEAD");
    const floor = resolved.bases[0];
    expect(floor?.commit).toBe(TEMPLATE_UPGRADE_FLOOR);
    if (floor === undefined) {
      throw new Error("Expected floor base.");
    }
    const report = runUpgradeGateCase({
      templateRoot: ROOT,
      base: floor,
      targetCommit: resolved.targetCommit,
      kernelRepository: siblingKernel(),
      check: false,
      alignPin: false,
    });
    expect(report.baseCommit).toBe(TEMPLATE_UPGRADE_FLOOR);
    expect(report.mode).toBe("original-pin");
    expect(report.pinnedCommit).toBe(
      "9d5d5a81785bfe548a9448348c68ee3b5720cd95",
    );
    expect(report.branch).toBe(
      `template-upgrade/${TEMPLATE_UPGRADE_FLOOR.slice(0, 7)}-${resolved.targetCommit.slice(0, 7)}`,
    );
  },
  processWatchdog(4),
);

test("main refuses unknown options with exit code 2 and usage text", () => {
  const out: string[] = [];
  const err: string[] = [];
  const code = main(
    ["--unknown"],
    ROOT,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  expect(code).toBe(2);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("Usage: bun run upgrade-gate");
});

test("resolveUpgradeGateBases and main refuse an unknown target revision", () => {
  const missingRevision = "0000000000000000000000000000000000000000";
  expect(() => resolveUpgradeGateBases(ROOT, missingRevision)).toThrow(
    /Cannot resolve target revision/,
  );
  const out: string[] = [];
  const err: string[] = [];
  const code = main(
    ["--to", missingRevision],
    ROOT,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  expect(code).toBe(1);
  expect(out).toEqual([]);
  expect(err.join("\n")).toContain("Cannot resolve target revision");
});
