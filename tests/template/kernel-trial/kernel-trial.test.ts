import { describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  type TrialActive,
  TrialRefusal,
  trialStep,
} from "../../../scripts/kernel-trial.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { bootstrapRow, withEnvironment } from "../../support/recipe-fixture.ts";
import { kernelClone, trialBase } from "../../support/kernel-sibling.ts";
import {
  oneDependencyChanged,
  kernelTrials,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import {
  processAlive,
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";
import { callInCopy, templateCopy } from "../../support/template-copy.ts";

const folder = ownedFolders();
const { trialOf, trialEnv } = kernelTrials();
const stopRepair =
  "Nothing was written, and nothing is wrong with the kernel commit. Run the kernel trial, or the pin move, again when it can run to its end.";
const text = (bytes: Uint8Array) => Buffer.from(bytes).toString("utf8");

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
          trialEnv(),
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
    "the template's kernel lockfile installs frozen, unchanged, and passes the check command, pointer skill check included, in a repository Bootstrap's command line makes at the pinned commit",
    async () => {
      const work = folder("kernel-lockfile-");
      const destination = join(work, "made");
      const { commit } = readKernelPin(ROOT);
      const env = { ...inherited(), ...gitEnv };
      const made = await spawnBounded(
        [
          process.execPath,
          "run",
          "src/bootstrap.ts",
          "--destination",
          destination,
          "--source-packet",
          "/abs/packets/demo",
          "--json",
        ],
        { cwd: ROOT, env, processGroup: true },
      );
      expect({ exit: made.exit, stderr: made.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(
        readFileSync(
          join(destination, ".claude/skills/agent-cli-kernel/SKILL.md"),
          "utf8",
        ),
      ).toContain(`\nPinned commit: \`${commit}\`\n`);
      const committed = readFileSync(join(ROOT, KERNEL_LOCKFILE), "utf8");
      const install = await spawnBounded(
        [process.execPath, "install", "--frozen-lockfile"],
        {
          cwd: destination,
          env,
          boundMilliseconds: 120_000,
          processGroup: true,
        },
      );
      const check = await spawnBounded([process.execPath, "run", "check"], {
        cwd: destination,
        env,
        boundMilliseconds: 240_000,
        processGroup: true,
      });
      expect({
        install: install.exit,
        lockfile:
          readFileSync(join(destination, "bun.lock"), "utf8") === committed,
        check: check.exit,
      }).toEqual({ install: 0, lockfile: true, check: 0 });
      const pointer = await spawnBounded(
        [process.execPath, "test", "tests/pointer-skills.test.ts"],
        { cwd: destination, env, processGroup: true },
      );
      expect({
        exit: pointer.exit,
        ran: /\n [1-9]\d* pass\n 0 fail\n/.test(pointer.stderr),
      }).toEqual({ exit: 0, ran: true });
    },
    trialTimeout(1),
  );

  test(
    "is refused at the check command for a kernel commit without the full skill the pointer skill names, the commit before the author skill landed",
    async () => {
      const work = folder("kernel-trial-");
      const commit = "0b64b0e480a77ae6abbd3e671497354309182b42";
      const refusal = await refusalOf(
        trialOf(join(work, "trial"), {
          repository: kernelClone(work, trialBase),
          commit,
        }),
      );
      expect(refusal).toMatchObject({ code: "trial_failed" });
      const { message } = refusal as { message: string };
      expect(message).toStartWith(
        `The kernel trial's check command in ${join(work, "trial/second")} exited 1. Its `,
      );
      expect(message).toContain(
        `.agents/skills/agent-cli-kernel/SKILL.md names node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md, which the installed kernel at ${commit} does not hold.`,
      );
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
          trialEnv(),
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

describe("kernel trials of test kernel repositories", () => {
  test(
    "leave the developer's own Bun cache as it was",
    async () => {
      const work = folder("kernel-trial-");
      const own = folder("bun-cache-own-");
      await withEnvironment({ BUN_INSTALL_CACHE_DIR: own }, () =>
        trialOf(join(work, "trial"), {
          repository: kernelClone(work, trialBase),
          commit: trialBase,
        }),
      );
      expect(readdirSync(own)).toEqual([]);
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

const stepRepair =
  "Repair: Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.";

function failedStep(work: string, shown: string): string {
  return `The kernel trial's check command in ${work} exited 1. ${shown}\n ${stepRepair}`;
}

function stepRefusal(work: string, lines: readonly string[]) {
  const script = `process.stderr.write(${JSON.stringify(lines.join("\n"))}); process.exit(1);`;
  return refusalOf(trialStep(work, "check command", ["-e", script], 10_000));
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
        code: "trial_stopped",
        message: `The kernel trial's held step in ${work} was stopped by SIGTERM. Repair: ${stopRepair}`,
      });
      expect(processAlive(pid)).toBe(false);
    },
    processWatchdog(2),
  );

  test(
    "that fails keeps each failing test's own lines in its refusal, wherever they come in the output, and its last lines",
    async () => {
      const work = folder("kernel-trial-step-");
      const first = [
        "error: expect(received).toEqual(expected)",
        '+   "the diagnostic a person needs",',
        "(fail) the test that failed first",
      ];
      const second = [
        "error: expect(received).toBe(expected)",
        '+   "the second diagnostic",',
        "(fail) the test that failed second",
      ];
      const later = Array.from(
        { length: 30 },
        (_, line) => `later line ${line}`,
      );
      expect(
        await stepRefusal(work, [
          ...first,
          "(pass) a test between them",
          ...second,
          ...later,
        ]),
      ).toEqual({
        code: "trial_failed",
        message: failedStep(
          work,
          `Its failing tests:\n${[...first, ...second].join("\n")}\nIts last lines:\n${later.slice(-20).join("\n")}`,
        ),
      });
    },
    processWatchdog(1),
  );

  test(
    "that fails keeps a failing test's body diagnostic when its teardown fails too",
    async () => {
      const work = folder("kernel-trial-step-");
      const failing = [
        "error: the body's own diagnostic",
        "      at <anonymous> (tests/a.test.ts:3:5)",
        "error: the afterEach hook's diagnostic",
        "(fail) a test whose body and teardown failed",
      ];
      const refusal = await stepRefusal(work, failing);
      expect(String(Reflect.get(Object(refusal), "message"))).toContain(
        `Its failing tests:\n${failing.join("\n")}\nIts last lines:`,
      );
    },
    processWatchdog(1),
  );

  test(
    "that fails shows at most 30 lines of one failing test, and says how many it left out",
    async () => {
      const work = folder("kernel-trial-step-");
      const diagnostic = Array.from(
        { length: 1_000 },
        (_, line) => `diagnostic line ${line}`,
      );
      const failing = [
        "error: a long one",
        ...diagnostic,
        "(fail) a long test",
      ];
      const refusal = await stepRefusal(work, failing);
      const shown = [
        ...failing.slice(0, 28),
        "(973 more lines of this failing test left out)",
        "(fail) a long test",
      ];
      expect(String(Reflect.get(Object(refusal), "message"))).toContain(
        `Its failing tests:\n${shown.join("\n")}\nIts last lines:`,
      );
    },
    processWatchdog(1),
  );

  test(
    "that fails shows at most 120 lines of failing tests, and says how many tests it left out",
    async () => {
      const work = folder("kernel-trial-step-");
      const blocks = Array.from({ length: 6 }, (_, test) => [
        `error: test ${test}`,
        ...Array.from({ length: 28 }, (_, line) => `test ${test} line ${line}`),
        `(fail) test ${test}`,
      ]);
      const refusal = await stepRefusal(work, blocks.flat());
      expect(String(Reflect.get(Object(refusal), "message"))).toContain(
        `Its failing tests:\n${blocks.slice(0, 4).flat().join("\n")}\n(2 more failing tests left out)\nIts last lines:`,
      );
    },
    processWatchdog(1),
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
      code: "trial_stopped",
      message: `The kernel trial was stopped by SIGINT before its next step in ${work}. Repair: ${stopRepair}`,
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
          env: { ...inherited(), ...gitEnv, ...trialEnv() },
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
