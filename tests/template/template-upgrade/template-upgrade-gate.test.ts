import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  alignRepositoryKernelPin,
  commitInitialRepository,
  firstParentOf,
  gateEnv,
  gitFileExists,
  isAncestor,
  readPackageKernelPin,
  readUtf8Strict,
  revParse,
  runGit,
  runProcess,
} from "../../../scripts/template-upgrade-gate-git.ts";
import {
  main,
  resolveUpgradeGateBases,
  runBelowFloorRefusalCheck,
  runUpgradeGateCase,
  UPGRADE_GATE_BASES,
} from "../../../scripts/template-upgrade-gate.ts";
import { TEMPLATE_UPGRADE_FLOOR } from "../../../src/template-upgrade-git.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git } from "../../support/git-fixture.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { processAlive, processWatchdog } from "../../support/process.ts";

async function captureError(run: () => Promise<unknown>): Promise<Error> {
  try {
    await run();
  } catch (error) {
    if (error instanceof Error) return error;
    throw error;
  }
  throw new Error("Expected promise rejection.");
}

const folder = ownedFolders();

test("resolveUpgradeGateBases returns the floor and every shape-boundary base strictly before HEAD", async () => {
  const headCommit = git(ROOT, "rev-parse", "HEAD");
  const resolved = await resolveUpgradeGateBases(ROOT, headCommit);
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
  async () => {
    const resolved = await resolveUpgradeGateBases(ROOT, "HEAD");
    const result = await runBelowFloorRefusalCheck({
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
  async () => {
    const resolved = await resolveUpgradeGateBases(ROOT, "HEAD");
    const floor = resolved.bases[0];
    expect(floor?.commit).toBe(TEMPLATE_UPGRADE_FLOOR);
    if (floor === undefined) {
      throw new Error("Expected floor base.");
    }
    const report = await runUpgradeGateCase({
      templateRoot: ROOT,
      base: floor,
      targetCommit: resolved.targetCommit,
      kernelRepository: siblingKernel(),
      check: false,
      alignPin: false,
      stepLimitMilliseconds: 30_000,
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

test("git helpers decode UTF-8 strictly, distinguish confirmed absence from git failure, and align Pin references", async () => {
  const work = folder("upgrade-gate-helpers-");
  const badBytesPath = join(work, "bad.bin");
  writeFileSync(badBytesPath, new Uint8Array([0xff, 0xfe]));
  expect(() => readUtf8Strict(badBytesPath)).toThrow(
    "The encoded data was not valid for encoding utf-8",
  );

  const oldPin = "1111111111111111111111111111111111111111";
  const newPin = "2222222222222222222222222222222222222222";
  const repo = join(work, "repo");
  mkdirSync(join(repo, ".agents/skills/agent-cli-kernel"), { recursive: true });
  writeFileSync(
    join(repo, "package.json"),
    JSON.stringify({
      dependencies: {
        "agent-cli-kernel": `github:nathanvale/agent-cli-kernel#${oldPin}`,
      },
    }),
  );
  writeFileSync(
    join(repo, ".agents/skills/agent-cli-kernel/SKILL.md"),
    `Pinned commit: ${oldPin}\n`,
  );
  expect(readPackageKernelPin(readUtf8Strict(join(repo, "package.json")))).toBe(
    oldPin,
  );
  alignRepositoryKernelPin(repo, oldPin, newPin);
  expect(readPackageKernelPin(readUtf8Strict(join(repo, "package.json")))).toBe(
    newPin,
  );
  expect(
    readUtf8Strict(join(repo, ".agents/skills/agent-cli-kernel/SKILL.md")),
  ).toBe(`Pinned commit: ${newPin}\n`);

  const env = gateEnv();
  await commitInitialRepository(repo, env);
  const head = await runGit(repo, ["rev-parse", "HEAD"], env);
  expect(await revParse(repo, "HEAD")).toBe(head);
  expect(await revParse(repo, "no-such-ref")).toBeUndefined();
  expect(await firstParentOf(repo, head)).toBeUndefined();
  expect(await isAncestor(repo, head, head)).toBe(true);
  expect(await gitFileExists(repo, "HEAD", "package.json", env)).toBe(true);
  expect(
    await gitFileExists(repo, "HEAD", ".cli-design-template.json", env),
  ).toBe(false);
  const badBranchError = await captureError(() =>
    gitFileExists(repo, "no-such-branch", "package.json", env),
  );
  expect(badBranchError.message).toContain(
    "git ls-tree --name-only -z no-such-branch -- package.json failed (128):",
  );
});

test(
  "runUpgradeGateCase verifies a full checked upgrade and independent repository check on a current-Pin base",
  async () => {
    const resolved = await resolveUpgradeGateBases(ROOT, "HEAD");
    const newest = resolved.bases.at(-1);
    expect(newest).toBeDefined();
    if (newest === undefined) {
      throw new Error("Expected at least one base.");
    }
    const report = await runUpgradeGateCase({
      templateRoot: ROOT,
      base: newest,
      targetCommit: resolved.targetCommit,
      kernelRepository: siblingKernel(),
      check: true,
      alignPin: true,
      stepLimitMilliseconds: 60_000,
    });
    expect(report.mode).toBe("check");
    expect(report.branch).toBe(
      `template-upgrade/${newest.commit.slice(0, 7)}-${resolved.targetCommit.slice(0, 7)}`,
    );
  },
  processWatchdog(9),
);

function gone(pid: number, boundMilliseconds: number): Promise<boolean> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const alive = processAlive(pid);
      if (alive && Date.now() - started < boundMilliseconds) return;
      clearInterval(poll);
      resolve(!alive);
    }, 10);
  });
}

test(
  "runProcess terminates the whole child process group on timeout",
  async () => {
    const work = folder("upgrade-gate-proc-");
    const pidFile = join(work, "child.pid");
    const result = await runProcess(
      [
        "sh",
        "-c",
        `${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)" & echo $! > ${JSON.stringify(pidFile)}; wait`,
      ],
      work,
      gateEnv(),
      400,
    );
    expect(result.timedOut).toBe(true);
    const descendantPid = Number(readUtf8Strict(pidFile).trim());
    expect(Number.isInteger(descendantPid) && descendantPid > 0).toBe(true);
    expect(await gone(descendantPid, 2_000)).toBe(true);
  },
  processWatchdog(1),
);

test("main refuses unknown options and unknown target revisions with exact errors", async () => {
  const out: string[] = [];
  const err: string[] = [];
  const usageCode = await main(
    ["--unknown"],
    ROOT,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  expect(usageCode).toBe(2);
  expect(out).toEqual([]);
  expect(err).toEqual(["Usage: bun run upgrade-gate [--to <git revision>]"]);

  const missingRevision = "0000000000000000000000000000000000000000";
  const expectedError = `Cannot resolve target revision "${missingRevision}". Repair: pass a valid git commit to --to.`;
  const missingError = await captureError(() =>
    resolveUpgradeGateBases(ROOT, missingRevision),
  );
  expect(missingError.message).toBe(expectedError);
  const out2: string[] = [];
  const err2: string[] = [];
  const missingCode = await main(
    ["--to", missingRevision],
    ROOT,
    (line) => out2.push(line),
    (line) => err2.push(line),
  );
  expect(missingCode).toBe(1);
  expect(out2).toEqual([]);
  expect(err2).toEqual([`upgrade-gate: ${expectedError}`]);
});
