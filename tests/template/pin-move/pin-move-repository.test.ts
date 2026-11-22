import { afterAll, beforeAll, describe, expect, test } from "bun:test";
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

const updatedSkillDescription =
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

function cloneSpecifier(repository: string, commit: string): string {
  return `git+${pathToFileURL(realpathSync(repository)).href}#${commit}`;
}

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
    expect(readFileSync(join(repo, "package.json"), "utf8")).toContain(
      cloneSpecifier(kernelRepo, targetCommit),
    );
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
      expect({ exit: run.exit, stdout: run.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(run.stderr).toContain("repository_dirty:");
      expect(run.stderr).toContain("Repair:");
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
      expect({ exit: noDecl.exit, stdout: noDecl.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(noDecl.stderr).toContain("kernel_declaration_missing:");
      expect(noDecl.stderr).toContain("Repair:");

      const missing = await runPinMove([
        absentCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expect({ exit: missing.exit, stdout: missing.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(missing.stderr).toContain("kernel_commit_missing:");
      expect(missing.stderr).toContain("Repair:");

      const short = await runPinMove([
        targetCommit.slice(0, 10),
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expect({ exit: short.exit, stdout: short.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(short.stderr).toContain("kernel_commit_abbreviated:");
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
      expect({ exit: unpushed.exit, stdout: unpushed.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(unpushed.stderr).toContain("kernel_commit_unreachable:");
      expect(unpushed.stderr).toContain("Repair:");

      const beforeCarryOut = await runPinMove([
        templateCommitHoldingS5,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expect({
        exit: beforeCarryOut.exit,
        stdout: beforeCarryOut.stdout,
      }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(beforeCarryOut.stderr).toContain(
        "kernel_commit_before_carry_out:",
      );
      expect(beforeCarryOut.stderr).toContain("Repair:");
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(gitOutput(repo, "branch", "--list", "pin-move/*")).toBe("");
    },
    processWatchdog(3),
  );

  test("refuses when the generated repository check fails after the move, leaves the pin-move branch checked out for inspection, and leaves main untouched", async () => {
    const repo = freshRepository("pin-move-check-fail-");
    commitIn(repo, "add test that fails once the Pin moves", {
      "tests/check-failure.test.ts": `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("pins only the older commit", () => {
  expect(readFileSync(join(import.meta.dir, "../package.json"), "utf8")).toContain(${JSON.stringify(trialBase)});
});
`,
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
      `Branch ${expectedBranch} was left checked out for inspection; main was not changed.`,
    );
    expect(run.stderr).toContain("Repair:");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(expectedBranch);
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(readFileSync(join(repo, "package.json"), "utf8")).toContain(
      cloneSpecifier(kernelRepo, targetCommit),
    );
  }, 180_000);

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
      expect({ exit: unchanged.exit, stdout: unchanged.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(unchanged.stderr).toContain("repository_pin_unchanged:");
      expect(unchanged.stderr).toContain("Repair:");

      const existingBranch = `pin-move/${targetCommit.slice(0, 7)}`;
      git(repo, "branch", existingBranch);
      const branchExists = await runPinMove([
        targetCommit,
        "--kernel",
        kernelRepo,
        "--repository",
        repo,
      ]);
      expect({ exit: branchExists.exit, stdout: branchExists.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(branchExists.stderr).toContain("repository_branch_exists:");
      expect(branchExists.stderr).toContain("Repair:");
      git(repo, "branch", "-D", existingBranch);

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
      expect({ exit: missingPin.exit, stdout: missingPin.stdout }).toEqual({
        exit: 1,
        stdout: "",
      });
      expect(missingPin.stderr).toContain("repository_pin_missing:");
      expect(missingPin.stderr).toContain("Repair:");
    },
    processWatchdog(3),
  );
});
