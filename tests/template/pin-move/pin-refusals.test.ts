import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import {
  TrialRefusal,
  trialRefusalCodes,
} from "../../../scripts/kernel-trial.ts";
import { startChild } from "../../../scripts/process-runner.ts";
import { pinCauses } from "../../../src/causes.ts";
import { CliError } from "../../../src/cli-error.ts";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  KernelRefusal,
  kernelRefusalCodes,
} from "../../../src/kernel-reader.ts";
import { PinRefusal, pinRefusalCodes } from "../../../src/pin-move.ts";
import {
  RepositoryPinRefusal,
  repositoryPinRefusalCodes,
} from "../../../src/pin-move-branch.ts";
import {
  classifyMoveRefusal,
  classifyRefusal,
  moveRefusalRows,
  moveStateRows,
  pinMoveIdentity,
  pinPlanIdentity,
  pinVerifyIdentity,
  planRefusalCauses,
  planRefusalRows,
  verifyRefusalCauses,
  verifyRefusalRows,
} from "../../../src/pin-refusals.ts";
import {
  repositoryChangesetPlanErrorCodes,
  repositoryChangesetWriteErrorCodes,
} from "../../../src/template-upgrade-changeset-write.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import { pinnedTemplate } from "../../support/kernel-trial-fixture.ts";
import {
  cloneSpecifier,
  installedKernelCommit,
  pinMoveRepositoryFixture,
} from "../../support/pin-move-repository-fixture.ts";
import {
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const fixture = pinMoveRepositoryFixture();

const planRepositoryCodes = [
  "repository_git_failed",
  "repository_invalid",
  "repository_pin_missing",
] as const;

const afterWriteOnlyRepositoryCodes = new Set<string>([
  "repository_check_failed",
]);

const preWriteRepositoryCodes = repositoryPinRefusalCodes.filter(
  (code) => !afterWriteOnlyRepositoryCodes.has(code),
);

const verifyStationCodes = new Set<string>(
  verifyRefusalRows(pinVerifyIdentity).map((row) => row.causeCode),
);
const planStationCodes = new Set<string>(
  planRefusalRows(pinPlanIdentity).map((row) => row.causeCode),
);
const moveStationCodes = new Set<string>([
  ...moveRefusalRows(pinMoveIdentity).map((row) => row.causeCode),
  ...moveStateRows().map((row) => row.causeCode),
]);

function cliErrorCodesInSource(relativePath: string): string[] {
  const source = readFileSync(join(ROOT, relativePath), "utf8");
  return [
    ...new Set(
      [...source.matchAll(/new CliError\(\s*"([^"]+)"/g)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].filter((code) => code !== "");
}

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
  test("every CliError literal in the shared changeset helpers is covered by the exported helper error code lists", () => {
    const listed = new Set<string>([
      ...repositoryChangesetWriteErrorCodes,
      "changeset_predates_switchover",
    ]);
    for (const file of [
      "src/template-upgrade-changeset-write.ts",
      "src/template-upgrade-changesets.ts",
    ]) {
      for (const code of cliErrorCodesInSource(file)) {
        expect(listed.has(code), `${file}: ${code}`).toBe(true);
      }
    }
  });

  test("every PinRefusal and KernelRefusal code in pin verify yields a declared refused unchanged DOMAIN_PIN_* cause", () => {
    const verifyCases = [
      ...pinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...kernelRefusalCodes.map((code) => ({
        code,
        error: new KernelRefusal(code, `cause ${code}`),
      })),
    ];

    for (const entry of verifyCases) {
      const classified = classifyRefusal(entry.error, verifyRefusalCauses);
      expect(classified, `pin verify: ${entry.code}`).toBeDefined();
      if (classified === undefined) continue;
      expect(classified.causeCode.startsWith("DOMAIN_PIN_")).toBe(true);
      expect(verifyStationCodes.has(classified.causeCode)).toBe(true);
      const causeRow = pinCauses[classified.causeCode];
      expect(causeRow.outcome).toBe("refused");
      expect(causeRow.transactionState).toBe("unchanged");
    }
  });

  test("every PinRefusal, KernelRefusal, RepositoryPinRefusal, and shared-helper CliError code in pin plan yields a declared refused unchanged DOMAIN_PIN_* cause", () => {
    const planCases = [
      ...pinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...kernelRefusalCodes.map((code) => ({
        code,
        error: new KernelRefusal(code, `cause ${code}`),
      })),
      ...planRepositoryCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair"),
      })),
      ...repositoryChangesetPlanErrorCodes.map((code) => ({
        code,
        error: new CliError(code, `cause ${code}`, "repair", 1, false),
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

  test("every PinRefusal, KernelRefusal, TrialRefusal, RepositoryPinRefusal, and shared-helper CliError code before writes in pin move yields a declared refused unchanged DOMAIN_PIN_* cause", () => {
    const beforeWriteCases = [
      ...pinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...kernelRefusalCodes.map((code) => ({
        code,
        error: new KernelRefusal(code, `cause ${code}`),
      })),
      ...trialRefusalCodes.map((code) => ({
        code,
        error: new TrialRefusal(`cause ${code}`, code),
      })),
      ...preWriteRepositoryCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair"),
      })),
      ...repositoryChangesetPlanErrorCodes.map((code) => ({
        code,
        error: new CliError(code, `cause ${code}`, "repair", 1, false),
      })),
    ];

    for (const entry of beforeWriteCases) {
      const classified = classifyMoveRefusal(entry.error, "before-write");
      expect(classified, `pin move before-write: ${entry.code}`).toBeDefined();
      if (classified === undefined) continue;
      expect(classified.causeCode.startsWith("DOMAIN_PIN_")).toBe(true);
      expect(moveStationCodes.has(classified.causeCode)).toBe(true);
      const causeRow = pinCauses[classified.causeCode];
      expect(causeRow.outcome).toBe("refused");
      expect(causeRow.transactionState).toBe("unchanged");
    }
  });

  test("every PinRefusal and RepositoryPinRefusal code after writes with start restored yields a declared failed completed DOMAIN_PIN_* cause, along with KernelRefusal, TrialRefusal, and shared-helper CliError codes", () => {
    const restoredCases = [
      ...pinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...kernelRefusalCodes.map((code) => ({
        code,
        error: new KernelRefusal(code, `cause ${code}`),
      })),
      ...trialRefusalCodes.map((code) => ({
        code,
        error: new TrialRefusal(`cause ${code}`, code),
      })),
      ...repositoryPinRefusalCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair", true),
      })),
      ...repositoryChangesetWriteErrorCodes.map((code) => ({
        code: `CliError(${code})`,
        error: new CliError(code, `cause ${code}`, "repair", 1, false),
      })),
      ...repositoryChangesetWriteErrorCodes.map((code) => ({
        code: `RepositoryPinRefusal(${code})`,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair", true),
      })),
    ];

    for (const entry of restoredCases) {
      const classified = classifyMoveRefusal(entry.error, "restored");
      expect(classified, `pin move restored: ${entry.code}`).toBeDefined();
      if (classified === undefined) continue;
      expect(classified.causeCode.startsWith("DOMAIN_PIN_")).toBe(true);
      expect(moveStationCodes.has(classified.causeCode)).toBe(true);
      const causeRow = pinCauses[classified.causeCode];
      expect(causeRow.outcome).toBe("failed");
      expect(causeRow.transactionState).toBe("completed");
    }
  });

  test("every PinRefusal, KernelRefusal, TrialRefusal, RepositoryPinRefusal, and shared-helper CliError code in unrestored states maps to a declared DOMAIN_PIN_MOVE_FAILED_* cause matching transactionState", () => {
    const unrestoredCases = [
      ...pinRefusalCodes.map((code) => ({
        code,
        error: new PinRefusal(code, `cause ${code}`, "main"),
      })),
      ...kernelRefusalCodes.map((code) => ({
        code,
        error: new KernelRefusal(code, `cause ${code}`),
      })),
      ...trialRefusalCodes.map((code) => ({
        code,
        error: new TrialRefusal(`cause ${code}`, code),
      })),
      ...repositoryPinRefusalCodes.map((code) => ({
        code,
        error: new RepositoryPinRefusal(code, `cause ${code}`, "repair", false),
      })),
      ...repositoryChangesetWriteErrorCodes.map((code) => ({
        code,
        error: new CliError(code, `cause ${code}`, "repair", 1, false),
      })),
    ];
    const states = ["unchanged", "partially-completed", "unknown"] as const;
    for (const state of states) {
      for (const entry of unrestoredCases) {
        const classified = classifyMoveRefusal(entry.error, state);
        expect(classified, `pin move ${state}: ${entry.code}`).toBeDefined();
        if (classified === undefined) continue;
        expect(classified.causeCode.startsWith("DOMAIN_PIN_MOVE_FAILED_")).toBe(
          true,
        );
        expect(moveStationCodes.has(classified.causeCode)).toBe(true);
        const causeRow = pinCauses[classified.causeCode];
        expect(causeRow.outcome).toBe("failed");
        expect(causeRow.transactionState).toBe(state);
      }
    }
  });

  test(
    "pin plan refuses DOMAIN_PIN_SYMLINK_ANCESTOR when .changeset is a symbolic link",
    async () => {
      const repo = fixture.freshRepository("pin-refusals-symlink-changeset-");
      const target = folder("pin-refusals-symlink-target-");
      rmSync(join(repo, ".changeset"), { recursive: true, force: true });
      symlinkSync(target, join(repo, ".changeset"));
      const stateHome = folder("pin-refusals-symlink-state-");

      const run = await runPinRoute(
        ROOT,
        [
          "pin",
          "plan",
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
      expect(envelope.result.commandIdentity).toBe(pinPlanIdentity);
      expect(envelope.result.causeCode).toBe("DOMAIN_PIN_SYMLINK_ANCESTOR");
      expect(envelope.result.outcome).toBe("refused");
      expect(envelope.result.transactionState).toBe("unchanged");
    },
    processWatchdog(2),
  );

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

  test("SIGTERM during repository pin move restores the starting branch kernel and does not strand the next pin move as unresolved", async () => {
    const repo = folder("pin-refusals-sigterm-repo-");
    initRepository(repo);
    const barrier = folder("pin-refusals-sigterm-barrier-");
    const ledger = join(barrier, "check-started");
    const release = join(barrier, "release");
    const pinSpec = cloneSpecifier(fixture.kernelRepo, trialBase);
    const baseManifest = {
      name: "pin-refusals-sigterm-fixture",
      dependencies: { "agent-cli-kernel": pinSpec },
    };
    commitIn(repo, "initial repository with blocking check", {
      ".gitignore": "node_modules/\n",
      "package.json": `${JSON.stringify(
        {
          ...baseManifest,
          scripts: { check: "bun run check-wait.ts" },
        },
        null,
        2,
      )}\n`,
      "check-wait.ts": `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(ledger)}, "check-started\\n");
await new Promise<void>((resolve) => {
  const poll = setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) {
      clearInterval(poll);
      resolve();
    }
  }, 10);
});
`,
    });

    const stateHome = folder("pin-refusals-sigterm-state-");
    const env = {
      ...inherited(),
      ...gitEnv,
      ...remotePathEnv(fixture.kernelRepo),
      XDG_STATE_HOME: stateHome,
    };
    const installed = await spawnBounded([process.execPath, "install"], {
      cwd: repo,
      env,
      boundMilliseconds: 120_000,
    });
    expect({ exit: installed.exit, stderr: installed.stderr }).toMatchObject({
      exit: 0,
    });
    commitIn(repo, "commit starting lockfile", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
    });
    expect(trialBase).toStartWith(installedKernelCommit(repo));

    const child = startChild(
      [
        process.execPath,
        join(ROOT, "src/cli.ts"),
        "pin",
        "move",
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
        "--json",
      ],
      { cwd: ROOT, env, limitMilliseconds: 120_000 },
    );
    const started = watchLedger(ledger, "check-started", 90_000);
    try {
      const reached = await Promise.race([
        started.reached.then(() => "started"),
        child.finished.then(
          (run) => `exited ${run.exitCode}: ${run.stdout}${run.stderr}`,
        ),
      ]);
      expect(reached).toBe("started");
      child.signal("SIGTERM");
      const stopped = await child.finished;
      expect(stopped.exitCode).toBe(143);
    } finally {
      started.stop();
      appendFileSync(release, "go\n");
      child.stop();
      await child.finished;
    }

    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(trialBase).toStartWith(installedKernelCommit(repo));

    commitIn(repo, "restore passing check script", {
      "package.json": `${JSON.stringify(
        {
          ...baseManifest,
          scripts: { check: "bun -e ''" },
        },
        null,
        2,
      )}\n`,
    });
    const nextRun = await runPinRoute(
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
      env,
      120_000,
    );
    expect(nextRun.exitCode).toBe(0);
    expect(nextRun.stderr).toBe("");
    const nextEnvelope = JSON.parse(nextRun.stdout) as PinEnvelope;
    expect(nextEnvelope.result.causeCode).toBe("SUCCESS_COMPLETED");
  }, 180_000);
});
