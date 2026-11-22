import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
  GIT_MS,
  gateEnv,
  gitFileExists,
  isAncestor,
  readPackageKernelPin,
  revParse,
  runGit,
  runProcess,
} from "./template-upgrade-gate-git.ts";

const templateRoot = resolve(import.meta.dir, "..");
const UPGRADE_MS = 180_000;

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
  readonly conflicts?: readonly string[];
  readonly pinMoveNotice?: string;
  readonly error?: {
    readonly code?: string;
    readonly message?: string;
    readonly repair?: string;
  };
};

export function resolveUpgradeGateBases(root: string, targetRevision = "HEAD") {
  const targetCommit = revParse(root, targetRevision);
  if (targetCommit === undefined) {
    throw new Error(
      `Cannot resolve target revision "${targetRevision}". Repair: pass a valid git commit to --to.`,
    );
  }
  const belowFloorCommit = revParse(root, `${TEMPLATE_UPGRADE_FLOOR}~1`);
  if (belowFloorCommit === undefined) {
    throw new Error(
      `Commit ${TEMPLATE_UPGRADE_FLOOR.slice(0, 7)}~1 is missing. Repair: run git fetch --unshallow.`,
    );
  }
  const seen = new Set<string>();
  const bases: UpgradeGateBase[] = [];
  for (const base of UPGRADE_GATE_BASES) {
    const commit = revParse(root, base.commit);
    if (commit === undefined) {
      throw new Error(
        `Base ${base.commit.slice(0, 7)} is missing. Repair: run git fetch --unshallow.`,
      );
    }
    if (!isAncestor(root, commit, targetCommit)) {
      throw new Error(
        `Base ${commit.slice(0, 7)} is not an ancestor of ${targetCommit.slice(0, 7)}.`,
      );
    }
    if (commit !== targetCommit && !seen.has(commit)) {
      seen.add(commit);
      bases.push({ commit, label: base.label });
    }
  }
  const firstParent = revParse(root, `${targetCommit}^1`);
  if (
    firstParent !== undefined &&
    firstParent !== targetCommit &&
    !seen.has(firstParent) &&
    isAncestor(root, TEMPLATE_UPGRADE_FLOOR, firstParent)
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

function assertUpgradedBranch(
  repositoryDir: string,
  branch: string,
  expectedPin: string,
  targetCommit: string,
  fixtureName: string,
  sourcePacket: string,
  headBefore: string,
  env: EnvMap,
): void {
  const upgradedPin = readPackageKernelPin(
    runGit(repositoryDir, ["show", `${branch}:package.json`], env),
  );
  check(
    upgradedPin === expectedPin,
    `Pin changed on ${branch}: expected ${expectedPin}, got ${upgradedPin}.`,
  );
  check(
    gitFileExists(repositoryDir, `${branch}:${TEMPLATE_JSON_FILE}`, env),
    `Expected ${TEMPLATE_JSON_FILE} on ${branch}.`,
  );
  check(
    !gitFileExists(repositoryDir, `${branch}:${OLD_TEMPLATE_JSON_FILE}`, env),
    `Expected ${OLD_TEMPLATE_JSON_FILE} absent on ${branch}.`,
  );
  const record = JSON.parse(
    runGit(repositoryDir, ["show", `${branch}:${TEMPLATE_JSON_FILE}`], env),
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
  check(
    runGit(repositoryDir, ["rev-parse", "HEAD"], env) === headBefore,
    `Repository HEAD moved on ${branch}.`,
  );
  const dirty = runGit(repositoryDir, ["status", "--porcelain"], env);
  check(dirty === "", `Working tree modified on ${branch}: ${dirty}`);
  const worktree = join(
    repositoryDir,
    ".worktrees",
    `template-upgrade-${targetCommit.slice(0, 7)}`,
  );
  check(!existsSync(worktree), `Leftover worktree on ${branch}: ${worktree}`);
}

export function runUpgradeGateCase(
  options: UpgradeGateCaseOptions,
): UpgradeGateCaseReport {
  const start = performance.now();
  const baseShort = options.base.commit.slice(0, 7);
  const targetShort = options.targetCommit.slice(0, 7);
  const fixtureName = `upgrade-gate-${baseShort}`;
  const sourcePacket = `/abs/packets/${fixtureName}`;
  const env = gateEnv(options.kernelRepository);
  const workDir = mkdtempSync(join(tmpdir(), `upgrade-gate-${baseShort}-`));
  try {
    const repositoryDir = bootstrapAtCommit(
      workDir,
      options.templateRoot,
      options.base.commit,
      fixtureName,
      sourcePacket,
      env,
    );
    const initialPin = readPackageKernelPin(
      readFileSync(join(repositoryDir, "package.json"), "utf8"),
    );
    const targetPin = readKernelPin(options.templateRoot).commit;
    const expectedPin =
      options.alignPin && initialPin !== targetPin ? targetPin : initialPin;
    if (expectedPin !== initialPin) {
      alignRepositoryKernelPin(repositoryDir, initialPin, expectedPin);
    }
    commitInitialRepository(repositoryDir, env);
    const headBefore = runGit(repositoryDir, ["rev-parse", "HEAD"], env);
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
    const first = runProcess(applyArgs, options.templateRoot, env, UPGRADE_MS);
    check(
      !first.timedOut && first.exitCode === 0 && first.stderr === "",
      `Apply failed for ${baseShort} -> ${targetShort} (exit ${first.exitCode}): ${(first.stdout || first.stderr).slice(-400)}`,
    );
    const firstAnswer = parseJsonAnswer(first.stdout, `Apply (${baseShort})`);
    const branch = `template-upgrade/${baseShort}-${targetShort}`;
    check(
      firstAnswer.status === "applied" &&
        firstAnswer.branch === branch &&
        (firstAnswer.conflicts ?? []).length === 0,
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
    assertUpgradedBranch(
      repositoryDir,
      branch,
      expectedPin,
      options.targetCommit,
      fixtureName,
      sourcePacket,
      headBefore,
      env,
    );
    const second = runProcess(applyArgs, options.templateRoot, env, UPGRADE_MS);
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

export function runBelowFloorRefusalCheck(options: {
  readonly templateRoot: string;
  readonly belowFloorCommit: string;
  readonly targetCommit: string;
  readonly kernelRepository: string;
}): { readonly code: string; readonly elapsedMilliseconds: number } {
  const start = performance.now();
  const env = gateEnv(options.kernelRepository);
  const workDir = mkdtempSync(join(tmpdir(), "upgrade-gate-below-floor-"));
  try {
    const repositoryDir = bootstrapAtCommit(
      workDir,
      options.templateRoot,
      TEMPLATE_UPGRADE_FLOOR,
      "below-floor-app",
      "/abs/packets/below-floor-app",
      env,
    );
    const stampPath = join(repositoryDir, OLD_TEMPLATE_JSON_FILE);
    const stamp = JSON.parse(readFileSync(stampPath, "utf8")) as Record<
      string,
      unknown
    >;
    writeFileSync(
      stampPath,
      `${JSON.stringify({ ...stamp, templateRevision: options.belowFloorCommit }, null, 2)}\n`,
    );
    commitInitialRepository(repositoryDir, env);
    const run = runProcess(
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
    check(
      payload.status === "refused" &&
        payload.error?.code === "base_commit_unsupported" &&
        Boolean(payload.error.message?.includes(belowShort)) &&
        Boolean(payload.error.message?.includes(floorShort)) &&
        Boolean(payload.error.message?.includes("--profile")) &&
        Boolean(payload.error.repair && payload.error.repair.trim().length > 0),
      `Unexpected below-floor refusal: ${JSON.stringify(payload)}.`,
    );
    check(
      !existsSync(join(repositoryDir, ".worktrees")),
      "Below-floor refusal should not create .worktrees.",
    );
    check(
      runGit(repositoryDir, ["branch", "--list", "template-upgrade/*"], env) ===
        "",
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

export function main(
  argv: readonly string[],
  root = templateRoot,
  write: (line: string) => void = (line) => {
    process.stdout.write(`${line}\n`);
  },
  writeError: (line: string) => void = (line) => {
    process.stderr.write(`${line}\n`);
  },
): number {
  const parsed = parseGateArguments(argv);
  if (parsed === undefined) {
    writeError("Usage: bun run upgrade-gate [--to <git revision>]");
    return 2;
  }
  try {
    const kernelRepository = findSiblingKernel(root, process.env);
    const { targetCommit, belowFloorCommit, bases } = resolveUpgradeGateBases(
      root,
      parsed.targetRevision,
    );
    const totalStart = performance.now();
    const targetShort = targetCommit.slice(0, 7);
    const belowFloor = runBelowFloorRefusalCheck({
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
      const original = runUpgradeGateCase({
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
      const report = runUpgradeGateCase({
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
  process.exitCode = main(process.argv.slice(2));
}
