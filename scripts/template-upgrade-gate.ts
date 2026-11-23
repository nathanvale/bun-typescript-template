import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { findSiblingKernel, readKernelPin } from "../src/kernel-pin.ts";
import { TEMPLATE_JSON_FILE } from "../src/recipe.ts";
import { TEMPLATE_UPGRADE_FLOOR } from "../src/template-upgrade-git.ts";
import { OLD_TEMPLATE_JSON_FILE } from "../src/template-upgrade-inputs.ts";
import {
  alignRepositoryKernelPin,
  bootstrapAtCommit,
  commitInitialRepository,
  type EnvMap,
  firstParentOf,
  GIT_MS,
  gateEnv,
  gitFileExists,
  isAncestor,
  readPackageKernelPin,
  readUtf8Strict,
  revParse,
  runGit,
  runProcess,
} from "./template-upgrade-gate-git.ts";

const templateRoot = resolve(import.meta.dir, "..");
const DEFAULT_STEP_MS = 120_000;

export type UpgradeGateBase = {
  readonly commit: string;
  readonly label: string;
};

export type UpgradeGateCaseOptions = {
  readonly templateRoot: string;
  readonly base: UpgradeGateBase;
  readonly targetCommit: string;
  readonly kernelRepository: string;
  readonly check: boolean;
  readonly alignPin: boolean;
  readonly stepLimitMilliseconds?: number;
};

export type UpgradeGateCaseReport = {
  readonly baseCommit: string;
  readonly label: string;
  readonly mode: "check" | "original-pin";
  readonly elapsedMilliseconds: number;
  readonly branch: string;
  readonly pinnedCommit: string;
};

export const UPGRADE_GATE_BASES: readonly UpgradeGateBase[] = [
  {
    commit: TEMPLATE_UPGRADE_FLOOR,
    label: "supported floor (pre-verify-cli, Pin 9d5d5a8)",
  },
  {
    commit: "4e50db5cd9c7762ade98d317a80655c398d620ab",
    label: "first Pin move and verify-cli pointer skill",
  },
  {
    commit: "9a91f6dc64bb18a75bd4876df94f632432ac0302",
    label: "post-script-cleanup and Bootstrap recipe split",
  },
  {
    commit: "a0ae6f4ccc98cb2ea6cd2473c0c022b20561742d",
    label: "menu kernel Pin 426e5db with old template record file",
  },
  {
    commit: "399c3e42e69a833d609d2218a47fa1c695c79882",
    label: "Bootstrap adds name field to old template record file",
  },
  {
    commit: "8062fbaa9403b743bf9fd3dc94098c9dc8f0f23b",
    label: "Bootstrap renames record file to .template.json",
  },
];

type UpgradeAnswer = {
  readonly status?: string;
  readonly branch?: string;
  readonly conflicts?: unknown;
  readonly pinMoveNotice?: string;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly repair?: string;
  };
};

export async function resolveUpgradeGateBases(
  root: string,
  targetRevision = "HEAD",
) {
  const targetCommit = await revParse(root, targetRevision);
  if (targetCommit === undefined) {
    throw new Error(
      `Cannot resolve target revision "${targetRevision}". Repair: pass a valid git commit to --to.`,
    );
  }
  const belowFloorCommit = await revParse(root, `${TEMPLATE_UPGRADE_FLOOR}~1`);
  if (belowFloorCommit === undefined) {
    throw new Error(
      `Commit ${TEMPLATE_UPGRADE_FLOOR.slice(0, 7)}~1 is missing. Repair: run git fetch --unshallow.`,
    );
  }
  const seen = new Set<string>();
  const bases: UpgradeGateBase[] = [];
  for (const base of UPGRADE_GATE_BASES) {
    const commit = await revParse(root, base.commit);
    if (commit === undefined) {
      throw new Error(
        `Base ${base.commit.slice(0, 7)} is missing. Repair: run git fetch --unshallow.`,
      );
    }
    if (!(await isAncestor(root, commit, targetCommit))) {
      throw new Error(
        `Base ${commit.slice(0, 7)} is not an ancestor of ${targetCommit.slice(0, 7)}.`,
      );
    }
    if (commit !== targetCommit && !seen.has(commit)) {
      seen.add(commit);
      bases.push({ commit, label: base.label });
    }
  }
  const firstParent = await firstParentOf(root, targetCommit);
  if (
    firstParent !== undefined &&
    firstParent !== targetCommit &&
    !seen.has(firstParent) &&
    (await isAncestor(root, TEMPLATE_UPGRADE_FLOOR, firstParent))
  ) {
    bases.push({
      commit: firstParent,
      label: "newest prior mainline commit (HEAD^1)",
    });
  }
  if (bases.length === 0) {
    throw new Error(
      `No supported base strictly precedes ${targetCommit.slice(0, 7)}.`,
    );
  }
  return { targetCommit, belowFloorCommit, bases };
}

function parseJsonAnswer(text: string, label: string): UpgradeAnswer {
  try {
    return JSON.parse(text) as UpgradeAnswer;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `${label} did not print valid JSON (${reason}): ${text.slice(0, 300)}`,
      { cause: error },
    );
  }
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function assertRepositoryUntouched(
  repositoryDir: string,
  headBefore: string,
  worktreesBefore: string,
  targetCommit: string,
  label: string,
  env: EnvMap,
): Promise<void> {
  check(
    (await runGit(repositoryDir, ["rev-parse", "HEAD"], env)) === headBefore,
    `Repository HEAD moved ${label}.`,
  );
  const dirty = await runGit(repositoryDir, ["status", "--porcelain"], env);
  check(dirty === "", `Working tree modified ${label}: ${dirty}`);
  const worktreesAfter = await runGit(
    repositoryDir,
    ["worktree", "list", "--porcelain"],
    env,
  );
  check(
    worktreesAfter === worktreesBefore,
    `Worktree registrations changed ${label}.`,
  );
  const targetWorktree = join(
    repositoryDir,
    ".worktrees",
    `template-upgrade-${targetCommit.slice(0, 7)}`,
  );
  const tempWorktree = join(
    repositoryDir,
    ".worktrees",
    "template-upgrade-tmp",
  );
  check(
    !existsSync(targetWorktree),
    `Leftover worktree ${label}: ${targetWorktree}`,
  );
  check(
    !existsSync(tempWorktree),
    `Leftover temp worktree ${label}: ${tempWorktree}`,
  );
}

async function assertUpgradedBranch(
  repositoryDir: string,
  branch: string,
  expectedPin: string,
  targetCommit: string,
  fixtureName: string,
  sourcePacket: string,
  env: EnvMap,
): Promise<void> {
  const upgradedPin = readPackageKernelPin(
    await runGit(repositoryDir, ["show", `${branch}:package.json`], env),
  );
  check(
    upgradedPin === expectedPin,
    `Pin changed on ${branch}: expected ${expectedPin}, got ${upgradedPin}.`,
  );
  check(
    await gitFileExists(repositoryDir, branch, TEMPLATE_JSON_FILE, env),
    `Expected ${TEMPLATE_JSON_FILE} on ${branch}.`,
  );
  check(
    !(await gitFileExists(repositoryDir, branch, OLD_TEMPLATE_JSON_FILE, env)),
    `Expected ${OLD_TEMPLATE_JSON_FILE} absent on ${branch}.`,
  );
  const record = JSON.parse(
    await runGit(
      repositoryDir,
      ["show", `${branch}:${TEMPLATE_JSON_FILE}`],
      env,
    ),
  ) as {
    readonly name?: string;
    readonly templateRevision?: string;
    readonly templateDirty?: boolean;
    readonly sourcePacket?: string;
  };
  check(
    record.templateRevision === targetCommit &&
      record.templateDirty === false &&
      record.name === fixtureName &&
      record.sourcePacket === sourcePacket,
    `Unexpected ${TEMPLATE_JSON_FILE} on ${branch}: ${JSON.stringify(record)}.`,
  );
}

async function verifyPublishedBranchCheck(
  workDir: string,
  repositoryDir: string,
  branch: string,
  env: EnvMap,
  stepLimit: number,
): Promise<void> {
  const verifyDir = join(workDir, "verify");
  await runGit(
    workDir,
    ["clone", "--quiet", "--branch", branch, repositoryDir, verifyDir],
    env,
  );
  const installRun = await runProcess(
    [process.execPath, "install", "--frozen-lockfile"],
    verifyDir,
    env,
    stepLimit,
  );
  check(
    !installRun.timedOut && installRun.exitCode === 0,
    `Independent bun install --frozen-lockfile failed on ${branch}: ${(installRun.stderr || installRun.stdout).slice(-400)}`,
  );
  const checkRun = await runProcess(
    [process.execPath, "run", "check"],
    verifyDir,
    env,
    stepLimit,
  );
  check(
    !checkRun.timedOut && checkRun.exitCode === 0,
    `Independent bun run check failed on ${branch}: ${(checkRun.stderr || checkRun.stdout).slice(-400)}`,
  );
}

export async function runUpgradeGateCase(
  options: UpgradeGateCaseOptions,
): Promise<UpgradeGateCaseReport> {
  const start = performance.now();
  const stepLimit = options.stepLimitMilliseconds ?? DEFAULT_STEP_MS;
  const baseShort = options.base.commit.slice(0, 7);
  const targetShort = options.targetCommit.slice(0, 7);
  const fixtureName = `upgrade-gate-${baseShort}`;
  const sourcePacket = `/abs/packets/${fixtureName}`;
  const env = gateEnv(options.kernelRepository);
  const workDir = mkdtempSync(join(tmpdir(), `upgrade-gate-${baseShort}-`));
  try {
    const repositoryDir = await bootstrapAtCommit(
      workDir,
      options.templateRoot,
      options.base.commit,
      fixtureName,
      sourcePacket,
      env,
    );
    const initialPin = readPackageKernelPin(
      readUtf8Strict(join(repositoryDir, "package.json")),
    );
    const targetPin = readKernelPin(options.templateRoot).commit;
    const expectedPin =
      options.alignPin && initialPin !== targetPin ? targetPin : initialPin;
    if (expectedPin !== initialPin) {
      alignRepositoryKernelPin(repositoryDir, initialPin, expectedPin);
    }
    await commitInitialRepository(repositoryDir, env);
    const headBefore = await runGit(repositoryDir, ["rev-parse", "HEAD"], env);
    const worktreesBefore = await runGit(
      repositoryDir,
      ["worktree", "list", "--porcelain"],
      env,
    );
    const applyArgs = [
      process.execPath,
      "run",
      join(options.templateRoot, "src/template-upgrade.ts"),
      "apply",
      "--repository",
      repositoryDir,
      "--to",
      options.targetCommit,
      ...(options.check ? [] : ["--no-check"]),
      "--json",
    ];
    const first = await runProcess(
      applyArgs,
      options.templateRoot,
      env,
      stepLimit,
    );
    check(
      !first.timedOut && first.exitCode === 0 && first.stderr === "",
      `Apply failed for ${baseShort} -> ${targetShort} (exit ${first.exitCode}): ${(first.stdout || first.stderr).slice(-400)}`,
    );
    const firstAnswer = parseJsonAnswer(first.stdout, `Apply (${baseShort})`);
    const branch = `template-upgrade/${baseShort}-${targetShort}`;
    check(
      firstAnswer.status === "applied" &&
        firstAnswer.branch === branch &&
        Array.isArray(firstAnswer.conflicts) &&
        firstAnswer.conflicts.length === 0,
      `Unexpected apply payload for ${baseShort}: ${JSON.stringify(firstAnswer)}.`,
    );
    if (expectedPin !== targetPin) {
      check(
        typeof firstAnswer.pinMoveNotice === "string" &&
          firstAnswer.pinMoveNotice.includes(expectedPin.slice(0, 7)) &&
          firstAnswer.pinMoveNotice.includes(targetPin.slice(0, 7)),
        `Expected pinMoveNotice naming ${expectedPin.slice(0, 7)} and ${targetPin.slice(0, 7)}.`,
      );
    }
    await assertUpgradedBranch(
      repositoryDir,
      branch,
      expectedPin,
      options.targetCommit,
      fixtureName,
      sourcePacket,
      env,
    );
    await assertRepositoryUntouched(
      repositoryDir,
      headBefore,
      worktreesBefore,
      options.targetCommit,
      `after first apply (${baseShort})`,
      env,
    );
    if (options.check) {
      await verifyPublishedBranchCheck(
        workDir,
        repositoryDir,
        branch,
        env,
        stepLimit,
      );
    }
    const second = await runProcess(
      applyArgs,
      options.templateRoot,
      env,
      stepLimit,
    );
    check(
      !second.timedOut && second.exitCode === 0 && second.stderr === "",
      `Second apply failed for ${baseShort} (exit ${second.exitCode}): ${second.stderr.slice(-300)}`,
    );
    const secondAnswer = parseJsonAnswer(
      second.stdout,
      `Second apply (${baseShort})`,
    );
    check(
      secondAnswer.status === "already-done" && secondAnswer.branch === branch,
      `Expected already-done for ${baseShort}, got ${JSON.stringify(secondAnswer)}.`,
    );
    await assertRepositoryUntouched(
      repositoryDir,
      headBefore,
      worktreesBefore,
      options.targetCommit,
      `after rerun (${baseShort})`,
      env,
    );
    return {
      baseCommit: options.base.commit,
      label: options.base.label,
      mode: options.check ? "check" : "original-pin",
      elapsedMilliseconds: Math.round(performance.now() - start),
      branch,
      pinnedCommit: expectedPin,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

export async function runBelowFloorRefusalCheck(options: {
  readonly templateRoot: string;
  readonly belowFloorCommit: string;
  readonly targetCommit: string;
  readonly kernelRepository: string;
}): Promise<{ readonly code: string; readonly elapsedMilliseconds: number }> {
  const start = performance.now();
  const env = gateEnv(options.kernelRepository);
  const workDir = mkdtempSync(join(tmpdir(), "upgrade-gate-below-floor-"));
  try {
    const repositoryDir = await bootstrapAtCommit(
      workDir,
      options.templateRoot,
      TEMPLATE_UPGRADE_FLOOR,
      "below-floor-app",
      "/abs/packets/below-floor-app",
      env,
    );
    const stampPath = join(repositoryDir, OLD_TEMPLATE_JSON_FILE);
    const stamp = JSON.parse(readUtf8Strict(stampPath)) as Record<
      string,
      unknown
    >;
    writeFileSync(
      stampPath,
      `${JSON.stringify({ ...stamp, templateRevision: options.belowFloorCommit }, null, 2)}\n`,
    );
    await commitInitialRepository(repositoryDir, env);
    const run = await runProcess(
      [
        process.execPath,
        "run",
        join(options.templateRoot, "src/template-upgrade.ts"),
        "apply",
        "--repository",
        repositoryDir,
        "--to",
        options.targetCommit,
        "--json",
      ],
      options.templateRoot,
      env,
      GIT_MS,
    );
    check(
      !run.timedOut && run.exitCode === 2 && run.stdout === "",
      `Expected exit 2 and empty stdout below floor, got exit ${run.exitCode}, stdout ${JSON.stringify(run.stdout)}.`,
    );
    const payload = parseJsonAnswer(run.stderr, "Below-floor refusal");
    const floorShort = TEMPLATE_UPGRADE_FLOOR.slice(0, 7);
    const belowShort = options.belowFloorCommit.slice(0, 7);
    const expectedMessage = `base commit ${belowShort} is older than the oldest supported template upgrade base ${floorShort}; older template commits required --profile in bootstrap`;
    check(
      payload.status === "refused" &&
        payload.error?.code === "base_commit_unsupported" &&
        payload.error.message === expectedMessage &&
        payload.error.repair ===
          "regenerate the repository from a newer template commit, or carry changes by hand",
      `Unexpected below-floor refusal: ${JSON.stringify(payload)}.`,
    );
    check(
      !existsSync(join(repositoryDir, ".worktrees")),
      "Below-floor refusal should not create .worktrees.",
    );
    check(
      (await runGit(
        repositoryDir,
        ["branch", "--list", "template-upgrade/*"],
        env,
      )) === "",
      "Below-floor refusal should not create a branch.",
    );
    return {
      code: payload.error?.code ?? "",
      elapsedMilliseconds: Math.round(performance.now() - start),
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

function parseGateArguments(argv: readonly string[]) {
  if (argv.length === 0) return { targetRevision: "HEAD" };
  const [flag, value, ...rest] = argv;
  return flag === "--to" && value !== undefined && rest.length === 0
    ? { targetRevision: value }
    : undefined;
}

export async function main(
  argv: readonly string[],
  root = templateRoot,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  writeError: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): Promise<number> {
  const parsed = parseGateArguments(argv);
  if (parsed === undefined) {
    writeError("Usage: bun run upgrade-gate [--to <git revision>]");
    return 2;
  }
  try {
    const { targetCommit, belowFloorCommit, bases } =
      await resolveUpgradeGateBases(root, parsed.targetRevision);
    const kernelRepository = findSiblingKernel(root, process.env);
    const totalStart = performance.now();
    const targetShort = targetCommit.slice(0, 7);
    const belowFloor = await runBelowFloorRefusalCheck({
      templateRoot: root,
      belowFloorCommit,
      targetCommit,
      kernelRepository,
    });
    write(
      `PASS below-floor ${belowFloorCommit.slice(0, 7)} refused (${belowFloor.code}) in ${(belowFloor.elapsedMilliseconds / 1000).toFixed(1)} s`,
    );
    const floorBase = bases[0];
    if (
      floorBase !== undefined &&
      floorBase.commit === TEMPLATE_UPGRADE_FLOOR
    ) {
      const original = await runUpgradeGateCase({
        templateRoot: root,
        base: floorBase,
        targetCommit,
        kernelRepository,
        check: false,
        alignPin: false,
      });
      write(
        `PASS ${floorBase.commit.slice(0, 7)} -> ${targetShort} (original Pin ${original.pinnedCommit.slice(0, 7)}, no-check) in ${(original.elapsedMilliseconds / 1000).toFixed(1)} s`,
      );
    }
    for (const base of bases) {
      const report = await runUpgradeGateCase({
        templateRoot: root,
        base,
        targetCommit,
        kernelRepository,
        check: true,
        alignPin: true,
      });
      write(
        `PASS ${base.commit.slice(0, 7)} -> ${targetShort} (${base.label}, Pin ${report.pinnedCommit.slice(0, 7)}) in ${(report.elapsedMilliseconds / 1000).toFixed(1)} s`,
      );
    }
    const total = ((performance.now() - totalStart) / 1000).toFixed(1);
    write(
      `Upgrade gate passed: ${bases.length} supported bases (plus original-Pin floor and below-floor refusal) verified against ${targetShort} in ${total} s.`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeError(`upgrade-gate: ${message}`);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv.slice(2));
}
