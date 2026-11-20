import { describe, expect, test } from "bun:test";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { readKernel } from "../../../src/kernel-reader.ts";
import { PinRefusal, verifyPin } from "../../../scripts/pin-move.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitResult } from "../../support/git-fixture.ts";
import {
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
} from "../../support/kernel-sibling.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const templateCommitHoldingS5 = "77ebdeafb1f49d0b32307b3ead7273d265ad4918";

function refusalOf(repository: string, commit: string) {
  try {
    verifyPin({ repository, commit }, pin);
  } catch (error) {
    if (error instanceof PinRefusal)
      return { code: error.code, message: error.message };
    throw error;
  }
  return "no refusal";
}

function beforeCarryOut(repository: string, commit: string) {
  return {
    code: "kernel_commit_before_carry_out" as const,
    message: `Commit ${commit} does not have the carry-out commit ${pin.carryOutIdentity} as an ancestor in the git repository at ${repository}. Repair: Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.`,
  };
}

function reachableFromMain(repository: string, commit: string): boolean {
  return (
    gitResult(repository, "merge-base", "--is-ancestor", commit, "main")
      .exitCode === 0
  );
}

const sampleSize = 40;
const perCommitMilliseconds = 1_000;

function evenSample(items: readonly string[], size: number): string[] {
  if (items.length <= size) return [...items];
  return Array.from({ length: size }, (_, index) =>
    items.slice(Math.round((index * (items.length - 1)) / (size - 1))),
  ).flatMap(([item]) => (item === undefined ? [] : [item]));
}

function branchTip(repository: string, branch: string): string {
  const remote = gitResult(
    repository,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${branch}`,
  );
  return remote.exitCode === 0
    ? remote.stdout.toString().trim()
    : git(repository, "rev-parse", `refs/heads/${branch}`);
}

describe("pin verification", () => {
  test("the kernel reader opens the real pinned commit in the sibling kernel repository, and pin verification passes on it", () => {
    const seam = { repository: siblingKernel(), commit: pin.commit };
    expect(readKernel(seam).commit).toBe(pin.commit);
    expect(refusalOf(seam.repository, pin.commit)).toBe("no refusal");
  });

  test("refuses the template commit that holds slice S5, which the pin's branch reaches through the carried history, as before the carry-out", () => {
    const repository = kernelClone(folder("pin-verification-"));
    expect(reachableFromMain(repository, templateCommitHoldingS5)).toBe(true);
    expect(refusalOf(repository, templateCommitHoldingS5)).toEqual(
      beforeCarryOut(repository, templateCommitHoldingS5),
    );
  });

  test("refuses a commit on a branch that does not descend from the carry-out commit, once main reaches it through a merge, as before the carry-out", () => {
    const repository = kernelClone(folder("pin-verification-"));
    const prepared = git(repository, "rev-parse", `${pin.carryOutIdentity}^`);
    const side = commitOn(repository, [prepared], "a side branch", {
      files: { "side.md": "Started before the carry-out.\n" },
    });
    moveBranch(repository, "side", side);
    moveBranch(
      repository,
      "main",
      commitOn(repository, [pin.commit, side], "merge the side branch"),
    );
    expect(reachableFromMain(repository, side)).toBe(true);
    expect(refusalOf(repository, side)).toEqual(
      beforeCarryOut(repository, side),
    );
  });

  test("refuses a commit after the carry-out that the pin's branch does not reach", () => {
    const repository = kernelClone(folder("pin-verification-"));
    const side = commitOn(repository, [pin.commit], "not on main");
    moveBranch(repository, "side", side);
    expect(refusalOf(repository, side)).toEqual({
      code: "kernel_commit_unreachable",
      message: `Commit ${side} is not reachable from branch main in the git repository at ${repository}. Repair: Give a commit that branch reaches. If the clone is behind, run git fetch origin main there first.`,
    });
  });

  test("reads the remote's copy of the pin's branch when the clone has one, so a commit only the clone's own branch reaches is refused", () => {
    const repository = kernelClone(folder("pin-verification-"));
    const remoteOnly = commitOn(repository, [pin.commit], "on the remote");
    const localOnly = commitOn(repository, [pin.commit], "not pushed");
    git(repository, "update-ref", "refs/remotes/origin/main", remoteOnly);
    moveBranch(repository, "main", localOnly);
    expect([
      refusalOf(repository, remoteOnly),
      refusalOf(repository, localOnly),
    ]).toEqual([
      "no refusal",
      {
        code: "kernel_commit_unreachable",
        message: `Commit ${localOnly} is not reachable from branch main in the git repository at ${repository}. Repair: Give a commit that branch reaches. If the clone is behind, run git fetch origin main there first.`,
      },
    ]);
  });

  test("refuses every commit when the repository has no branch of the pin's name", () => {
    const repository = kernelClone(folder("pin-verification-"));
    git(repository, "branch", "-m", "main", "trunk");
    expect(refusalOf(repository, pin.commit)).toEqual({
      code: "kernel_commit_unreachable",
      message: `The git repository at ${repository} has no branch main, so commit ${pin.commit} cannot be shown reachable from it. Repair: Give a commit that branch reaches. If the clone is behind, run git fetch origin main there first.`,
    });
  });

  test(
    "accepts the carry-out commit, the branch tip, and an even sample of the commits between them on the pin's named branch",
    () => {
      const repository = siblingKernel();
      const tip = branchTip(repository, pin.branch);
      const between = git(
        repository,
        "rev-list",
        "--ancestry-path",
        `${pin.carryOutIdentity}..${tip}`,
      ).split("\n");
      const sample = evenSample(between, sampleSize);
      expect([between.length > 10, sample[0], sample.length]).toEqual([
        true,
        tip,
        Math.min(sampleSize, between.length),
      ]);
      const refused = [pin.carryOutIdentity, ...sample].filter(
        (commit) => refusalOf(repository, commit) !== "no refusal",
      );
      expect(refused).toEqual([]);
    },
    (sampleSize + 1) * perCommitMilliseconds,
  );
});
