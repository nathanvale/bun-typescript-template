import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pinCauses } from "../../../src/causes.ts";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { PinRefusal, type PinRefusalCode } from "../../../src/pin-move.ts";
import { RepositoryPinRefusal } from "../../../src/pin-move-branch.ts";
import {
  classifyRefusal,
  moveCompletedFailureCauses,
  moveFailedCause,
  movePreWriteRefusalCauses,
  moveRefusalRows,
  moveStateRows,
  pinMoveIdentity,
  pinPlanIdentity,
  planRefusalCauses,
  planRefusalRows,
} from "../../../src/pin-refusals.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
import { pinnedTemplate } from "../../support/kernel-trial-fixture.ts";
import { pinMoveRepositoryFixture } from "../../support/pin-move-repository-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const fixture = pinMoveRepositoryFixture();

const allPinRefusalCodes: readonly PinRefusalCode[] = [
  "pin_places_disagree",
  "kernel_commit_unreachable",
  "kernel_commit_before_carry_out",
  "kernel_history_unreadable",
  "kernel_branch_unreadable",
];

const allRepositoryPinRefusalCodes = [
  "repository_git_failed",
  "repository_dirty",
  "repository_invalid",
  "repository_pin_missing",
  "repository_check_failed",
  "repository_branch_exists",
  "repository_pin_unchanged",
  "trial_stopped",
] as const;

const planRepositoryCodes = [
  "repository_git_failed",
  "repository_invalid",
  "repository_pin_missing",
] as const;

const preWriteRepositoryCodes = [
  "repository_git_failed",
  "repository_dirty",
  "repository_invalid",
  "repository_pin_missing",
  "repository_branch_exists",
  "repository_pin_unchanged",
  "trial_stopped",
] as const;

const planStationCodes = new Set<string>(
  planRefusalRows(pinPlanIdentity).map((row) => row.causeCode),
);
const moveStationCodes = new Set<string>([
  ...moveRefusalRows(pinMoveIdentity).map((row) => row.causeCode),
  ...moveStateRows().map((row) => row.causeCode),
]);

type PinEnvelope = {
  readonly message: string;
  readonly result: {
    readonly commandIdentity: string;
    readonly causeCode: string;
    readonly outcome: string;
    readonly transactionState: string;
    readonly repairAction: string | null;
  };
};

async function runPinRoute(
  root: string,
  args: readonly string[],
  stateHome: string,
  env: Readonly<Record<string, string | undefined>> = {},
  boundMilliseconds = 30_000,
) {
  const result = await spawnBounded(
    [process.execPath, join(root, "src/cli.ts"), ...args],
    {
      cwd: root,
      env: {
        ...inherited(),
        ...gitEnv,
        ...env,
        XDG_STATE_HOME: stateHome,
      },
      boundMilliseconds,
    },
  );
  return {
    exitCode: result.exit,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

function remotePathEnv(remoteRepository: string): {
  readonly PATH: string;
} {
  const remoteBin = folder("pin-refusals-remote-bin-");
  mkdirSync(remoteBin, { recursive: true });
  gitReadingRemoteAs(remoteBin, pin.remote, remoteRepository);
  return { PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}` };
}

describe("pin refusal classification across phases", () => {
  test("every PinRefusal and RepositoryPinRefusal code in pin plan yields a declared refused unchanged DOMAIN_PIN_* cause", () => {
    const planCases = [
      ...allPinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...planRepositoryCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair"),
      })),
    ];

    for (const entry of planCases) {
      const classified = classifyRefusal(entry.error, planRefusalCauses);
      expect(classified, `pin plan: ${entry.code}`).toBeDefined();
      if (classified === undefined) continue;
      expect(classified.causeCode.startsWith("DOMAIN_PIN_")).toBe(true);
      expect(planStationCodes.has(classified.causeCode)).toBe(true);
      const causeRow = pinCauses[classified.causeCode];
      expect(causeRow.outcome).toBe("refused");
      expect(causeRow.transactionState).toBe("unchanged");
    }
  });

  test("every PinRefusal and RepositoryPinRefusal code before writes in pin move yields a declared refused unchanged DOMAIN_PIN_* cause", () => {
    const beforeWriteCases = [
      ...allPinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...preWriteRepositoryCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair"),
      })),
    ];

    for (const entry of beforeWriteCases) {
      const classified = classifyRefusal(
        entry.error,
        movePreWriteRefusalCauses,
      );
      expect(classified, `pin move before-write: ${entry.code}`).toBeDefined();
      if (classified === undefined) continue;
      expect(classified.causeCode.startsWith("DOMAIN_PIN_")).toBe(true);
      expect(moveStationCodes.has(classified.causeCode)).toBe(true);
      const causeRow = pinCauses[classified.causeCode];
      expect(causeRow.outcome).toBe("refused");
      expect(causeRow.transactionState).toBe("unchanged");
    }
  });

  test("every PinRefusal and RepositoryPinRefusal code after writes with start restored yields a declared failed completed DOMAIN_PIN_* cause", () => {
    const restoredCases = [
      ...allPinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...allRepositoryPinRefusalCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair", true),
      })),
    ];

    for (const entry of restoredCases) {
      const classified = classifyRefusal(
        entry.error,
        moveCompletedFailureCauses,
      );
      expect(classified, `pin move restored: ${entry.code}`).toBeDefined();
      if (classified === undefined) continue;
      expect(classified.causeCode.startsWith("DOMAIN_PIN_")).toBe(true);
      expect(moveStationCodes.has(classified.causeCode)).toBe(true);
      const causeRow = pinCauses[classified.causeCode];
      expect(causeRow.outcome).toBe("failed");
      expect(causeRow.transactionState).toBe("completed");
    }
  });

  test("every unrestored transaction state maps to a declared DOMAIN_PIN_MOVE_FAILED_* cause matching transactionState", () => {
    const states = ["unchanged", "partially-completed", "unknown"] as const;
    for (const state of states) {
      const causeCode = moveFailedCause(state);
      expect(causeCode.startsWith("DOMAIN_PIN_MOVE_FAILED_")).toBe(true);
      expect(moveStationCodes.has(causeCode)).toBe(true);
      const causeRow = pinCauses[causeCode];
      expect(causeRow.outcome).toBe("failed");
      expect(causeRow.transactionState).toBe(state);
    }
  });

  test(
    "pin move refuses repository_git_failed before any write when .git/index is corrupt",
    async () => {
      const repo = fixture.freshRepository("pin-refusals-corrupt-index-");
      writeFileSync(join(repo, ".git", "index"), "corrupt-index-bytes");
      const stateHome = folder("pin-refusals-corrupt-state-");

      const run = await runPinRoute(
        ROOT,
        [
          "pin",
          "move",
          fixture.targetCommit,
          "--kernel",
          fixture.kernelRepo,
          "--repository",
          repo,
          "--json",
        ],
        stateHome,
        remotePathEnv(fixture.kernelRepo),
      );
      expect(run.exitCode).toBe(3);
      expect(run.stderr).toBe("");
      const envelope = JSON.parse(run.stdout) as PinEnvelope;
      expect(envelope.result.commandIdentity).toBe(pinMoveIdentity);
      expect(envelope.result.causeCode).toBe(
        "DOMAIN_PIN_REPOSITORY_GIT_FAILED",
      );
      expect(envelope.result.outcome).toBe("refused");
      expect(envelope.result.transactionState).toBe("unchanged");
    },
    processWatchdog(2),
  );

  test("pin move reports a completed restored failure when trial_stopped occurs during repository check and failedAttempt restores cleanly", async () => {
    const copy = templateCopy(folder("pin-refusals-stopped-copy-"), []);
    pinnedTemplate(copy, pin.commit, pin.carryOutIdentity);
    if (!existsSync(join(copy, "node_modules"))) {
      symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
    }
    const trialPath = join(copy, "scripts/kernel-trial.ts");
    const trialSource = readFileSync(trialPath, "utf8");
    const marker = "  if (active.stoppedBy !== undefined)";
    expect(trialSource).toContain(marker);
    writeFileSync(
      trialPath,
      trialSource.replace(
        marker,
        `  if (name === "check command") throw new TrialRefusal("The kernel trial's check command in " + folder + " was stopped by SIGTERM.", "trial_stopped");\n${marker}`,
      ),
    );

    const repo = await fixture.installedRepository(
      "pin-refusals-stopped-repo-",
    );
    commitIn(repo, "commit starting lockfile", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
    });
    const stateHome = folder("pin-refusals-stopped-state-");
    const run = await runPinRoute(
      copy,
      [
        "pin",
        "move",
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
        "--json",
      ],
      stateHome,
      remotePathEnv(fixture.kernelRepo),
      180_000,
    );
    expect(run.exitCode).toBe(3);
    expect(run.stderr).toBe("");
    const envelope = JSON.parse(run.stdout) as PinEnvelope;
    expect(envelope.result.commandIdentity).toBe(pinMoveIdentity);
    expect(envelope.result.causeCode).toBe("DOMAIN_PIN_MOVE_FAILED_RESTORED");
    expect(envelope.result.outcome).toBe("failed");
    expect(envelope.result.transactionState).toBe("completed");
    expect(envelope.message).toContain("stopped");
    expect(envelope.message).toContain(
      "main is checked out again and was not changed.",
    );
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
  }, 180_000);
});
