import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { join } from "node:path";
import { main } from "../../../scripts/kernel-trial-command.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { gitEnv, gitOutput, inherited } from "../../support/git-fixture.ts";
import {
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
  trialBase,
} from "../../support/kernel-sibling.ts";
import { trialTimeout } from "../../support/kernel-trial-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const folder = ownedFolders();
const absentCommit = "0123456789abcdef0123456789abcdef01234567";
const usage =
  "Usage: bun run kernel-trial <full kernel commit> [--kernel <path to the kernel repository>]\n";

const spies: { mockRestore(): void }[] = [];

function written(stream: NodeJS.WriteStream): () => string {
  const spy = spyOn(stream, "write").mockImplementation(() => true);
  spies.push(spy);
  return () => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

function kernelTrialCommand(
  copy: string,
  args: readonly string[],
  bound?: number,
) {
  return spawnBounded(
    [process.execPath, join(copy, "scripts/kernel-trial-command.ts"), ...args],
    {
      cwd: copy,
      env: { ...inherited(), ...gitEnv },
      ...(bound === undefined ? {} : { boundMilliseconds: bound }),
    },
  );
}

describe("the kernel trial command", () => {
  test(
    "in process, exits 2 with its usage on arguments it cannot read, and 1 with the kernel reader's code on a commit the kernel repository does not hold",
    async () => {
      const stderr = written(process.stderr);
      const exits = [
        await main([], ROOT),
        await main([absentCommit, "--kernel", siblingKernel()], ROOT),
      ];
      expect(exits).toEqual([2, 1]);
      expect(stderr()).toStartWith(
        `${usage}kernel_commit_missing: Commit ${absentCommit} `,
      );
    },
    processWatchdog(1),
  );

  test(
    "with no commit prints its usage and exits 2",
    async () => {
      const copy = templateCopy(folder("kernel-trial-command-"));
      expect(await kernelTrialCommand(copy, [])).toEqual({
        exit: 2,
        stdout: "",
        stderr: usage,
      });
    },
    processWatchdog(1),
  );

  test(
    "fails a commit the kernel pin's remote does not serve at its install, and exits 1 with the trial's code",
    async () => {
      const repository = kernelClone(
        folder("kernel-trial-command-kernel-"),
        trialBase,
      );
      const unpushed = commitOn(repository, [trialBase], "not pushed");
      moveBranch(repository, "main", unpushed);
      const copy = templateCopy(folder("kernel-trial-command-"));
      const run = await kernelTrialCommand(
        copy,
        [unpushed, "--kernel", repository],
        trialTimeout(1) - 10_000,
      );
      expect({ exit: run.exit, stdout: run.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(run.stderr).toStartWith(
        "trial_failed: The kernel trial's install in ",
      );
    },
    trialTimeout(1),
  );

  test(
    "passes a kernel commit installed from the kernel pin's remote, and changes nothing in the template",
    async () => {
      const copy = templateCopy(folder("kernel-trial-command-"));
      const run = await kernelTrialCommand(
        copy,
        [trialBase, "--kernel", siblingKernel()],
        trialTimeout(1) - 10_000,
      );
      expect(run).toEqual({
        exit: 0,
        stdout: `Kernel trial passed: ${trialBase}.\n`,
        stderr: "",
      });
      expect(
        gitOutput(copy, "status", "--porcelain", "--untracked-files=all"),
      ).toBe("");
    },
    trialTimeout(1),
  );
});
