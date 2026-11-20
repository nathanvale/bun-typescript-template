import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  git,
  gitEnv,
  gitOutput,
  inherited,
} from "../../support/git-fixture.ts";
import { siblingKernel, trialBase } from "../../support/kernel-sibling.ts";
import {
  pinnedTemplate,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
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

describe("the pin move command", () => {
  test(
    "with no commit prints its usage and exits 2",
    async () => {
      expect(await pinMove(copyPinnedAt(trialBase), [])).toEqual({
        exit: 2,
        stdout: "",
        stderr:
          "Usage: bun run pin-move <full kernel commit> [--kernel <path to the kernel repository>]\n",
      });
    },
    processWatchdog(1),
  );

  test(
    "refuses a commit before the carry-out with its code, before any trial",
    async () => {
      const commit = "77ebdeafb1f49d0b32307b3ead7273d265ad4918";
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
    "run at the pinned commit on a template with no lockfile, writes the lockfile from a kernel trial that installs from GitHub, leaves the pin unchanged, and prints the pin move report",
    async () => {
      const copy = copyPinnedAt(trialBase);
      const pin = readFileSync(join(copy, "kernel-pin.json"), "utf8");
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
      expect(readFileSync(join(copy, "kernel-pin.json"), "utf8")).toBe(pin);
      expect(readFileSync(join(copy, KERNEL_LOCKFILE), "utf8")).toContain(
        `"agent-cli-kernel": "github:nathanvale/agent-cli-kernel#${trialBase}"`,
      );
    },
    trialTimeout(1),
  );
});
