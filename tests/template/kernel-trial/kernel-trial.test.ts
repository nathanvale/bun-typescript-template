import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  kernelTrial,
  type TrialActive,
  TrialRefusal,
  trialStep,
} from "../../../scripts/kernel-trial.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  git,
  gitEnv,
  gitOutput,
  inherited,
} from "../../support/git-fixture.ts";
import {
  bootstrapRow,
  withIsolatedGit,
} from "../../support/kernel-row-fixture.ts";
import {
  kernelClone,
  siblingKernel,
  trialBase,
} from "../../support/kernel-sibling.ts";
import {
  oneDependencyChanged,
  trialOf,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import {
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";
import { callInCopy, templateCopy } from "../../support/template-copy.ts";

const folder = ownedFolders();
const repair =
  "Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.";
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

function templateState() {
  return {
    status: gitOutput(ROOT, "status", "--porcelain", "--untracked-files=all"),
    diff: gitOutput(ROOT, "diff", "HEAD"),
  };
}

function changedFiles(copy: string): string {
  return git(copy, "status", "--porcelain", "--untracked-files=all");
}

async function refusalOf(work: Promise<unknown>) {
  try {
    await work;
  } catch (error) {
    if (error instanceof TrialRefusal)
      return { code: error.code, message: error.message };
    throw error;
  }
  return "no refusal";
}

describe("the kernel trial", () => {
  test(
    "with no kernel lockfile in the template, makes one in its own folder, confirms it, and passes a frozen install and the check command in a fresh repository given those exact bytes, writing nothing in the template",
    async () => {
      const work = folder("kernel-trial-");
      const copy = templateCopy(work, [KERNEL_LOCKFILE]);
      const repository = kernelClone(work, trialBase);
      const trial = join(work, "trial");
      expect([
        existsSync(join(copy, KERNEL_LOCKFILE)),
        changedFiles(copy),
      ]).toEqual([false, ""]);
      expect(
        await callInCopy(
          copy,
          "scripts/kernel-trial.ts",
          "kernelTrial",
          {
            kernel: { repository, commit: trialBase },
            folder: trial,
            kernelFrom: "clone",
          },
          trialTimeout(1) - 10_000,
        ),
      ).toMatchObject({
        returned: { kernel: { repository, commit: trialBase } },
      });
      const made = readFileSync(join(trial, "first/bun.lock"));
      expect(readFileSync(join(trial, "second/bun.lock"))).toEqual(made);
      expect(text(made)).toContain(`#${trialBase}`);
      expect(
        existsSync(join(trial, "second/node_modules/agent-cli-kernel")),
      ).toBe(true);
      expect([
        existsSync(join(copy, KERNEL_LOCKFILE)),
        changedFiles(copy),
      ]).toEqual([false, ""]);
    },
    trialTimeout(1),
  );

  test(
    "of the pinned commit, installed from GitHub, qualifies the template's kernel lockfile and leaves the template as it was",
    async () => {
      const pin = readKernelPin(ROOT);
      const before = templateState();
      const passed = await withIsolatedGit(() =>
        kernelTrial({
          kernel: { repository: siblingKernel(), commit: pin.commit },
          folder: join(folder("kernel-trial-"), "trial"),
        }),
      );
      expect(text(passed.lockfile)).toBe(
        readFileSync(join(ROOT, KERNEL_LOCKFILE), "utf8"),
      );
      expect(templateState()).toEqual(before);
    },
    trialTimeout(1),
  );

  test(
    "of a test kernel repository whose one dependency changes, yields a different lockfile, and qualifies the frozen install with the new bytes",
    async () => {
      const work = folder("kernel-trial-");
      const repository = kernelClone(work, trialBase);
      const changed = oneDependencyChanged(repository, trialBase);
      const before = await trialOf(join(work, "before"), {
        repository,
        commit: trialBase,
      });
      const after = await trialOf(join(work, "after"), {
        repository,
        commit: changed,
      });
      expect([
        text(before.lockfile).includes('"@logtape/redaction@2.4.2"'),
        text(after.lockfile).includes('"@logtape/redaction@2.4.1"'),
        Buffer.from(after.lockfile).equals(Buffer.from(before.lockfile)),
      ]).toEqual([true, true, false]);
      expect(readFileSync(join(work, "after/second/bun.lock"), "utf8")).toBe(
        text(after.lockfile),
      );
    },
    trialTimeout(2),
  );

  test(
    "is refused at the check command for a kernel commit that exports nothing, the carry-out commit",
    async () => {
      const work = folder("kernel-trial-");
      const commit = readKernelPin(ROOT).carryOutIdentity;
      const refusal = await refusalOf(
        trialOf(join(work, "trial"), {
          repository: kernelClone(work, trialBase),
          commit,
        }),
      );
      expect(refusal).toMatchObject({ code: "trial_failed" });
      const { message } = refusal as { message: string };
      expect(message).toStartWith(
        `The kernel trial's check command in ${join(work, "trial/second")} exited 2. Its last lines:\n`,
      );
      expect(message).toContain("node_modules/agent-cli-kernel/lint");
      expect(message).toEndWith(
        "Repair: Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.",
      );
    },
    trialTimeout(1),
  );

  test(
    "is refused when its install makes no lockfile",
    async () => {
      const work = folder("kernel-trial-");
      const copy = templateCopy(work);
      appendFileSync(
        join(copy, "generated-repository/settings/bunfig.toml"),
        "\n[install.lockfile]\nsave = false\n",
      );
      const trial = join(work, "trial");
      expect(
        await callInCopy(
          copy,
          "scripts/kernel-trial.ts",
          "kernelTrial",
          {
            kernel: {
              repository: kernelClone(work, trialBase),
              commit: trialBase,
            },
            folder: trial,
            kernelFrom: "clone",
          },
          trialTimeout(1) - 10_000,
        ),
      ).toEqual({
        refused: {
          code: "trial_failed",
          message: `The kernel trial's install in ${join(trial, "first")} made no lockfile. Repair: Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.`,
        },
      });
    },
    trialTimeout(1),
  );
});

describe("a kernel trial whose caller changes the seam while it runs", () => {
  test(
    "records the commit it tried, and qualifies that commit's lockfile",
    async () => {
      const work = folder("kernel-trial-");
      const kernel = {
        repository: kernelClone(work, trialBase),
        commit: trialBase,
      };
      const running = trialOf(join(work, "trial"), kernel);
      kernel.commit = readKernelPin(ROOT).carryOutIdentity;
      const passed = await running;
      expect([
        passed.kernel.commit,
        text(passed.lockfile).includes(`#${trialBase}`),
      ]).toEqual([trialBase, true]);
    },
    trialTimeout(1),
  );
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("a kernel trial step", () => {
  test(
    "that its caller stops is stopped with its process, and refused as stopped",
    async () => {
      const work = folder("kernel-trial-step-");
      const ledger = join(work, "ledger");
      const pidFile = join(work, "pid");
      const held = `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(ledger)}, "started\\n");
await Bun.sleep(20_000);`;
      const active: TrialActive = {};
      const refused = refusalOf(
        trialStep(work, "held step", ["-e", held], 25_000, active),
      );
      await watchLedger(ledger, "started", 10_000).reached;
      const pid = Number(readFileSync(pidFile, "utf8"));
      active.stoppedBy = "SIGTERM";
      active.stop?.();
      expect(await refused).toEqual({
        code: "trial_failed",
        message: `The kernel trial's held step in ${work} was stopped by SIGTERM. Repair: ${repair}`,
      });
      expect(alive(pid)).toBe(false);
    },
    processWatchdog(2),
  );

  test("after a stop, starts no further step", async () => {
    const work = folder("kernel-trial-step-");
    expect(
      await refusalOf(
        trialStep(work, "next step", ["-e", "process.exit(0)"], 10_000, {
          stoppedBy: "SIGINT",
        }),
      ),
    ).toEqual({
      code: "trial_failed",
      message: `The kernel trial was stopped by SIGINT before its next step in ${work}. Repair: ${repair}`,
    });
  });

  test(
    "that outlives its bound is stopped at the bound and refused",
    async () => {
      const work = folder("kernel-trial-step-");
      const started = performance.now();
      const refusal = await refusalOf(
        trialStep(work, "slow step", ["-e", "await Bun.sleep(10_000)"], 300),
      );
      const elapsed = performance.now() - started;
      expect(refusal).toEqual({
        code: "trial_failed",
        message: `The kernel trial's slow step in ${work} did not finish within 300 ms. Its last lines:\n\n Repair: Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.`,
      });
      expect([elapsed >= 300, elapsed < 1_000]).toEqual([true, true]);
    },
    processWatchdog(1),
  );
});

describe("a generated repository whose Pin and kernel lockfile name different commits", () => {
  test(
    "is refused by its frozen install, so its installed kernel cannot differ from the commit the kernel lockfile names",
    async () => {
      const work = folder("kernel-trial-");
      const repository = kernelClone(work, trialBase);
      const { lockfile } = await trialOf(join(work, "trial"), {
        repository,
        commit: trialBase,
      });
      const destination = join(work, "moved");
      await bootstrapRow({
        destination,
        sourcePacket: "/abs/packets/demo",
        kernel: {
          repository,
          commit: oneDependencyChanged(repository, trialBase),
        },
        kernelFrom: "clone",
        lockfile,
      });
      const install = await spawnBounded(
        [process.execPath, "install", "--frozen-lockfile"],
        {
          cwd: destination,
          env: { ...inherited(), ...gitEnv },
          boundMilliseconds: 60_000,
          processGroup: true,
        },
      );
      expect({
        exit: install.exit,
        frozen: install.stderr.includes(
          "lockfile had changes, but lockfile is frozen",
        ),
      }).toEqual({ exit: 1, frozen: true });
    },
    trialTimeout(1) + 60_000,
  );
});
