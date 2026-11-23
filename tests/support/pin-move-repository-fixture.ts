import { expect } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { trialBase } from "./kernel-sibling.ts";
import { spawnBounded } from "./process.ts";

export const updatedSkillDescription =
  "Write commands on agent-cli-kernel after the Pin move.";

export const sampleChangeNote = JSON.stringify(
  {
    kind: "fixed",
    breaking: false,
    affects: ["kernel"],
    summary: "Stopped a hung child process group on timeout.",
    action: null,
  },
  null,
  2,
);

export const checkFailureTest = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("pins only the older commit", () => {
  expect(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).toContain(${JSON.stringify(trialBase)});
});
`;

export function cloneSpecifier(repository: string, commit: string): string {
  return `git+${pathToFileURL(realpathSync(repository)).href}#${commit}`;
}

export function expectRefused(
  run: {
    readonly exit: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  code: string,
): void {
  expect({ exit: run.exit, stdout: run.stdout }).toEqual({
    exit: 1,
    stdout: "",
  });
  expect(run.stderr).toContain(`${code}:`);
  expect(run.stderr).toContain("Repair:");
}

export function installedKernelCommit(repository: string): string {
  const tag = readFileSync(
    join(repository, "node_modules/agent-cli-kernel/.bun-tag"),
    "utf8",
  ).trim();
  return /([0-9a-f]{7,40})$/.exec(tag)?.[1] ?? `no commit in "${tag}"`;
}

export async function installStartingKernel(
  repository: string,
  env: Readonly<Record<string, string | undefined>>,
): Promise<void> {
  const installed = await spawnBounded([process.execPath, "install"], {
    cwd: repository,
    env,
    boundMilliseconds: 120_000,
  });
  expect({ exit: installed.exit, stderr: installed.stderr }).toMatchObject({
    exit: 0,
  });
  expect(trialBase).toStartWith(installedKernelCommit(repository));
}
