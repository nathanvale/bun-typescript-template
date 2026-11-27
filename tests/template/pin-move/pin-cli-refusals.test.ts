import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import {
  pinMoveIdentity,
  pinPlanIdentity,
  pinVerifyIdentity,
} from "../../../src/pin-refusals.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
import { siblingKernel, trialBase } from "../../support/kernel-sibling.ts";
import { pinnedTemplate } from "../../support/kernel-trial-fixture.ts";
import {
  cloneSpecifier,
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
  const remoteBin = folder("pin-cli-refusals-remote-bin-");
  mkdirSync(remoteBin, { recursive: true });
  gitReadingRemoteAs(remoteBin, pin.remote, remoteRepository);
  return { PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}` };
}

function copyTemplateWithModules(
  commit: string,
  omit: readonly string[] = [],
): string {
  const copy = templateCopy(folder("pin-cli-refusals-copy-"), omit);
  pinnedTemplate(copy, commit, pin.carryOutIdentity);
  if (!existsSync(join(copy, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
  }
  return copy;
}

describe("pin cli narrow refusals", () => {
  test("SIGKILL during repository pin move leaves an unresolved case that the next pin move refuses with DOMAIN_PIN_MOVE_UNRESOLVED", async () => {
    const repo = folder("pin-cli-refusals-sigkill-repo-");
    initRepository(repo);
    const barrier = folder("pin-cli-refusals-sigkill-barrier-");
    const ledger = join(barrier, "check-started");
    const release = join(barrier, "release");
    const pinSpec = cloneSpecifier(fixture.kernelRepo, trialBase);
    commitIn(repo, "initial repository with blocking check", {
      ".gitignore": "node_modules/\n",
      "package.json": `${JSON.stringify(
        {
          name: "pin-cli-refusals-sigkill-fixture",
          dependencies: { "agent-cli-kernel": pinSpec },
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

    const stateHome = folder("pin-cli-refusals-sigkill-state-");
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
      process.kill(child.pid, "SIGKILL");
      const killed = await child.finished;
      expect(killed.exitCode).not.toBe(0);
    } finally {
      started.stop();
      appendFileSync(release, "go\n");
      child.stop();
      await child.finished;
    }

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
      30_000,
    );
    expect(nextRun.exitCode).toBe(3);
    expect(nextRun.stderr).toBe("");
    const envelope = JSON.parse(nextRun.stdout) as PinEnvelope;
    expect(envelope.result.commandIdentity).toBe(pinMoveIdentity);
    expect(envelope.result.causeCode).toBe("DOMAIN_PIN_MOVE_UNRESOLVED");
    expect(envelope.result.outcome).toBe("refused");
    expect(envelope.result.transactionState).toBe("unchanged");
    expect(envelope.result.repairAction).toContain("git status");
    expect(envelope.result.repairAction).toContain("pin-move/<commit>");
    expect(envelope.result.repairAction).toContain("bun run pin:verify");
    expect(envelope.result.repairAction).toContain("qualified close");
    expect(envelope.result.repairAction).not.toMatch(/\b(delete|remove)\b/i);
  }, 180_000);

  test(
    "SIGKILL during template pin move leaves an unresolved case that the next pin move refuses with DOMAIN_PIN_MOVE_UNRESOLVED",
    async () => {
      const copy = copyTemplateWithModules(trialBase, [KERNEL_LOCKFILE]);
      const stateHome = folder("pin-cli-refusals-tpl-sigkill-state-");
      const childTmp = folder("pin-cli-refusals-tpl-sigkill-tmp-");
      const barrier = folder("pin-cli-refusals-tpl-sigkill-barrier-");
      const ledger = join(barrier, "ledger");
      const release = join(barrier, "release");
      const kernel = siblingKernel();
      const env = { ...remotePathEnv(kernel), TMPDIR: childTmp };

      const trialPath = join(copy, "scripts/kernel-trial.ts");
      const trialSource = readFileSync(trialPath, "utf8");
      const marker =
        "export async function kernelTrial(trial: KernelTrial): Promise<TrialPassed> {";
      expect(trialSource).toContain(marker);
      const barrierCode = `${marker}
  const { appendFileSync: appendBarrier, existsSync: barrierExists } = await import("node:fs");
  appendBarrier(${JSON.stringify(ledger)}, "trial-started\\n");
  await new Promise<void>((resolve) => {
    const poll = setInterval(() => {
      if (barrierExists(${JSON.stringify(release)})) {
        clearInterval(poll);
        resolve();
      }
    }, 5);
  });
  throw new TrialRefusal("barrier released", "trial_stopped");
`;
      writeFileSync(trialPath, trialSource.replace(marker, barrierCode));

      const first = startChild(
        [
          process.execPath,
          join(copy, "src/cli.ts"),
          "pin",
          "move",
          pin.commit,
          "--kernel",
          kernel,
          "--json",
        ],
        {
          cwd: copy,
          env: { ...inherited(), ...gitEnv, ...env, XDG_STATE_HOME: stateHome },
          limitMilliseconds: 30_000,
        },
      );
      const started = watchLedger(ledger, "trial-started", 20_000);
      try {
        const reached = await Promise.race([
          started.reached.then(() => "started"),
          first.finished.then(
            (run) => `exited ${run.exitCode}: ${run.stdout}${run.stderr}`,
          ),
        ]);
        expect(reached).toBe("started");
        process.kill(first.pid, "SIGKILL");
        const killed = await first.finished;
        expect(killed.exitCode).not.toBe(0);
      } finally {
        started.stop();
        appendFileSync(release, "go\n");
        first.stop();
        await first.finished;
      }

      const second = await runPinRoute(
        copy,
        ["pin", "move", pin.commit, "--kernel", kernel, "--json"],
        stateHome,
        env,
        15_000,
      );
      expect(second.exitCode).toBe(3);
      expect(second.stderr).toBe("");
      const envelope = JSON.parse(second.stdout) as PinEnvelope;
      expect(envelope.result.commandIdentity).toBe(pinMoveIdentity);
      expect(envelope.result.causeCode).toBe("DOMAIN_PIN_MOVE_UNRESOLVED");
      expect(envelope.result.outcome).toBe("refused");
      expect(envelope.result.transactionState).toBe("unchanged");
      expect(envelope.result.repairAction).toContain("git status");
      expect(envelope.result.repairAction).toContain("pin-move/<commit>");
      expect(envelope.result.repairAction).toContain("bun run pin:verify");
      expect(envelope.result.repairAction).toContain("qualified close");
      expect(envelope.result.repairAction).not.toMatch(/\b(delete|remove)\b/i);
      const starts = readFileSync(ledger, "utf8")
        .split("\n")
        .filter((line) => line === "trial-started");
      expect(starts).toHaveLength(1);
    },
    processWatchdog(3),
  );

  test(
    "pin verify, pin plan, and pin move refuse missing or invalid kernel-pin.json with DOMAIN_PIN_KERNEL_PIN_UNREADABLE and readKernelPin's repair before any write or transaction",
    async () => {
      const repo = fixture.freshRepository("pin-cli-refusals-bad-pin-repo-");
      const restoreRepair =
        "Repair: restore it from the last commit that changed it. After its first write, only a pin move changes the kernel pin.";
      const cases = [
        {
          label: "missing",
          prepare: (copy: string) => {
            rmSync(join(copy, kernelPinFile), { force: true });
          },
          expectedMessage: "is missing at",
        },
        {
          label: "invalid JSON",
          prepare: (copy: string) => {
            writeFileSync(join(copy, kernelPinFile), "{");
          },
          expectedMessage: "is not JSON.",
        },
      ] as const;

      const routes = [
        {
          name: "pin verify",
          identity: pinVerifyIdentity,
          args: ["pin", "verify", "--kernel", fixture.kernelRepo, "--json"],
        },
        {
          name: "pin plan",
          identity: pinPlanIdentity,
          args: [
            "pin",
            "plan",
            fixture.targetCommit,
            "--kernel",
            fixture.kernelRepo,
            "--repository",
            repo,
            "--json",
          ],
        },
        {
          name: "pin move",
          identity: pinMoveIdentity,
          args: [
            "pin",
            "move",
            fixture.targetCommit,
            "--kernel",
            fixture.kernelRepo,
            "--json",
          ],
        },
      ] as const;

      for (const pinCase of cases) {
        const copy = copyTemplateWithModules(trialBase);
        pinCase.prepare(copy);
        for (const route of routes) {
          const stateHome = folder("pin-cli-refusals-bad-pin-state-");
          const run = await runPinRoute(copy, route.args, stateHome);
          expect(run.stderr, `${pinCase.label} ${route.name}`).toBe("");
          const envelope = JSON.parse(run.stdout) as PinEnvelope;
          expect(run.exitCode, `${pinCase.label} ${route.name}`).toBe(3);
          expect(
            envelope.result.commandIdentity,
            `${pinCase.label} ${route.name}`,
          ).toBe(route.identity);
          expect(
            envelope.result.causeCode,
            `${pinCase.label} ${route.name}`,
          ).toBe("DOMAIN_PIN_KERNEL_PIN_UNREADABLE");
          expect(
            envelope.result.outcome,
            `${pinCase.label} ${route.name}`,
          ).toBe("refused");
          expect(
            envelope.result.transactionState,
            `${pinCase.label} ${route.name}`,
          ).toBe("unchanged");
          expect(envelope.message, `${pinCase.label} ${route.name}`).toContain(
            pinCase.expectedMessage,
          );
          expect(envelope.message, `${pinCase.label} ${route.name}`).toContain(
            restoreRepair,
          );
          expect(
            existsSync(
              join(
                stateHome,
                "my-agent-dojo",
                "bun-typescript-template",
                "state",
              ),
            ),
            `${pinCase.label} ${route.name} must not open state`,
          ).toBe(false);
        }
      }
    },
    processWatchdog(3),
  );

  test.skipIf(process.getuid?.() === 0)(
    "pin plan refuses DOMAIN_PIN_UNREADABLE_FILE when .changeset/config.json is unreadable",
    async () => {
      const repo = fixture.freshRepository("pin-cli-refusals-chmod-repo-");
      const configPath = join(repo, ".changeset", "config.json");
      const stateHome = folder("pin-cli-refusals-chmod-state-");
      chmodSync(configPath, 0o000);
      try {
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
        expect(run.stderr).toBe("");
        const envelope = JSON.parse(run.stdout) as PinEnvelope;
        expect(run.exitCode).toBe(3);
        expect(envelope.result.commandIdentity).toBe(pinPlanIdentity);
        expect(envelope.result.causeCode).toBe("DOMAIN_PIN_UNREADABLE_FILE");
        expect(envelope.result.outcome).toBe("refused");
        expect(envelope.result.transactionState).toBe("unchanged");
        expect(envelope.message).toContain(".changeset/config.json");
      } finally {
        chmodSync(configPath, 0o644);
      }
    },
    processWatchdog(2),
  );
});
