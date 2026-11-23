import { readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { readKernelPin } from "../../src/kernel-pin.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { git, gitEnv, gitOutput, inherited } from "./git-fixture.ts";
import { siblingKernel } from "./kernel-sibling.ts";

const gitMilliseconds = 4_000;
const { remote, commit: pinnedCommit } = readKernelPin(ROOT);

export function bareRemote(
  parent: string,
  source = siblingKernel(),
  mainAt = pinnedCommit,
): string {
  const bare = join(parent, "agent-cli-kernel.git");
  git(parent, "clone", "--quiet", "--bare", source, bare);
  git(bare, "update-ref", "refs/heads/main", mainAt);
  return bare;
}

export function kernelCacheEnv(
  remotePath: string,
  cacheHome: string,
): Record<string, string | undefined> {
  return {
    ...inherited(),
    KERNEL_REPOSITORY: undefined,
    ...gitEnv,
    GIT_CONFIG_COUNT: "3",
    GIT_CONFIG_KEY_2: `url.${remotePath}.insteadOf`,
    GIT_CONFIG_VALUE_2: remote,
    XDG_CACHE_HOME: cacheHome,
  };
}

export function holds(repository: string, commit: string): boolean {
  return (
    Bun.spawnSync(["git", "--git-dir", repository, "cat-file", "-e", commit], {
      env: { ...inherited(), ...gitEnv },
      stdout: "ignore",
      stderr: "ignore",
      timeout: gitMilliseconds,
      killSignal: "SIGKILL",
    }).exitCode === 0
  );
}

export function unpackObjects(repository: string): void {
  const packs = join(repository, "objects/pack");
  for (const name of readdirSync(packs).filter((each) =>
    each.endsWith(".pack"),
  )) {
    const pack = readFileSync(join(packs, name));
    for (const each of readdirSync(packs))
      if (each.startsWith(name.slice(0, -".pack".length)))
        rmSync(join(packs, each));
    const unpacked = Bun.spawnSync(
      ["git", "--git-dir", repository, "unpack-objects", "-q"],
      {
        env: { ...inherited(), ...gitEnv },
        stdin: pack,
        stdout: "ignore",
        stderr: "pipe",
        timeout: gitMilliseconds,
        killSignal: "SIGKILL",
      },
    );
    if (unpacked.exitCode !== 0)
      throw new Error(`git unpack-objects: ${unpacked.stderr.toString()}`);
  }
}

export function replaceObject(
  repository: string,
  id: string,
  kind: "blob" | "commit",
  bytes: Uint8Array,
): void {
  const path = join(repository, "objects", id.slice(0, 2), id.slice(2));
  rmSync(path);
  writeFileSync(
    path,
    deflateSync(
      Buffer.concat([Buffer.from(`${kind} ${bytes.length}\0`), bytes]),
    ),
  );
}

export function commitBytes(repository: string, commit: string): Uint8Array {
  return Buffer.from(
    gitOutput(repository, "cat-file", "commit", commit),
    "utf8",
  );
}
