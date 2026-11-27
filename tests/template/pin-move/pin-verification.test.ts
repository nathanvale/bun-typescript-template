import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { KernelRefusal, readKernel } from "../../../src/kernel-reader.ts";
import {
  branchCommitHeldBy,
  fetchBranchCommit,
  PinRefusal,
  pinBranchCommit,
  verifyPin,
} from "../../../scripts/pin-move.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  gitReadingRemoteAs,
  gitTracingTo,
  withToolsFirst,
} from "../../support/hung-git.ts";
import { processWatchdog } from "../../support/process.ts";
import { shouldSkipLoopback } from "../../support/loopback-connect-probe.ts";
import {
  commitIn,
  git,
  gitResult,
  initRepository,
} from "../../support/git-fixture.ts";
import {
  commitOn,
  kernelClone,
  moveBranch,
  siblingKernel,
  templateCommitHoldingS5,
} from "../../support/kernel-sibling.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const skipLoopback = await shouldSkipLoopback();
const unreachableRepair =
  "Repair: Give a commit that branch reaches on the pin's remote. Push the commit there first if it is only local.";

function refusalOf(
  repository: string,
  commit: string,
  branchCommit = git(repository, "rev-parse", "main"),
) {
  try {
    verifyPin({ repository, commit }, pin, branchCommit);
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

function branchTip(repository: string): string {
  const remote = gitResult(
    repository,
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/remotes/origin/${pin.branch}`,
  );
  return remote.exitCode === 0
    ? remote.stdout.toString().trim()
    : git(repository, "rev-parse", `refs/heads/${pin.branch}`);
}

function holds(repository: string, commit: string): boolean {
  return (
    gitResult(repository, "cat-file", "-e", `${commit}^{commit}`).exitCode === 0
  );
}

function branchRefusalOf(
  remote: string,
  branch = pin.branch,
  limitMilliseconds?: number,
) {
  try {
    return pinBranchCommit({ remote, branch }, limitMilliseconds);
  } catch (error) {
    if (error instanceof PinRefusal)
      return { code: error.code, message: error.message };
    throw error;
  }
}

describe("pin verification", () => {
  test("the kernel reader opens the real pinned commit in the sibling kernel repository, and pin verification passes on it", () => {
    const seam = { repository: siblingKernel(), commit: pin.commit };
    expect(readKernel(seam).commit).toBe(pin.commit);
    expect(
      refusalOf(seam.repository, pin.commit, branchTip(seam.repository)),
    ).toBe("no refusal");
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
      message: `Commit ${side} is not reachable from ${pin.commit}, where branch main points on the pin's remote, in the git repository at ${repository}. ${unreachableRepair}`,
    });
  });

  test("reads the pin's branch from the pin's own remote, so a commit only a clone's own branch reaches is refused", () => {
    const remote = kernelClone(folder("pin-verification-remote-"));
    const repository = kernelClone(folder("pin-verification-"));
    const unpushed = commitOn(repository, [pin.commit], "not pushed");
    moveBranch(repository, "main", unpushed);
    const branchCommit = pinBranchCommit({ remote, branch: pin.branch });
    expect(branchCommit).toBe(pin.commit);
    expect([
      refusalOf(repository, pin.commit, branchCommit),
      refusalOf(repository, unpushed, branchCommit),
    ]).toEqual([
      "no refusal",
      {
        code: "kernel_commit_unreachable",
        message: `Commit ${unpushed} is not reachable from ${pin.commit}, where branch main points on the pin's remote, in the git repository at ${repository}. ${unreachableRepair}`,
      },
    ]);
  });

  test("fetches the commit the pin's branch points at into a clone made before the branch moved, so a commit on that branch is accepted", () => {
    const remote = kernelClone(folder("pin-verification-remote-"));
    const work = folder("pin-verification-");
    git(work, "clone", "--quiet", "--no-checkout", remote, "clone");
    const repository = join(work, "clone");
    const moved = commitOn(remote, [pin.commit], "after the clone");
    moveBranch(remote, "main", moved);
    const branchCommit = pinBranchCommit({ remote, branch: pin.branch });
    expect([branchCommit, holds(repository, moved)]).toEqual([moved, false]);
    expect(fetchBranchCommit(repository, remote, branchCommit)).toBe(true);
    expect([
      holds(repository, moved),
      refusalOf(repository, pin.commit, branchCommit),
    ]).toEqual([true, "no refusal"]);
  });

  test(
    "fetches into a clone without starting git's automatic maintenance, which would run on in the clone after the fetch returns",
    async () => {
      const remote = kernelClone(folder("pin-verification-remote-"));
      const work = folder("pin-verification-");
      git(work, "clone", "--quiet", "--no-checkout", remote, "clone");
      const repository = join(work, "clone");
      const trace = join(work, "git-trace.json");
      const bin = join(work, "bin");
      mkdirSync(bin);
      gitTracingTo(bin, trace);
      const first = commitOn(remote, [pin.commit], "first after the clone");
      moveBranch(remote, "main", first);
      const fetched = await withToolsFirst(bin, () =>
        fetchBranchCommit(repository, remote, first),
      );
      const maintenanceStarted = () =>
        readFileSync(trace, "utf8").includes('"maintenance","run"');
      expect([fetched, maintenanceStarted()]).toEqual([true, false]);
      const second = commitOn(remote, [first], "second after the clone");
      moveBranch(remote, "main", second);
      const control = await withToolsFirst(bin, () =>
        gitResult(
          repository,
          "-c",
          "maintenance.auto=true",
          "-c",
          "maintenance.autoDetach=false",
          "-c",
          "gc.autoDetach=false",
          "fetch",
          "--quiet",
          "--no-tags",
          remote,
          second,
        ),
      );
      expect([control.exitCode, maintenanceStarted()]).toEqual([0, true]);
    },
    processWatchdog(1),
  );

  test(
    "reads the pin's branch commit from the pin's remote and holds it in a clone made before the branch moved",
    async () => {
      const remote = kernelClone(folder("pin-verification-remote-"));
      const work = folder("pin-verification-");
      git(work, "clone", "--quiet", "--no-checkout", remote, "clone");
      const repository = join(work, "clone");
      const moved = commitOn(remote, [pin.commit], "after the clone");
      moveBranch(remote, "main", moved);
      const bin = join(work, "bin");
      mkdirSync(bin);
      gitReadingRemoteAs(bin, pin.remote, remote);
      const branchCommit = await withToolsFirst(bin, () =>
        branchCommitHeldBy(pin, repository),
      );
      expect([branchCommit, holds(repository, moved)]).toEqual([moved, true]);
    },
    processWatchdog(1),
  );

  test("refuses, before any fetch, a path inside another repository, and writes nothing into that repository", () => {
    const remote = kernelClone(folder("pin-verification-remote-"));
    const moved = commitOn(remote, [pin.commit], "only on the remote");
    moveBranch(remote, "main", moved);
    const enclosing = join(folder("pin-verification-"), "template");
    initRepository(enclosing);
    commitIn(enclosing, "a template file", { "src/index.ts": "export {};\n" });
    const inside = join(enclosing, "src");
    let refusal: unknown = "no refusal";
    try {
      fetchBranchCommit(inside, remote, moved);
    } catch (error) {
      refusal =
        error instanceof KernelRefusal
          ? { code: error.code, message: error.message }
          : error;
    }
    expect(refusal).toMatchObject({ code: "kernel_repository_missing" });
    const message = String(Reflect.get(Object(refusal), "message"));
    expect([
      message.startsWith(`No git repository is at ${inside}: git says "`),
      message.endsWith(
        "Repair: Put a clone of the kernel repository at that path, or give the path of one that is there.",
      ),
    ]).toEqual([true, true]);
    expect(holds(enclosing, moved)).toBe(false);
  });

  test("leaves a commit the remote cannot give missing, so pin verification refuses it as unreadable history", () => {
    const repository = kernelClone(folder("pin-verification-"));
    const missing = "e".repeat(40);
    const remote = join(folder("pin-verification-"), "no-repository-here");
    expect(fetchBranchCommit(repository, remote, missing)).toBe(false);
    expect(refusalOf(repository, pin.commit, missing)).toMatchObject({
      code: "kernel_history_unreadable",
    });
  });

  describe.skipIf(skipLoopback)("needs-loopback", () => {
    test("gives up a fetch that does not finish within its bound", () => {
      const silent = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data: () => undefined },
      });
      try {
        const repository = kernelClone(folder("pin-verification-"));
        const started = performance.now();
        const fetched = fetchBranchCommit(
          repository,
          `http://127.0.0.1:${silent.port}/kernel.git`,
          "e".repeat(40),
          500,
        );
        const elapsed = performance.now() - started;
        expect([fetched, elapsed >= 500, elapsed < 2_000]).toEqual([
          false,
          true,
          true,
        ]);
      } finally {
        silent.stop(true);
      }
    }, 30_000);

    test("refuses a remote that does not answer within its bound", () => {
      const silent = Bun.listen({
        hostname: "127.0.0.1",
        port: 0,
        socket: { data: () => undefined },
      });
      try {
        const started = performance.now();
        const refusal = branchRefusalOf(
          `http://127.0.0.1:${silent.port}/kernel.git`,
          pin.branch,
          500,
        );
        const elapsed = performance.now() - started;
        expect(refusal).toEqual({
          code: "kernel_branch_unreadable",
          message: `Branch main of http://127.0.0.1:${silent.port}/kernel.git could not be read: git ls-remote did not finish within 500 ms. Repair: Check that the network reaches the pin's remote and that it serves branch main, then run this again.`,
        });
        expect([elapsed >= 500, elapsed < 2_000]).toEqual([true, true]);
      } finally {
        silent.stop(true);
      }
    }, 30_000);
  });

  test("refuses a branch the pin's remote does not have", () => {
    const remote = kernelClone(folder("pin-verification-remote-"));
    expect(branchRefusalOf(remote, "trunk")).toEqual({
      code: "kernel_branch_unreadable",
      message: `Branch trunk of ${remote} could not be read: the remote has no such branch. Repair: Check that the network reaches the pin's remote and that it serves branch trunk, then run this again.`,
    });
  });

  test("refuses a remote git cannot read, naming git's exit", () => {
    const remote = join(folder("pin-verification-"), "no-repository-here");
    const refusal = branchRefusalOf(remote);
    expect(refusal).toMatchObject({ code: "kernel_branch_unreadable" });
    expect(String(Reflect.get(Object(refusal), "message"))).toStartWith(
      `Branch main of ${remote} could not be read: git ls-remote exited 128 and says "`,
    );
  });

  test("refuses, as unreadable history, a clone too shallow to hold the carry-out commit", () => {
    const work = folder("pin-verification-");
    git(
      work,
      "clone",
      "--quiet",
      "--depth",
      "1",
      "--no-checkout",
      `file://${siblingKernel()}`,
      "shallow",
    );
    const repository = join(work, "shallow");
    const head = git(repository, "rev-parse", "HEAD");
    const refusal = refusalOf(repository, head, head);
    expect(refusal).toMatchObject({ code: "kernel_history_unreadable" });
    expect(String(Reflect.get(Object(refusal), "message"))).toStartWith(
      `git cannot tell whether ${pin.carryOutIdentity} is an ancestor of ${head} in the git repository at ${realpathSync(repository)}: git says "`,
    );
  });

  test(
    "accepts the carry-out commit, the branch tip, and an even sample of the commits between them on the pin's named branch",
    () => {
      const repository = siblingKernel();
      const tip = branchTip(repository);
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
        (commit) => refusalOf(repository, commit, tip) !== "no refusal",
      );
      expect(refused).toEqual([]);
    },
    (sampleSize + 1) * perCommitMilliseconds,
  );
});
