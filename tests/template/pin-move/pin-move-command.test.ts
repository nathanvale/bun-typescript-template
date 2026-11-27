import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { startChild } from "../../../scripts/process-runner.ts";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { commitObjects } from "../../support/git-object-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
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
  processAlive,
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const folder = ownedFolders();
const { carryOutIdentity } = readKernelPin(ROOT);

function copyPinnedAt(commit: string): string {
  const copy = templateCopy(folder("pin-move-command-"), [KERNEL_LOCKFILE]);
  pinnedTemplate(copy, commit, carryOutIdentity);
  if (!existsSync(join(copy, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
    writeFileSync(join(copy, ".git", "info", "exclude"), "node_modules\n");
  }
  git(copy, "commit", "--quiet", "--all", "--allow-empty", "-m", "pin it");
  return copy;
}

function pinMove(copy: string, args: readonly string[], bound?: number) {
  const stateHome = folder("pin-move-state-");
  return spawnBounded(
    [process.execPath, join(copy, "src/cli.ts"), "pin", "move", ...args],
    {
      cwd: copy,
      env: { ...inherited(), ...gitEnv, XDG_STATE_HOME: stateHome },
      ...(bound === undefined ? {} : { boundMilliseconds: bound }),
    },
  );
}

describe("the pin move command", () => {
  test(
    "with no commit refuses with exit 2",
    async () => {
      const run = await pinMove(copyPinnedAt(trialBase), []);
      expect({ exit: run.exit, stdout: run.stdout }).toEqual({
        exit: 2,
        stdout: "",
      });
      expect(run.stderr).not.toBe("");
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
        "--json",
      ]);
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      const envelope = JSON.parse(run.stdout) as {
        readonly message: string;
        readonly result: { readonly causeCode: string };
      };
      expect(envelope.result.causeCode).toBe(
        "DOMAIN_PIN_KERNEL_COMMIT_UNREACHABLE",
      );
      expect(envelope.message).toStartWith(
        `Commit ${unpushed} is not reachable from `,
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
        "--json",
      ]);
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      const envelope = JSON.parse(run.stdout) as {
        readonly message: string;
        readonly result: { readonly causeCode: string };
      };
      expect(envelope.result.causeCode).toBe(
        "DOMAIN_PIN_KERNEL_COMMIT_BEFORE_CARRY_OUT",
      );
      expect(envelope.message).toStartWith(
        `Commit ${commit} does not have the carry-out commit`,
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
      expect(run.stdout).toContain(
        `Pin move report: ${trialBase} to ${trialBase} Written in the template, kernel lockfile first and pin last (1):   ${KERNEL_LOCKFILE} Kernel files added (0): Kernel files changed (0): Kernel files removed (0): Kernel log (0):`,
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
      expect(again.stdout).toContain(
        `Pin move report: ${trialBase} to ${trialBase} Written in the template, kernel lockfile first and pin last (0):`,
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
      const script = `const { withStopSignals } = await import(${JSON.stringify(join(ROOT, "src/pin-move.ts"))});
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

  test(
    "refuses a malformed kernel changeset with its DOMAIN_PIN_CHANGESET_INVALID cause and repair line",
    async () => {
      const kernelRepo = kernelClone(
        folder("pin-move-command-bad-changeset-kernel-"),
        trialBase,
      );
      git(kernelRepo, "read-tree", trialBase);
      const badCommit = commitObjects(kernelRepo, "add malformed changeset", [
        {
          path: ".changeset/2026-11-24-broken.md",
          bytes: "missing frontmatter\n",
        },
      ]);
      moveBranch(kernelRepo, "main", badCommit);
      const remoteBin = folder("pin-move-command-bad-changeset-bin-");
      mkdirSync(remoteBin, { recursive: true });
      gitReadingRemoteAs(remoteBin, readKernelPin(ROOT).remote, kernelRepo);

      const generatedRepo = folder("pin-move-command-bad-changeset-repo-");
      initRepository(generatedRepo);
      const pinSpecifier = `git+${pathToFileURL(realpathSync(kernelRepo)).href}#${trialBase}`;
      commitIn(generatedRepo, "initial pin", {
        "package.json": `${JSON.stringify(
          {
            name: "bad-changeset-fixture",
            dependencies: { "agent-cli-kernel": pinSpecifier },
          },
          null,
          2,
        )}\n`,
      });
      const stateHome = folder("pin-move-state-");

      const run = await spawnBounded(
        [
          process.execPath,
          join(ROOT, "src/cli.ts"),
          "pin",
          "plan",
          badCommit,
          "--kernel",
          kernelRepo,
          "--repository",
          generatedRepo,
          "--json",
        ],
        {
          cwd: ROOT,
          env: {
            ...inherited(),
            ...gitEnv,
            XDG_STATE_HOME: stateHome,
            PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}`,
          },
        },
      );
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 3,
        stderr: "",
      });
      const envelope = JSON.parse(run.stdout) as {
        readonly message: string;
        readonly result: { readonly causeCode: string };
      };
      expect(envelope.result.causeCode).toBe("DOMAIN_PIN_CHANGESET_INVALID");
      expect(envelope.message).toContain("Repair: ");
    },
    processWatchdog(1),
  );
});
