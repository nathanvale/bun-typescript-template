import { afterAll, beforeAll, expect } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readKernelPin } from "../../src/kernel-pin.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import { ownedFolders } from "./fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "./git-fixture.ts";
import { commitObjects } from "./git-object-fixture.ts";
import { gitReadingRemoteAs } from "./hung-git.ts";
import {
  fileAt,
  kernelClone,
  moveBranch,
  trialBase,
} from "./kernel-sibling.ts";
import { spawnBounded } from "./process.ts";
import { testFolder } from "./test-folder.ts";

export const updatedSkillDescription =
  "Write commands on agent-cli-kernel after the Pin move.";

const sampleChangeNote = JSON.stringify(
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

async function installStartingKernel(
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

export type PinMoveRepositoryFixture = {
  kernelRepo: string;
  nonKernelRepo: string;
  targetCommit: string;
  unpushedCommit: string;
  nonKernelCommit: string;
  remoteBin: string;
  nonKernelBin: string;
  readonly folder: (prefix: string) => string;
  readonly runPinMove: (
    args: readonly string[],
    bin?: string,
    boundMilliseconds?: number,
  ) => ReturnType<typeof spawnBounded>;
  readonly freshRepository: (prefix: string) => string;
  readonly installedRepository: (prefix: string) => Promise<string>;
  readonly pinMoveEnv: (bin: string) => Record<string, string | undefined>;
};

async function bootstrapBase(
  baseGenerated: string,
  kernelRepo: string,
): Promise<void> {
  const bootstrap = await spawnBounded(
    [
      process.execPath,
      "run",
      join(ROOT, "src/bootstrap.ts"),
      "--destination",
      baseGenerated,
      "--name",
      "doorway-fixture",
      "--source-packet",
      "/doorway-fixture",
    ],
    {
      cwd: ROOT,
      env: { ...inherited(), ...gitEnv },
      boundMilliseconds: 30_000,
    },
  );
  if (bootstrap.exit !== 0)
    throw new Error(
      `bootstrap fixture failed (${bootstrap.exit}): ${bootstrap.stderr}`,
    );
  const manifestPath = join(baseGenerated, "package.json");
  const manifest = readFileSync(manifestPath, "utf8").replace(
    `"agent-cli-kernel": "github:nathanvale/agent-cli-kernel#${trialBase}"`,
    `"agent-cli-kernel": ${JSON.stringify(cloneSpecifier(kernelRepo, trialBase))}`,
  );
  writeFileSync(manifestPath, manifest);
  rmSync(join(baseGenerated, "bun.lock"), { force: true });
  initRepository(baseGenerated);
  git(baseGenerated, "add", "--all");
  commitIn(baseGenerated, "initial generated repository", {});
}

function kernelCommits(work: string, fixture: PinMoveRepositoryFixture): void {
  fixture.kernelRepo = kernelClone(join(work, "kernel-local"), trialBase);
  const { kernelRepo } = fixture;
  const currentSkill = fileAt(
    kernelRepo,
    trialBase,
    "skills/agent-cli-kernel/SKILL.md",
  );
  git(kernelRepo, "read-tree", trialBase);
  fixture.targetCommit = commitObjects(
    kernelRepo,
    "fix(kernel): add change note and update skill trigger",
    [
      {
        path: "change-notes/2026-11-22-kernel-fix.json",
        bytes: `${sampleChangeNote}\n`,
      },
      {
        path: "skills/agent-cli-kernel/SKILL.md",
        bytes: currentSkill.replace(
          /^description: .*$/m,
          `description: ${updatedSkillDescription}`,
        ),
      },
    ],
  );
  moveBranch(kernelRepo, "main", fixture.targetCommit);
  const remoteRepo = join(work, "kernel-remote");
  git(work, "clone", "--quiet", "--bare", kernelRepo, remoteRepo);
  moveBranch(remoteRepo, "main", fixture.targetCommit);
  fixture.unpushedCommit = commitObjects(
    kernelRepo,
    "feat(kernel): local unpushed commit",
    [
      {
        path: "change-notes/2026-11-22-local-only.json",
        bytes: `${sampleChangeNote}\n`,
      },
    ],
  );
  moveBranch(kernelRepo, "main", fixture.unpushedCommit);
  fixture.nonKernelRepo = kernelClone(join(work, "non-kernel"), trialBase);
  git(fixture.nonKernelRepo, "read-tree", trialBase);
  fixture.nonKernelCommit = commitObjects(
    fixture.nonKernelRepo,
    "remove kernel declaration",
    [{ path: "kernel/config/kernel/kernel-declaration.json", removed: true }],
  );
  moveBranch(fixture.nonKernelRepo, "main", fixture.nonKernelCommit);
  const { remote } = readKernelPin(ROOT);
  fixture.remoteBin = join(work, "bin-remote");
  mkdirSync(fixture.remoteBin, { recursive: true });
  gitReadingRemoteAs(fixture.remoteBin, remote, remoteRepo);
  fixture.nonKernelBin = join(work, "bin-non-kernel");
  mkdirSync(fixture.nonKernelBin, { recursive: true });
  gitReadingRemoteAs(fixture.nonKernelBin, remote, fixture.nonKernelRepo);
}

export function pinMoveRepositoryFixture(): PinMoveRepositoryFixture {
  let work = "";
  const folder = ownedFolders();
  const bunCache = () => join(work, "bun-cache");
  const baseGenerated = () => join(work, "base-generated");
  const pinMoveEnv = (bin: string) => ({
    ...inherited(),
    ...gitEnv,
    BUN_INSTALL_CACHE_DIR: bunCache(),
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  });
  const freshRepository = (prefix: string) => {
    const destination = join(folder(prefix), "generated");
    cpSync(baseGenerated(), destination, {
      recursive: true,
      verbatimSymlinks: true,
    });
    return destination;
  };
  const fixture: PinMoveRepositoryFixture = {
    kernelRepo: "",
    nonKernelRepo: "",
    targetCommit: "",
    unpushedCommit: "",
    nonKernelCommit: "",
    remoteBin: "",
    nonKernelBin: "",
    folder,
    pinMoveEnv,
    freshRepository,
    runPinMove: (args, bin = fixture.remoteBin, boundMilliseconds = 120_000) =>
      spawnBounded(
        [process.execPath, join(ROOT, "scripts/pin-move.ts"), ...args],
        { cwd: ROOT, env: pinMoveEnv(bin), boundMilliseconds },
      ),
    installedRepository: async (prefix) => {
      const repo = freshRepository(prefix);
      await installStartingKernel(repo, pinMoveEnv(fixture.remoteBin));
      return repo;
    },
  };
  beforeAll(async () => {
    work = testFolder("pin-move-repo-");
    mkdirSync(bunCache(), { recursive: true });
    kernelCommits(work, fixture);
    await bootstrapBase(baseGenerated(), fixture.kernelRepo);
  }, 60_000);
  afterAll(() => {
    if (work !== "") rmSync(work, { recursive: true, force: true });
  }, 60_000);
  return fixture;
}
