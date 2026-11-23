import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  cpSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { commitObjects } from "../../support/git-object-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
import {
  absentCommit,
  fileAt,
  kernelClone,
  moveBranch,
  templateCommitHoldingS5,
  trialBase,
} from "../../support/kernel-sibling.ts";
import {
  checkFailureTest,
  cloneSpecifier,
  expectRefused,
  installedKernelCommit,
  installStartingKernel,
  sampleChangeNote,
  updatedSkillDescription,
} from "../../support/pin-move-repository-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();

let work = "";
let kernelRepo = "";
let remoteRepo = "";
let nonKernelRepo = "";
let targetCommit = "";
let unpushedCommit = "";
let nonKernelCommit = "";
let remoteBin = "";
let nonKernelBin = "";
let bunCache = "";
let baseGenerated = "";

function pinMoveEnv(bin: string): Record<string, string | undefined> {
  return {
    ...inherited(),
    ...gitEnv,
    BUN_INSTALL_CACHE_DIR: bunCache,
    PATH: `${bin}${delimiter}${process.env.PATH ?? ""}`,
  };
}

function runPinMove(
  args: readonly string[],
  bin = remoteBin,
  boundMilliseconds = 120_000,
) {
  return spawnBounded(
    [process.execPath, join(ROOT, "scripts/pin-move.ts"), ...args],
    {
      cwd: ROOT,
      env: pinMoveEnv(bin),
      boundMilliseconds,
    },
  );
}

async function installedRepository(prefix: string): Promise<string> {
  const repo = freshRepository(prefix);
  await installStartingKernel(repo, pinMoveEnv(remoteBin));
  return repo;
}

function freshRepository(prefix: string): string {
  const destination = join(folder(prefix), "generated");
  cpSync(baseGenerated, destination, {
    recursive: true,
    verbatimSymlinks: true,
  });
  return destination;
}

beforeAll(async () => {
  work = testFolder("pin-move-repo-");
  bunCache = join(work, "bun-cache");
  mkdirSync(bunCache, { recursive: true });

  kernelRepo = kernelClone(join(work, "kernel-local"), trialBase);
  const currentSkill = fileAt(
    kernelRepo,
    trialBase,
    "skills/agent-cli-kernel/SKILL.md",
  );
  const nextSkill = currentSkill.replace(
    /^description: .*$/m,
    `description: ${updatedSkillDescription}`,
  );
  git(kernelRepo, "read-tree", trialBase);
  targetCommit = commitObjects(
    kernelRepo,
    "fix(kernel): add change note and update skill trigger",
    [
      {
        path: "change-notes/2026-11-22-kernel-fix.json",
        bytes: `${sampleChangeNote}\n`,
      },
      {
        path: "skills/agent-cli-kernel/SKILL.md",
        bytes: nextSkill,
      },
    ],
  );
  moveBranch(kernelRepo, "main", targetCommit);

  remoteRepo = join(work, "kernel-remote");
  git(work, "clone", "--quiet", "--bare", kernelRepo, remoteRepo);
  moveBranch(remoteRepo, "main", targetCommit);

  unpushedCommit = commitObjects(
    kernelRepo,
    "feat(kernel): local unpushed commit",
    [
      {
        path: "change-notes/2026-11-22-local-only.json",
        bytes: `${sampleChangeNote}\n`,
      },
    ],
  );
  moveBranch(kernelRepo, "main", unpushedCommit);

  nonKernelRepo = kernelClone(join(work, "non-kernel"), trialBase);
  git(nonKernelRepo, "read-tree", trialBase);
  nonKernelCommit = commitObjects(nonKernelRepo, "remove kernel declaration", [
    { path: "kernel/config/kernel/kernel-declaration.json", removed: true },
  ]);
  moveBranch(nonKernelRepo, "main", nonKernelCommit);

  remoteBin = join(work, "bin-remote");
  mkdirSync(remoteBin, { recursive: true });
  gitReadingRemoteAs(remoteBin, pin.remote, remoteRepo);

  nonKernelBin = join(work, "bin-non-kernel");
  mkdirSync(nonKernelBin, { recursive: true });
  gitReadingRemoteAs(nonKernelBin, pin.remote, nonKernelRepo);

  baseGenerated = join(work, "base-generated");
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
}, 60_000);

afterAll(() => {
  if (work !== "") rmSync(work, { recursive: true, force: true });
}, 60_000);

describe("pin-move --repository", () => {
  test(
    "--plan prints kernel change notes and leaves the generated repository untouched on main",
    async () => {
      const repo = freshRepository("pin-move-plan-");
      const beforeHead = git(repo, "rev-parse", "HEAD");
      const run = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
        "--plan",
      ]);
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(run.stdout).toContain(
        `Pin move report: ${trialBase} to ${targetCommit}`,
      );
      expect(run.stdout).toContain("Kernel change notes (1):");
      expect(run.stdout).toContain(
        "Stopped a hung child process group on timeout.",
      );
      expect(run.stdout).toContain("Plan only: no branch or file changed");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(git(repo, "rev-parse", "HEAD")).toBe(beforeHead);
      expect(gitOutput(repo, "branch", "--list", "pin-move/*")).toBe("");
      expect(
        gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
      ).toBe("");
    },
    processWatchdog(3),
  );

  test("moves a generated repository Pin onto a new branch, prints change notes first, updates package.json, lockfile and pointer skills, runs check, and leaves main untouched", async () => {
    const repo = freshRepository("pin-move-apply-");
    const oldSpecifier = cloneSpecifier(kernelRepo, trialBase);
    const originalManifest = readFileSync(join(repo, "package.json"), "utf8");
    const withConfig = originalManifest.replace(
      `"version": "0.0.0",`,
      `"version": "0.0.0",\n  "config": {\n    "agent-cli-kernel": ${JSON.stringify(oldSpecifier)}\n  },`,
    );
    commitIn(repo, "add unrelated config entry matching old specifier", {
      "package.json": withConfig,
    });
    const mainBefore = git(repo, "rev-parse", "main");
    const expectedBranch = `pin-move/${targetCommit.slice(0, 7)}`;
    const run = await runPinMove([
      targetCommit,
      "--kernel",
      kernelRepo,
      "--repository",
      repo,
    ]);
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    const reportIndex = run.stdout.indexOf("Kernel change notes (1):");
    const movedIndex = run.stdout.indexOf(
      `Moved kernel Pin in ${realpathSync(repo)} on branch ${expectedBranch}`,
    );
    expect(reportIndex).toBeGreaterThan(-1);
    expect(movedIndex).toBeGreaterThan(reportIndex);
    expect(run.stdout).toContain(
      "Stopped a hung child process group on timeout.",
    );
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(expectedBranch);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(
      gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
    ).toBe("");
    const updatedManifest: unknown = JSON.parse(
      readFileSync(join(repo, "package.json"), "utf8"),
    );
    expect(updatedManifest).toMatchObject({
      config: { "agent-cli-kernel": oldSpecifier },
      dependencies: {
        "agent-cli-kernel": cloneSpecifier(kernelRepo, targetCommit),
      },
    });
    expect(
      readFileSync(
        join(repo, ".agents/skills/agent-cli-kernel/SKILL.md"),
        "utf8",
      ),
    ).toContain(`Pinned commit: \`${targetCommit}\``);
    expect(
      readFileSync(
        join(repo, ".agents/skills/agent-cli-kernel/SKILL.md"),
        "utf8",
      ),
    ).toContain(`description: ${updatedSkillDescription}`);
    expect(
      readFileSync(join(repo, ".agents/skills/verify-cli/SKILL.md"), "utf8"),
    ).toContain(`Pinned commit: \`${targetCommit}\``);
  }, 180_000);

  test(
    "refuses when the generated repository working tree is dirty and creates no branch",
    async () => {
      const repo = freshRepository("pin-move-dirty-");
      writeFileSync(join(repo, "untracked.txt"), "local work\n");
      const run = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(run, "repository_dirty");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(gitOutput(repo, "branch", "--list", "pin-move/*")).toBe("");
    },
    processWatchdog(3),
  );

  test(
    "refuses when the target commit is not a kernel commit",
    async () => {
      const repo = freshRepository("pin-move-non-kernel-");
      const noDecl = await runPinMove(
        [nonKernelCommit, "--kernel", nonKernelRepo, "--repository", repo],
        nonKernelBin,
      );
      expectRefused(noDecl, "kernel_declaration_missing");

      const missing = await runPinMove([
        absentCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(missing, "kernel_commit_missing");

      const short = await runPinMove([
        targetCommit.slice(0, 10),
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(short, "kernel_commit_abbreviated");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(gitOutput(repo, "branch", "--list", "pin-move/*")).toBe("");
    },
    processWatchdog(3),
  );

  test(
    "refuses when kernel Pin verification fails for an unpushed commit or a commit before carry-out",
    async () => {
      const repo = freshRepository("pin-move-verify-fail-");
      const unpushed = await runPinMove([
        unpushedCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(unpushed, "kernel_commit_unreachable");

      const beforeCarryOut = await runPinMove([
        templateCommitHoldingS5,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(beforeCarryOut, "kernel_commit_before_carry_out");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(gitOutput(repo, "branch", "--list", "pin-move/*")).toBe("");
    },
    processWatchdog(3),
  );

  test("refuses when the generated repository check fails after the move, keeps the failed attempt as one commit on the pin-move branch, and leaves main checked out and clean", async () => {
    const repo = await installedRepository("pin-move-check-fail-");
    commitIn(repo, "add test that fails once the Pin moves", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
      "tests/check-failure.test.ts": checkFailureTest,
    });
    const mainBefore = git(repo, "rev-parse", "main");
    const expectedBranch = `pin-move/${targetCommit.slice(0, 7)}`;

    const run = await runPinMove([
      targetCommit,
      "--kernel",
      kernelRepo,
      "--repository",
      repo,
    ]);
    expect(run.exit).toBe(1);
    expect(run.stdout).toContain("Kernel change notes (1):");
    expect(run.stderr).toContain("repository_check_failed:");
    expect(run.stderr).toContain(
      `The failed attempt is kept on branch ${expectedBranch} for inspection; main is checked out again and was not changed.`,
    );
    expect(run.stderr).toContain(
      `Repair: Delete the failed attempt with git branch -D ${expectedBranch} in ${realpathSync(repo)} before running pin-move again.`,
    );
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(
      gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
    ).toBe("");
    expect(git(repo, "rev-list", "--count", `main..${expectedBranch}`)).toBe(
      "1",
    );
    expect(git(repo, "log", "-1", "--format=%s", expectedBranch)).toBe(
      `chore(kernel): failed Pin move from ${trialBase.slice(0, 7)} to ${targetCommit.slice(0, 7)} (repository_check_failed)`,
    );
    expect(git(repo, "show", `${expectedBranch}:package.json`)).toContain(
      cloneSpecifier(kernelRepo, targetCommit),
    );
    expect(trialBase).toStartWith(installedKernelCommit(repo));
  }, 180_000);

  test("refuses when the generated repository check fails, and says the installed kernel was not restored when the starting branch's frozen install fails", async () => {
    const repo = await installedRepository("pin-move-reinstall-fail-");
    const manifest = readFileSync(join(repo, "package.json"), "utf8");
    const staleManifest = manifest.replace(
      /^ {4}"@types\/bun": "[^"]*",\n/m,
      "",
    );
    expect(staleManifest).not.toBe(manifest);
    commitIn(repo, "drop a dependency without updating bun.lock", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
      "package.json": staleManifest,
      "tests/check-failure.test.ts": checkFailureTest,
    });
    const expectedBranch = `pin-move/${targetCommit.slice(0, 7)}`;

    const run = await runPinMove([
      targetCommit,
      "--kernel",
      kernelRepo,
      "--repository",
      repo,
    ]);
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain("repository_check_failed:");
    expect(run.stderr).toContain(
      `The failed attempt is kept on branch ${expectedBranch} for inspection and main is checked out again, but its installed packages may still hold the failed attempt's kernel: bun install --frozen-lockfile on main failed:`,
    );
    expect(run.stderr).not.toContain("was not changed");
    expect(run.stderr).toContain(
      `Repair: Run bun install --frozen-lockfile in ${realpathSync(repo)}, then delete the failed attempt with git branch -D ${expectedBranch} before running pin-move again.`,
    );
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(targetCommit).toStartWith(installedKernelCommit(repo));
  }, 180_000);

  test(
    "refuses a symbolic link pointer skill or bun.lock before creating the branch and leaves main checked out and clean",
    async () => {
      const outside = folder("pin-move-linked-outside-");
      for (const [prefix, linkedPath] of [
        ["pin-move-linked-skill-", ".agents/skills/verify-cli/SKILL.md"],
        ["pin-move-linked-lock-", "bun.lock"],
      ] as const) {
        const repo = freshRepository(prefix);
        const target = join(outside, `${prefix}target`);
        writeFileSync(target, "linked content\n");
        rmSync(join(repo, linkedPath), { force: true });
        symlinkSync(target, join(repo, linkedPath));
        git(repo, "add", "--", linkedPath);
        git(repo, "commit", "--quiet", "-m", `link ${linkedPath}`);
        const mainBefore = git(repo, "rev-parse", "main");
        const run = await runPinMove([
          targetCommit,
          "--kernel",
          kernelRepo,
          "--repository",
          repo,
        ]);
        expectRefused(run, "repository_invalid");
        expect(run.stderr).toContain(`${linkedPath} in`);
        expect(run.stderr).toContain("symbolic link");
        expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
        expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
        expect(gitOutput(repo, "branch", "--list", "pin-move/*")).toBe("");
        expect(
          gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
        ).toBe("");
        expect(readFileSync(target, "utf8")).toBe("linked content\n");
      }
    },
    processWatchdog(3),
  );

  test(
    "refuses when the generated repository Pin is missing, already at the target commit, or the target branch already exists",
    async () => {
      const repo = freshRepository("pin-move-guards-");
      const unchanged = await runPinMove([
        trialBase,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(unchanged, "repository_pin_unchanged");

      const existingBranch = `pin-move/${targetCommit.slice(0, 7)}`;
      git(repo, "branch", existingBranch);
      const branchExists = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(branchExists, "repository_branch_exists");
      git(repo, "branch", "-D", existingBranch);

      commitIn(repo, "use foreign kernel remote", {
        "package.json": `${JSON.stringify(
          {
            name: "foreign",
            dependencies: {
              "agent-cli-kernel": `github:other/agent-cli-kernel#${trialBase}`,
            },
          },
          null,
          2,
        )}\n`,
      });
      const foreignPin = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(foreignPin, "repository_pin_missing");

      commitIn(repo, "drop kernel dependency", {
        "package.json": `${JSON.stringify({ name: "broken", dependencies: {} }, null, 2)}\n`,
      });
      const missingPin = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(missingPin, "repository_pin_missing");
    },
    processWatchdog(3),
  );

  test(
    "refuses a non-root repository path, detached HEAD, or symlinked package.json before changing anything",
    async () => {
      const repo = freshRepository("pin-move-invalid-");
      const subdir = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        join(repo, "src"),
      ]);
      expectRefused(subdir, "repository_invalid");
      expect(subdir.stderr).toContain("inside the repository above it");

      const detached = freshRepository("pin-move-detached-");
      git(detached, "checkout", "--quiet", "--detach", "HEAD");
      const detachedRun = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        detached,
      ]);
      expectRefused(detachedRun, "repository_invalid");
      expect(detachedRun.stderr).toContain("detached HEAD");

      const linked = freshRepository("pin-move-symlink-");
      const outside = join(folder("pin-move-outside-"), "outside.json");
      writeFileSync(outside, readFileSync(join(linked, "package.json")));
      rmSync(join(linked, "package.json"));
      symlinkSync(outside, join(linked, "package.json"));
      git(linked, "add", "--", "package.json");
      git(linked, "commit", "--quiet", "-m", "replace package.json with link");
      const linkRun = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        linked,
      ]);
      expectRefused(linkRun, "repository_invalid");
      expect(linkRun.stderr).toContain("symbolic link");
    },
    processWatchdog(3),
  );
});
