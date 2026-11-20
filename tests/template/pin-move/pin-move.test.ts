import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { kernelPinFile, readKernelPin } from "../../../src/kernel-pin.ts";
import type { TrialPassed } from "../../../scripts/kernel-trial.ts";
import { TrialRefusal } from "../../../scripts/kernel-trial.ts";
import { movePin, PinRefusal } from "../../../scripts/pin-move.ts";
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
  trialBase,
} from "../../support/kernel-sibling.ts";
import {
  foldersRenamed,
  oneDependencyChanged,
  pinnedTemplate,
  kernelTrials,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import { callInCopy, templateCopy } from "../../support/template-copy.ts";
import { testFolder } from "../../support/test-folder.ts";

const { carryOutIdentity } = readKernelPin(ROOT);
const folder = ownedFolders();
const { trialOf, trialEnv } = kernelTrials();
const pinFile = kernelPinFile;
let work = "";
let changed = "";
let notOnMain = "";
let renamed = { commit: "", declarationPath: "" };
let repository = "";
let renaming = "";
const trials = new Map<string, Promise<TrialPassed>>();

// Interface: the kernel trial of `commit`, run on first use and kept for the
// file, so a test or a fault replay that selects one test runs only the
// trials it needs.
function trialAt(commit: string): Promise<TrialPassed> {
  const kept = trials.get(commit);
  if (kept !== undefined) return kept;
  const declarationPath =
    commit === renamed.commit
      ? { declarationPath: renamed.declarationPath }
      : {};
  const trial = trialOf(
    join(work, `trial-${trials.size}`),
    { repository: commit === renamed.commit ? renaming : repository, commit },
    declarationPath,
  );
  trials.set(commit, trial);
  return trial;
}

beforeAll(() => {
  work = testFolder("pin-move-");
  repository = kernelClone(join(work, "moved"), trialBase);
  changed = oneDependencyChanged(repository, trialBase);
  moveBranch(repository, "main", changed);
  notOnMain = commitOn(repository, [changed], "not on main");
  moveBranch(repository, "side", notOnMain);
  renaming = kernelClone(join(work, "renamed"), trialBase);
  renamed = foldersRenamed(renaming, trialBase);
  moveBranch(renaming, "main", renamed.commit);
});

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
}, 60_000);

function bytesOf(template: string) {
  const lockfile = join(template, KERNEL_LOCKFILE);
  return {
    lockfile: existsSync(lockfile) ? readFileSync(lockfile) : "none",
    pin: readFileSync(join(template, pinFile), "utf8"),
  };
}

function refusalOf(trial: TrialPassed, template: string) {
  try {
    movePin(trial, template);
  } catch (error) {
    if (error instanceof PinRefusal || error instanceof TrialRefusal)
      return { code: error.code, message: error.message };
    throw error;
  }
  return "no refusal";
}

describe("the pin move", () => {
  test(
    "refuses a record of a passed trial with a field replaced, and writes the bytes the trial qualified whatever is done to a copy it gave out",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      const trial = await trialAt(changed);
      const forged = { ...trial, kernel: { repository, commit: notOnMain } };
      const before = bytesOf(template);
      expect(refusalOf(forged, template)).toEqual({
        code: "trial_failed",
        message:
          "That record of a passed kernel trial was not made by the kernel trial. Repair: Correct the kernel commit, or the template files the trial copies, until that step passes, then run the kernel trial again. The pin does not move until it passes.",
      });
      expect(bytesOf(template)).toEqual(before);
      trial.lockfile.fill(0);
      expect(Object.isFrozen(trial) && Object.isFrozen(trial.kernel)).toBe(
        true,
      );
      movePin(trial, template);
      expect(bytesOf(template).lockfile).toEqual(
        Buffer.from((await trialAt(changed)).lockfile),
      );
      expect(Buffer.from(trial.lockfile).every((byte) => byte === 0)).toBe(
        false,
      );
    },
    trialTimeout(1),
  );

  test(
    "given a passed trial of the pinned commit, writes its lockfile into a template that has none, and leaves the pin unchanged",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      const pin = bytesOf(template).pin;
      const { written } = movePin(await trialAt(trialBase), template);
      expect(written).toEqual([KERNEL_LOCKFILE]);
      expect(bytesOf(template)).toEqual({
        lockfile: Buffer.from((await trialAt(trialBase)).lockfile),
        pin,
      });
    },
    trialTimeout(1),
  );

  test(
    "run twice with the same target, changes nothing the second time",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      movePin(await trialAt(changed), template);
      const before = bytesOf(template);
      for (const path of [KERNEL_LOCKFILE, pinFile])
        chmodSync(join(template, path), 0o444);
      expect(movePin(await trialAt(changed), template).written).toEqual([]);
      expect(bytesOf(template)).toEqual(before);
    },
    trialTimeout(1),
  );

  test(
    "to a commit whose one dependency changed, writes the new lockfile and the new pin, and reports the changed file and the kernel's log line",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      const { written, report } = movePin(await trialAt(changed), template);
      expect(written).toEqual([KERNEL_LOCKFILE, pinFile]);
      expect(bytesOf(template).lockfile).toEqual(
        Buffer.from((await trialAt(changed)).lockfile),
      );
      expect(readKernelPin(template).commit).toBe(changed);
      expect(report).toEqual({
        from: trialBase,
        to: changed,
        added: [],
        changed: ["package.json"],
        removed: [],
        log: [
          `${git(repository, "rev-parse", "--short", changed)} name another redaction version`,
        ],
      });
    },
    trialTimeout(1),
  );

  test(
    "writes the changed kernel lockfile first and the pin last",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      const { pin } = bytesOf(template);
      chmodSync(join(template, pinFile), 0o444);
      const trial = await trialAt(changed);
      expect(() => movePin(trial, template)).toThrow("EACCES");
      expect(bytesOf(template)).toEqual({
        lockfile: Buffer.from((await trialAt(changed)).lockfile),
        pin,
      });
    },
    trialTimeout(1),
  );

  test(
    "never changes the carry-out identity",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      movePin(await trialAt(changed), template);
      expect(readKernelPin(template)).toMatchObject({
        commit: changed,
        carryOutIdentity,
      });
    },
    trialTimeout(1),
  );

  test(
    "to a commit the pin's branch does not reach is refused, and writes nothing",
    async () => {
      const template = pinnedTemplate(
        folder("pin-move-"),
        trialBase,
        carryOutIdentity,
      );
      const before = bytesOf(template);
      expect(refusalOf(await trialAt(notOnMain), template)).toEqual({
        code: "kernel_commit_unreachable",
        message: `Commit ${notOnMain} is not reachable from branch main in the git repository at ${repository}. Repair: Give a commit that branch reaches. If the clone is behind, run git fetch origin main there first.`,
      });
      expect(bytesOf(template)).toEqual(before);
    },
    trialTimeout(1),
  );

  test(
    "to a commit before the carry-out commit is refused, and writes nothing",
    async () => {
      const template = pinnedTemplate(folder("pin-move-"), changed, changed);
      const before = bytesOf(template);
      expect(refusalOf(await trialAt(trialBase), template)).toEqual({
        code: "kernel_commit_before_carry_out",
        message: `Commit ${trialBase} does not have the carry-out commit ${changed} as an ancestor in the git repository at ${repository}. Repair: Give the carry-out commit or a later commit on the pin's branch. A pin never names a commit from before the carry-out.`,
      });
      expect(bytesOf(template)).toEqual(before);
    },
    trialTimeout(1),
  );

  test(
    "to a kernel commit whose folders were renamed passes, and the template changes only the pin, the lockfile and the one place that holds the kernel declaration's path, after which Bootstrap reads the renamed kernel",
    async () => {
      const copy = templateCopy(folder("pin-move-"));
      pinnedTemplate(copy, trialBase, carryOutIdentity);
      const reader = join(copy, "src/kernel-reader.ts");
      const held = readFileSync(reader, "utf8");
      writeFileSync(
        reader,
        held.replace(
          '"kernel/config/kernel/kernel-declaration.json"',
          JSON.stringify(renamed.declarationPath),
        ),
      );
      git(copy, "commit", "--quiet", "--all", "-m", "the renamed path");
      const before = git(copy, "rev-parse", "HEAD^");
      const script = `const { kernelTrial } = await import(${JSON.stringify(join(copy, "scripts/kernel-trial.ts"))});
const { movePin } = await import(${JSON.stringify(join(copy, "scripts/pin-move.ts"))});
const trial = await kernelTrial({ kernel: { repository: ${JSON.stringify(renaming)}, commit: ${JSON.stringify(renamed.commit)} }, folder: ${JSON.stringify(join(copy, "..", "trial"))}, kernelFrom: "clone" });
process.stdout.write(JSON.stringify(movePin(trial, ${JSON.stringify(copy)}).written));`;
      const moved = await spawnBounded([process.execPath, "--eval", script], {
        cwd: copy,
        env: { ...inherited(), ...gitEnv, ...trialEnv() },
        boundMilliseconds: trialTimeout(1) - 20_000,
        processGroup: true,
      });
      expect(moved).toMatchObject({
        exit: 0,
        stdout: JSON.stringify([KERNEL_LOCKFILE, pinFile]),
      });
      git(copy, "add", "--all");
      expect(
        gitOutput(copy, "diff", "--cached", "--name-only", before)
          .split("\n")
          .filter((line) => line !== "")
          .sort(),
      ).toEqual([KERNEL_LOCKFILE, pinFile, "src/kernel-reader.ts"].sort());
      expect(
        await callInCopy(copy, "src/bootstrap.ts", "bootstrapWithKernel", {
          destination: join(copy, "..", "made"),
          sourcePacket: "/abs/packets/demo",
          kernel: { repository: renaming, commit: renamed.commit },
          lockfile: "committed",
        }),
      ).toMatchObject({ returned: { status: "created" } });
    },
    trialTimeout(1),
  );
});
