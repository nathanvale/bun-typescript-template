import { describe, expect, test } from "bun:test";
import {
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import {
  absentCommit,
  templateCommitHoldingS5,
  trialBase,
} from "../../support/kernel-sibling.ts";
import {
  checkFailureTest,
  cloneSpecifier,
  expectRefused,
  installedKernelCommit,
  pinMoveRepositoryFixture,
  updatedSkillDescription,
} from "../../support/pin-move-repository-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const fixture = pinMoveRepositoryFixture();
const { folder, freshRepository, installedRepository, runPinMove } = fixture;

describe("pin-move --repository", () => {
  test(
    "--plan prints kernel change notes and leaves the generated repository untouched on main",
    async () => {
      const repo = freshRepository("pin-move-plan-");
      const beforeHead = git(repo, "rev-parse", "HEAD");
      const run = await runPinMove([
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
        "--plan",
      ]);
      expect({ exit: run.exit, stderr: run.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(run.stdout).toContain(
        `Pin move report: ${trialBase} to ${fixture.targetCommit}`,
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
    const oldSpecifier = cloneSpecifier(fixture.kernelRepo, trialBase);
    const originalManifest = readFileSync(join(repo, "package.json"), "utf8");
    const withConfig = originalManifest.replace(
      `"version": "0.0.0",`,
      `"version": "0.0.0",\n  "config": {\n    "agent-cli-kernel": ${JSON.stringify(oldSpecifier)}\n  },`,
    );
    commitIn(repo, "add unrelated config entry matching old specifier", {
      "package.json": withConfig,
    });
    const mainBefore = git(repo, "rev-parse", "main");
    const expectedBranch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;
    const run = await runPinMove([
      fixture.targetCommit,
      "--kernel",
      fixture.kernelRepo,
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
        "agent-cli-kernel": cloneSpecifier(
          fixture.kernelRepo,
          fixture.targetCommit,
        ),
      },
    });
    expect(
      readFileSync(
        join(repo, ".agents/skills/agent-cli-kernel/SKILL.md"),
        "utf8",
      ),
    ).toContain(`Pinned commit: \`${fixture.targetCommit}\``);
    expect(
      readFileSync(
        join(repo, ".agents/skills/agent-cli-kernel/SKILL.md"),
        "utf8",
      ),
    ).toContain(`description: ${updatedSkillDescription}`);
    expect(
      readFileSync(join(repo, ".agents/skills/verify-cli/SKILL.md"), "utf8"),
    ).toContain(`Pinned commit: \`${fixture.targetCommit}\``);
  }, 180_000);

  test(
    "refuses when the generated repository working tree is dirty and creates no branch",
    async () => {
      const repo = freshRepository("pin-move-dirty-");
      writeFileSync(join(repo, "untracked.txt"), "local work\n");
      const run = await runPinMove([
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
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
        [
          fixture.nonKernelCommit,
          "--kernel",
          fixture.nonKernelRepo,
          "--repository",
          repo,
        ],
        fixture.nonKernelBin,
      );
      expectRefused(noDecl, "kernel_declaration_missing");

      const missing = await runPinMove([
        absentCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(missing, "kernel_commit_missing");

      const short = await runPinMove([
        fixture.targetCommit.slice(0, 10),
        "--kernel",
        fixture.kernelRepo,
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
        fixture.unpushedCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(unpushed, "kernel_commit_unreachable");

      const beforeCarryOut = await runPinMove([
        templateCommitHoldingS5,
        "--kernel",
        fixture.kernelRepo,
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
    const expectedBranch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;

    const run = await runPinMove([
      fixture.targetCommit,
      "--kernel",
      fixture.kernelRepo,
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
      `chore(kernel): failed Pin move from ${trialBase.slice(0, 7)} to ${fixture.targetCommit.slice(0, 7)} (repository_check_failed)`,
    );
    expect(git(repo, "show", `${expectedBranch}:package.json`)).toContain(
      cloneSpecifier(fixture.kernelRepo, fixture.targetCommit),
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
    const expectedBranch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;

    const run = await runPinMove([
      fixture.targetCommit,
      "--kernel",
      fixture.kernelRepo,
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
    expect(fixture.targetCommit).toStartWith(installedKernelCommit(repo));
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
          fixture.targetCommit,
          "--kernel",
          fixture.kernelRepo,
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
        fixture.kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(unchanged, "repository_pin_unchanged");

      const existingBranch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;
      git(repo, "branch", existingBranch);
      const branchExists = await runPinMove([
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
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
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
      ]);
      expectRefused(foreignPin, "repository_pin_missing");

      commitIn(repo, "drop kernel dependency", {
        "package.json": `${JSON.stringify({ name: "broken", dependencies: {} }, null, 2)}\n`,
      });
      const missingPin = await runPinMove([
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
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
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        join(repo, "src"),
      ]);
      expectRefused(subdir, "repository_invalid");
      expect(subdir.stderr).toContain("inside the repository above it");

      const detached = freshRepository("pin-move-detached-");
      git(detached, "checkout", "--quiet", "--detach", "HEAD");
      const detachedRun = await runPinMove([
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
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
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        linked,
      ]);
      expectRefused(linkRun, "repository_invalid");
      expect(linkRun.stderr).toContain("symbolic link");
    },
    processWatchdog(3),
  );
});
