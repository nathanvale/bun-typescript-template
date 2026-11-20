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
const trials = new Map<string, TrialPassed>();

function trialAt(commit: string): TrialPassed {
  const trial = trials.get(commit);
  if (trial === undefined)
    throw new Error(`No kernel trial ran for ${commit}.`);
  return trial;
}

beforeAll(async () => {
  work = testFolder("pin-move-");
  const repository = kernelClone(join(work, "moved"), trialBase);
  changed = oneDependencyChanged(repository, trialBase);
  moveBranch(repository, "main", changed);
  notOnMain = commitOn(repository, [changed], "not on main");
  moveBranch(repository, "side", notOnMain);
  const renaming = kernelClone(join(work, "renamed"), trialBase);
  renamed = foldersRenamed(renaming, trialBase);
  moveBranch(renaming, "main", renamed.commit);
  for (const [name, kernel, declarationPath] of [
    ["base", { repository, commit: trialBase }, undefined],
    ["changed", { repository, commit: changed }, undefined],
    ["side", { repository, commit: notOnMain }, undefined],
    [
      "renamed",
      { repository: renaming, commit: renamed.commit },
      renamed.declarationPath,
    ],
  ] as const)
    trials.set(
      kernel.commit,
      await trialOf(
        join(work, `trial-${name}`),
        kernel,
        declarationPath === undefined ? {} : { declarationPath },
      ),
    );
}, trialTimeout(4));

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
  test("given a passed trial of the pinned commit, writes its lockfile into a template that has none, and leaves the pin unchanged", () => {
    const template = pinnedTemplate(
      folder("pin-move-"),
      trialBase,
      carryOutIdentity,
    );
    const pin = bytesOf(template).pin;
    const { written } = movePin(trialAt(trialBase), template);
    expect(written).toEqual([KERNEL_LOCKFILE]);
    expect(bytesOf(template)).toEqual({
      lockfile: Buffer.from(trialAt(trialBase).lockfile),
      pin,
    });
  });

  test("run twice with the same target, changes nothing the second time", () => {
    const template = pinnedTemplate(
      folder("pin-move-"),
      trialBase,
      carryOutIdentity,
    );
    movePin(trialAt(changed), template);
    const before = bytesOf(template);
    for (const path of [KERNEL_LOCKFILE, pinFile])
      chmodSync(join(template, path), 0o444);
    expect(movePin(trialAt(changed), template).written).toEqual([]);
    expect(bytesOf(template)).toEqual(before);
  });

  test("to a commit whose one dependency changed, writes the new lockfile and the new pin, and reports the changed file and the kernel's log line", () => {
    const template = pinnedTemplate(
      folder("pin-move-"),
      trialBase,
      carryOutIdentity,
    );
    const { written, report } = movePin(trialAt(changed), template);
    expect(written).toEqual([KERNEL_LOCKFILE, pinFile]);
    expect(bytesOf(template).lockfile).toEqual(
      Buffer.from(trialAt(changed).lockfile),
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
  });

  test("writes the changed kernel lockfile first and the pin last", () => {
    const template = pinnedTemplate(
      folder("pin-move-"),
      trialBase,
      carryOutIdentity,
    );
    const { pin } = bytesOf(template);
    chmodSync(join(template, pinFile), 0o444);
    expect(() => movePin(trialAt(changed), template)).toThrow("EACCES");
    expect(bytesOf(template)).toEqual({
      lockfile: Buffer.from(trialAt(changed).lockfile),
      pin,
    });
  });

  test("never changes the carry-out identity", () => {
    const template = pinnedTemplate(
      folder("pin-move-"),
      trialBase,
      carryOutIdentity,
    );
    movePin(trialAt(changed), template);
    expect(readKernelPin(template)).toMatchObject({
      commit: changed,
      carryOutIdentity,
    });
  });

  test("to a commit the pin's branch does not reach is refused, and writes nothing", () => {
    const template = pinnedTemplate(
      folder("pin-move-"),
      trialBase,
      carryOutIdentity,
    );
    const before = bytesOf(template);
    expect(refusalOf(trialAt(notOnMain), template)).toBe(
      "kernel_commit_unreachable",
    );
    expect(bytesOf(template)).toEqual(before);
  });

  test("to a commit before the carry-out commit is refused, and writes nothing", () => {
    const template = pinnedTemplate(folder("pin-move-"), changed, changed);
    const before = bytesOf(template);
    expect(refusalOf(trialAt(trialBase), template)).toBe(
      "kernel_commit_before_carry_out",
    );
    expect(bytesOf(template)).toEqual(before);
  });

  test("to a kernel commit whose folders were renamed passes, and the template changes only the pin and the lockfile", () => {
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
    const { written, report } = movePin(trialAt(renamed.commit), copy);
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
  });
});
