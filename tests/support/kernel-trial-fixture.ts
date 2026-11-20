import { afterAll } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type KernelTrial,
  kernelTrial,
  type TrialPassed,
  trialMilliseconds,
} from "../../scripts/kernel-trial.ts";
import { kernelPinFile, readKernelPin } from "../../src/kernel-pin.ts";
import type { KernelSeam } from "../../src/kernel-reader.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { gitEnv } from "./git-fixture.ts";
import { withEnvironment } from "./kernel-row-fixture.ts";
import { testFolder } from "./test-folder.ts";
import { commitOn, fileAt, moveBranch } from "./kernel-sibling.ts";

// Interface: a test's bound for `trials` kernel trials, above the trial's own
// step bounds, so a step that hangs fails as itself first.
export function trialTimeout(trials: number): number {
  return trials * trialMilliseconds + 30_000;
}

// Interface: kernel trials for one test file, which call it at their top.
// Its trials install into a Bun cache the file owns and removes after its
// last test, because each test kernel repository is a new git address and
// would otherwise add a clone to the developer's own cache on every run.
// `trialEnv` names that cache for a trial run in a child process.
export function kernelTrials() {
  let cache: string | undefined;
  afterAll(() => {
    if (cache !== undefined) rmSync(cache, { recursive: true, force: true });
    cache = undefined;
  }, 60_000);
  const trialEnv = () => {
    cache ??= testFolder("bun-cache-");
    return { BUN_INSTALL_CACHE_DIR: cache };
  };
  const trialOf = (
    folder: string,
    kernel: KernelSeam,
    more: Omit<KernelTrial, "kernel" | "folder"> = {},
  ): Promise<TrialPassed> =>
    withEnvironment({ ...gitEnv, ...trialEnv() }, () =>
      kernelTrial({ kernel, folder, kernelFrom: "clone", ...more }),
    );
  return { trialOf, trialEnv };
}

// Interface: a commit on `base`, at the head of its own branch so an install
// can fetch it, whose kernel package.json names another
// version of one dependency, @logtape/redaction, and nothing else changes.
export function oneDependencyChanged(root: string, base: string): string {
  const manifest = fileAt(root, base, "package.json");
  const changed = manifest.replace(
    '"@logtape/redaction": "2.4.2"',
    '"@logtape/redaction": "2.4.1"',
  );
  if (changed === manifest)
    throw new Error(`${base} does not name @logtape/redaction 2.4.2.`);
  const commit = commitOn(root, [base], "name another redaction version", {
    files: { "package.json": changed },
  });
  moveBranch(root, "one-dependency", commit);
  return commit;
}

// Interface: a commit on `base`, at the head of its own branch, whose kernel
// folder is renamed, with the
// package's exports moved to match, as a kernel repository may do after the
// carry-out. Returns the commit and the kernel declaration's new path.
export function foldersRenamed(root: string, base: string) {
  const manifest = fileAt(root, base, "package.json");
  const commit = commitOn(root, [base], "rename the kernel folder", {
    rename: ["kernel", "engine"],
    files: { "package.json": manifest.replaceAll('"./kernel/', '"./engine/') },
  });
  moveBranch(root, "renamed", commit);
  return {
    commit,
    declarationPath: "engine/config/kernel/kernel-declaration.json",
  };
}

// Interface: a folder holding only the kernel pin, as a template the pin
// move writes into, pinned at `commit` with `carryOutIdentity`.
export function pinnedTemplate(
  folder: string,
  commit: string,
  carryOutIdentity: string,
): string {
  const pin = readKernelPin(ROOT);
  writeFileSync(
    join(folder, kernelPinFile),
    `${JSON.stringify({ ...pin, commit, carryOutIdentity }, null, 2)}\n`,
  );
  return folder;
}
