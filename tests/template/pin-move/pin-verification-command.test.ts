import { afterEach, describe, expect, spyOn, test } from "bun:test";
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
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
} from "../../support/kernel-sibling.ts";
import { pinnedTemplate } from "../../support/kernel-trial-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const templateCommitHoldingS5 = "77ebdeafb1f49d0b32307b3ead7273d265ad4918";
const absentCommit = "0123456789abcdef0123456789abcdef01234567";
const usage =
  "Usage: bun run pin-verification [--kernel <path to the kernel repository>]\n";

function pinnedAt(commit: string): string {
  return pinnedTemplate(
    folder("pin-verification-template-"),
    commit,
    pin.carryOutIdentity,
  );
}

function refusalOf(root: string, kernel: string) {
  try {
    return verifyKernelPin(root, kernel);
  } catch (error) {
    if (error instanceof PinRefusal || error instanceof KernelRefusal)
      return { code: error.code, message: error.message };
    throw error;
  }
}

function unpushedCommit(): { repository: string; commit: string } {
  const repository = kernelClone(folder("pin-verification-kernel-"));
  const commit = commitOn(repository, [pin.commit], "not pushed");
  moveBranch(repository, "main", commit);
  return { repository, commit };
}

const spies: { mockRestore(): void }[] = [];

function written(stream: NodeJS.WriteStream): () => string {
  const spy = spyOn(stream, "write").mockImplementation(() => true);
  spies.push(spy);
  return () => spy.mock.calls.map(([chunk]) => String(chunk)).join("");
}

afterEach(() => {
  for (const spy of spies.splice(0)) spy.mockRestore();
});

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
    () => {
      const branchCommit = pinBranchCommit(pin);
      expect(refusalOf(ROOT, siblingKernel())).toBe(
        `Pin verified: ${pin.commit} is reachable from ${branchCommit}, where branch ${pin.branch} points on ${pin.remote}, and has the carry-out commit ${pin.carryOutIdentity} as an ancestor.\n`,
      );
    },
    processWatchdog(1),
  );

  test(
    "fails on a pin that names a commit the pin's branch on its remote cannot reach",
    () => {
      const { repository, commit } = unpushedCommit();
      const branchCommit = pinBranchCommit(pin);
      expect(refusalOf(pinnedAt(commit), repository)).toEqual({
        code: "kernel_commit_unreachable",
        message: `Commit ${commit} is not reachable from ${branchCommit}, where branch ${pin.branch} points on the pin's remote, in the git repository at ${repository}. Repair: Give a commit that branch reaches on the pin's remote. Push the commit there first if it is only local.`,
      });
    },
    processWatchdog(1),
  );

  test(
    "fails on a pin that names a commit the kernel repository does not hold",
    () => {
      const refusal = refusalOf(pinnedAt(absentCommit), siblingKernel());
      expect(refusal).toMatchObject({ code: "kernel_commit_missing" });
    },
    processWatchdog(1),
  );

  test(
    "fails on a pin that names a commit before the carry-out commit, which the pin's branch reaches through the carried history",
    () => {
      const repository = siblingKernel();
      expect(refusalOf(pinnedAt(templateCommitHoldingS5), repository)).toEqual({
        code: "kernel_commit_before_carry_out",
        message: `Commit ${templateCommitHoldingS5} does not have the carry-out commit ${pin.carryOutIdentity} as an ancestor in the git repository at ${repository}. Repair: Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.`,
      });
    },
    processWatchdog(1),
  );

  test(
    "in process, the command exits 1 on a refusal and prints its code, 0 on a pass, and 2 with its usage on arguments it cannot read",
    () => {
      const stdout = written(process.stdout);
      const stderr = written(process.stderr);
      const exits = [
        main(["--kernel", siblingKernel()], pinnedAt(templateCommitHoldingS5)),
        main(["--kernel", siblingKernel()], ROOT),
        main(["--kernel"], ROOT),
      ];
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
