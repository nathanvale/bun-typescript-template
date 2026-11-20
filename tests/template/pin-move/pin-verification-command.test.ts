import { describe, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { KernelRefusal } from "../../../src/kernel-reader.ts";
import { PinRefusal, pinBranchCommit } from "../../../scripts/pin-move.ts";
import {
  argumentsOf,
  main,
  verifyKernelPin,
} from "../../../scripts/pin-verification.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import {
  absentCommit,
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
  templateCommitHoldingS5,
} from "../../support/kernel-sibling.ts";
import { withEnvironment } from "../../support/kernel-row-fixture.ts";
import { pinnedTemplate } from "../../support/kernel-trial-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import { templateCopy } from "../../support/template-copy.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const written = streamWrites();
const usage =
  "Usage: bun run pin-verification [--kernel <path to the kernel repository>]\n";

function pinnedAt(commit: string): string {
  return pinnedTemplate(
    folder("pin-verification-template-"),
    commit,
    pin.carryOutIdentity,
  );
}

function isolated<Result>(work: () => Result): Promise<Result> {
  return withEnvironment(gitEnv, () => Promise.resolve().then(work));
}

function refusalOf(root: string, kernel: string) {
  return isolated(() => {
    try {
      return verifyKernelPin(root, kernel);
    } catch (error) {
      if (error instanceof PinRefusal || error instanceof KernelRefusal)
        return { code: error.code, message: error.message };
      throw error;
    }
  });
}

function unpushedCommit(): { repository: string; commit: string } {
  const repository = kernelClone(folder("pin-verification-kernel-"));
  const commit = commitOn(repository, [pin.commit], "not pushed");
  moveBranch(repository, "main", commit);
  return { repository, commit };
}

describe("the pin verification command's arguments", () => {
  test.each([
    [[], {}],
    [["--kernel", "/k"], { path: "/k" }],
    [["--kernel"], undefined],
    [["--other", "/k"], undefined],
    [["/k"], undefined],
    [["--kernel", "/k", "more"], undefined],
  ] as const)("%j reads as %j", (argv, expected) => {
    expect(argumentsOf(argv)).toEqual(expected);
  });
});

describe("pin verification of the template's kernel pin", () => {
  test(
    "passes on the template's own kernel pin with the sibling kernel repository",
    async () => {
      const branchCommit = pinBranchCommit(pin);
      expect(await refusalOf(ROOT, siblingKernel())).toBe(
        `Pin verified: ${pin.commit} is reachable from ${branchCommit}, where branch ${pin.branch} points on ${pin.remote}, and has the carry-out commit ${pin.carryOutIdentity} as an ancestor.\n`,
      );
    },
    processWatchdog(1),
  );

  test(
    "fails on a pin that names a commit the pin's branch on its remote cannot reach",
    async () => {
      const { repository, commit } = unpushedCommit();
      const branchCommit = pinBranchCommit(pin);
      expect(await refusalOf(pinnedAt(commit), repository)).toEqual({
        code: "kernel_commit_unreachable",
        message: `Commit ${commit} is not reachable from ${branchCommit}, where branch ${pin.branch} points on the pin's remote, in the git repository at ${repository}. Repair: Give a commit that branch reaches on the pin's remote. Push the commit there first if it is only local.`,
      });
    },
    processWatchdog(1),
  );

  test(
    "fails on a pin that names a commit the kernel repository does not hold",
    async () => {
      const repository = siblingKernel();
      expect(await refusalOf(pinnedAt(absentCommit), repository)).toEqual({
        code: "kernel_commit_missing",
        message: `Commit ${absentCommit} is not in the git repository at ${realpathSync(repository)}. Repair: Give a commit that clone holds with all its files. Fetch one with \`git fetch origin <commit>\`, and in a partial clone also run \`git fetch --refetch --no-filter origin\`. Then run this again.`,
      });
    },
    processWatchdog(1),
  );

  test(
    "fails on a pin that names a commit before the carry-out commit, which the pin's branch reaches through the carried history",
    async () => {
      const repository = siblingKernel();
      expect(
        await refusalOf(pinnedAt(templateCommitHoldingS5), repository),
      ).toEqual({
        code: "kernel_commit_before_carry_out",
        message: `Commit ${templateCommitHoldingS5} does not have the carry-out commit ${pin.carryOutIdentity} as an ancestor in the git repository at ${repository}. Repair: Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.`,
      });
    },
    processWatchdog(1),
  );

  test(
    "in process, the command exits 1 on a refusal and prints its code, 0 on a pass, and 2 with its usage on arguments it cannot read",
    async () => {
      const stdout = written(process.stdout);
      const stderr = written(process.stderr);
      const kernel = siblingKernel();
      const exits = await isolated(() => [
        main(["--kernel", kernel], pinnedAt(templateCommitHoldingS5)),
        main(["--kernel", kernel], ROOT),
        main(["--kernel"], ROOT),
      ]);
      expect(exits).toEqual([1, 0, 2]);
      expect(stdout()).toStartWith(`Pin verified: ${pin.commit} `);
      expect(stderr()).toStartWith(
        `kernel_commit_before_carry_out: Commit ${templateCommitHoldingS5} `,
      );
      expect(stderr()).toEndWith(usage);
    },
    processWatchdog(2),
  );
});

describe("the pin verification command", () => {
  function pinVerification(copy: string, args: readonly string[]) {
    return spawnBounded(
      [process.execPath, join(copy, "scripts/pin-verification.ts"), ...args],
      { cwd: copy, env: { ...inherited(), ...gitEnv } },
    );
  }

  test(
    "fails a template whose pin names a commit before the carry-out commit, and passes the template's own pin",
    async () => {
      const copy = templateCopy(folder("pin-verification-command-"));
      pinnedTemplate(copy, templateCommitHoldingS5, pin.carryOutIdentity);
      const before = await pinVerification(copy, ["--kernel", siblingKernel()]);
      expect({ exit: before.exit, stdout: before.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(before.stderr).toStartWith(
        `kernel_commit_before_carry_out: Commit ${templateCommitHoldingS5} does not have the carry-out commit ${pin.carryOutIdentity} as an ancestor`,
      );
      pinnedTemplate(copy, pin.commit, pin.carryOutIdentity);
      const own = await pinVerification(copy, ["--kernel", siblingKernel()]);
      expect({ exit: own.exit, stderr: own.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(own.stdout).toStartWith(`Pin verified: ${pin.commit} `);
    },
    processWatchdog(2),
  );

  test(
    "with an argument it cannot read prints its usage and exits 2",
    async () => {
      const copy = templateCopy(folder("pin-verification-command-"));
      expect(await pinVerification(copy, ["--kernel"])).toEqual({
        exit: 2,
        stdout: "",
        stderr: usage,
      });
    },
    processWatchdog(1),
  );
});
