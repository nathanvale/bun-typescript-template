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

export function trialTimeout(trials: number): number {
  return trials * trialMilliseconds + 30_000;
}

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
