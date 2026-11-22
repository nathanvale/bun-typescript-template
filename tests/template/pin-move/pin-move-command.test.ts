import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import { argumentsOf } from "../../../scripts/pin-move.ts";
import { startChild } from "../../../scripts/process-runner.ts";
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
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
  templateCommitHoldingS5,
  trialBase,
} from "../../support/kernel-sibling.ts";
import {
  pinnedTemplate,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import {
  processWatchdog,
  spawnBounded,
  processAlive,
  watchLedger,
} from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const folder = ownedFolders();
const { carryOutIdentity } = readKernelPin(ROOT);

function copyPinnedAt(commit: string): string {
  const copy = templateCopy(folder("pin-move-command-"), [KERNEL_LOCKFILE]);
  pinnedTemplate(copy, commit, carryOutIdentity);
  git(copy, "commit", "--quiet", "--all", "--allow-empty", "-m", "pin it");
  return copy;
}

function pinMove(copy: string, args: readonly string[], bound?: number) {
  return spawnBounded(
    [process.execPath, join(copy, "scripts/pin-move.ts"), ...args],
    {
      cwd: copy,
      env: { ...inherited(), ...gitEnv },
      ...(bound === undefined ? {} : { boundMilliseconds: bound }),
    },
  );
}

describe("the pin move command's arguments", () => {
  test.each([
    [[], undefined],
    [["c"], { commit: "c" }],
    [["c", "--kernel", "/k"], { commit: "c", path: "/k" }],
    [["c", "--kernel"], undefined],
    [["c", "--other", "/k"], undefined],
    [["c", "--kernel", "/k", "more"], undefined],
    [["c", "--repository", "/r"], { commit: "c", repository: "/r" }],
    [
      ["c", "--repository", "/r", "--plan"],
      { commit: "c", repository: "/r", plan: true },
    ],
    [
      ["c", "--kernel", "/k", "--repository", "/r"],
      { commit: "c", path: "/k", repository: "/r" },
    ],
    [["c", "--plan"], undefined],
    [["c", "--repository"], undefined],
    [["c", "--repository", "--plan"], undefined],
    [["c", "--repository", "/r", "--repository", "/r2"], undefined],
  ] as const)("%j reads as %j", (argv, expected) => {
    expect(argumentsOf(argv)).toEqual(expected);
  });
});

describe("the pin move command", () => {
  test(
    "with no commit prints its usage and exits 2",
    async () => {
      expect(await pinMove(copyPinnedAt(trialBase), [])).toEqual({
        exit: 2,
        stdout: "",
        stderr:
          "Usage: bun run pin-move <full kernel commit> [--kernel <path to the kernel repository>] [--repository <path to a generated repository>] [--plan]\n",
      });
    },
    processWatchdog(1),
  );

  test(
    "refuses a commit that only a local clone's own branch reaches, checked against the pin's remote, before any trial",
    async () => {
      const repository = kernelClone(
        folder("pin-move-command-kernel-"),
        trialBase,
      );
      const unpushed = commitOn(repository, [trialBase], "not pushed");
      moveBranch(repository, "main", unpushed);
      const run = await pinMove(copyPinnedAt(trialBase), [
        unpushed,
        "--kernel",
        repository,
      ]);
      expect({ exit: run.exit, stdout: run.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(run.stderr).toStartWith(
        `kernel_commit_unreachable: Commit ${unpushed} is not reachable from `,
      );
    },
    processWatchdog(1),
  );

  test(
    "refuses a commit before the carry-out with its code, before any trial",
    async () => {
      const commit = templateCommitHoldingS5;
      const run = await pinMove(copyPinnedAt(trialBase), [
        commit,
        "--kernel",
        siblingKernel(),
      ]);
      expect({ exit: run.exit, stdout: run.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(run.stderr).toStartWith(
        `kernel_commit_before_carry_out: Commit ${commit} does not have the carry-out commit`,
      );
    },
    processWatchdog(1),
  );

  test(
    "run at the pinned commit on a template with no lockfile, writes the lockfile from a kernel trial that installs from GitHub, leaves the pin unchanged, prints the pin move report, and run again writes nothing",
    async () => {
      const copy = copyPinnedAt(trialBase);
      const pin = readFileSync(join(copy, kernelPinFile), "utf8");
      const run = await pinMove(
        copy,
        [trialBase, "--kernel", siblingKernel()],
        trialTimeout(1) - 10_000,
      );
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(run.stdout).toBe(
        `Pin move report: ${trialBase} to ${trialBase}\nWritten in the template, kernel lockfile first and pin last (1):\n  ${KERNEL_LOCKFILE}\nKernel files added (0):\nKernel files changed (0):\nKernel files removed (0):\nKernel log (0):\n`,
      );
      expect(
        gitOutput(copy, "status", "--porcelain", "--untracked-files=all"),
      ).toBe(`?? ${KERNEL_LOCKFILE}\n`);
      expect(readFileSync(join(copy, kernelPinFile), "utf8")).toBe(pin);
      expect(readFileSync(join(copy, KERNEL_LOCKFILE), "utf8")).toContain(
        `"agent-cli-kernel": "github:nathanvale/agent-cli-kernel#${trialBase}"`,
      );
      const again = await pinMove(
        copy,
        [trialBase, "--kernel", siblingKernel()],
        trialTimeout(1) - 10_000,
      );
      expect(again.exit).toBe(0);
      expect(again.stdout).toStartWith(
        `Pin move report: ${trialBase} to ${trialBase}\nWritten in the template, kernel lockfile first and pin last (0):\n`,
      );
      expect(
        gitOutput(copy, "status", "--porcelain", "--untracked-files=all"),
      ).toBe(`?? ${KERNEL_LOCKFILE}\n`);
    },
    trialTimeout(2),
  );

  test(
    "stops its running trial step when SIGTERM reaches it, and refuses as stopped",
    async () => {
      const work = folder("pin-move-signal-");
      const ledger = join(work, "ledger");
      const pidFile = join(work, "pid");
      const held = `const { writeFileSync } = require("node:fs");
writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
writeFileSync(${JSON.stringify(ledger)}, "started\\n");
await Bun.sleep(30_000);`;
      const script = `const { withStopSignals } = await import(${JSON.stringify(join(ROOT, "scripts/pin-move.ts"))});
const { trialStep } = await import(${JSON.stringify(join(ROOT, "scripts/kernel-trial.ts"))});
const active = {};
try {
  await withStopSignals(active, () => trialStep(${JSON.stringify(work)}, "held step", ["-e", ${JSON.stringify(held)}], 40_000, active));
  process.stdout.write("no refusal");
} catch (error) {
  process.stdout.write(JSON.stringify({ code: error.code, message: error.message }));
}`;
      const command = startChild([process.execPath, "--eval", script], {
        cwd: work,
        limitMilliseconds: 50_000,
      });
      const started = watchLedger(ledger, "started", 20_000);
      try {
        const first = await Promise.race([
          started.reached.then(() => "started"),
          command.finished.then(
            (run) => `exited ${run.exitCode}: ${run.stderr}`,
          ),
        ]);
        expect(first).toBe("started");
        const pid = Number(readFileSync(pidFile, "utf8"));
        command.signal("SIGTERM");
        const run = await command.finished;
        expect({
          exit: run.exitCode,
          refusal: JSON.parse(run.stdout) as unknown,
        }).toEqual({
          exit: 0,
          refusal: {
            code: "trial_stopped",
            message: `The kernel trial's held step in ${work} was stopped by SIGTERM. Repair: Nothing was written, and nothing is wrong with the kernel commit. Run the kernel trial, or the pin move, again when it can run to its end.`,
          },
        });
        expect(processAlive(pid)).toBe(false);
      } finally {
        started.stop();
        command.stop();
        await command.finished;
      }
    },
    processWatchdog(3),
  );
});
