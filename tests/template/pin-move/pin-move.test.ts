import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import type { TrialPassed } from "../../../scripts/kernel-trial.ts";
import { movePin, PinRefusal } from "../../../scripts/pin-move.ts";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitOutput } from "../../support/git-fixture.ts";
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
  trialOf,
  trialTimeout,
} from "../../support/kernel-trial-fixture.ts";
import { templateCopy } from "../../support/template-copy.ts";
import { testFolder } from "../../support/test-folder.ts";

const { carryOutIdentity } = readKernelPin(ROOT);
const folder = ownedFolders();
const pinFile = "kernel-pin.json";
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
    if (error instanceof PinRefusal) return error.code;
    throw error;
  }
  return "no refusal";
}

describe("the pin move", () => {
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
        log: [`${changed.slice(0, 7)} name another redaction version`],
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
      expect(refusalOf(await trialAt(notOnMain), template)).toBe(
        "kernel_commit_unreachable",
      );
      expect(bytesOf(template)).toEqual(before);
    },
    trialTimeout(1),
  );

  test(
    "to a commit before the carry-out commit is refused, and writes nothing",
    async () => {
      const template = pinnedTemplate(folder("pin-move-"), changed, changed);
      const before = bytesOf(template);
      expect(refusalOf(await trialAt(trialBase), template)).toBe(
        "kernel_commit_before_carry_out",
      );
      expect(bytesOf(template)).toEqual(before);
    },
    trialTimeout(1),
  );

  test(
    "to a kernel commit whose folders were renamed passes, and the template changes only the pin and the lockfile",
    async () => {
      const copy = templateCopy(folder("pin-move-"));
      pinnedTemplate(copy, trialBase, carryOutIdentity);
      git(
        copy,
        "commit",
        "--quiet",
        "--all",
        "--allow-empty",
        "-m",
        "pin the trial base",
      );
      const { written, report } = movePin(await trialAt(renamed.commit), copy);
      expect(written).toEqual([KERNEL_LOCKFILE, pinFile]);
      expect(
        gitOutput(copy, "status", "--porcelain", "--untracked-files=all")
          .split("\n")
          .filter((line) => line !== "")
          .map((line) => line.slice(3))
          .sort(),
      ).toEqual([KERNEL_LOCKFILE, pinFile].sort());
      expect(report.added).toContain(renamed.declarationPath);
      expect(report.removed).toContain(
        "kernel/config/kernel/kernel-declaration.json",
      );
    },
    trialTimeout(1),
  );
});
