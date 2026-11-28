import { describe, expect, test } from "bun:test";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  failedAttempt,
  RepositoryPinRefusal,
} from "../../../src/pin-move-branch.ts";
import { CliError } from "../../../src/cli-error.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { commitIn, git, gitEnv, gitOutput } from "../../support/git-fixture.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import {
  expectRefused,
  pinMoveRepositoryFixture,
} from "../../support/pin-move-repository-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { withEnvironment } from "../../support/recipe-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";

const fixture = pinMoveRepositoryFixture();
const { freshRepository } = fixture;
const templateLockfile = readFileSync(
  join(ROOT, "generated-repository/bun.lock"),
  "utf8",
);

function changesetEnv() {
  const base = fixture.pinMoveEnv(fixture.remoteBin);
  const sharedCache = process.env.BUN_INSTALL_CACHE_DIR;
  return sharedCache ? { ...base, BUN_INSTALL_CACHE_DIR: sharedCache } : base;
}

function runPinMove(args: readonly string[], boundMilliseconds = 120_000) {
  const route = args.includes("--plan")
    ? ["pin", "plan", ...args.filter((arg) => arg !== "--plan")]
    : ["pin", "move", ...args];
  return spawnBounded([process.execPath, join(ROOT, "src/cli.ts"), ...route], {
    cwd: ROOT,
    env: changesetEnv(),
    boundMilliseconds,
  });
}

function lockedRepository(prefix: string): string {
  const repo = freshRepository(prefix);
  commitIn(repo, "record generated lockfile", {
    "bun.lock": templateLockfile,
  });
  return repo;
}

function branchChangesetFiles(repo: string, branch: string): string[] {
  return gitOutput(repo, "ls-tree", "-r", "--name-only", branch, ".changeset")
    .split("\n")
    .filter(
      (path) =>
        path.startsWith(".changeset/") &&
        path.endsWith(".md") &&
        path !== ".changeset/README.md",
    );
}

describe("pin-move --repository changeset", () => {
  test("writes one patch changeset on a Pin move so check:changesets passes, and a rerun leaves one", async () => {
    const repo = lockedRepository("pin-move-changeset-");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const old7 = trialBase.slice(0, 7);
    const new7 = fixture.targetCommit.slice(0, 7);
    const expectedBranch = `pin-move/${new7}`;
    const expectedPath = `.changeset/kernel-pin-${new7}.md`;

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
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(expectedBranch);
    expect(branchChangesetFiles(repo, expectedBranch)).toEqual([expectedPath]);
    const content = gitOutput(
      repo,
      "show",
      `${expectedBranch}:${expectedPath}`,
    );
    expect(content).toContain('"doorway-fixture": patch');
    expect(content).toContain(`Moved the kernel Pin from ${old7} to ${new7}`);

    const checkRun = await spawnBounded(
      [process.execPath, "run", "check:changesets"],
      {
        cwd: repo,
        env: changesetEnv(),
        processGroup: true,
      },
    );
    expect(checkRun.exit).toBe(0);

    const rerun = await runPinMove([
      fixture.targetCommit,
      "--kernel",
      fixture.kernelRepo,
      "--repository",
      repo,
    ]);
    expectRefused(rerun, "repository_pin_unchanged");
    expect(branchChangesetFiles(repo, expectedBranch)).toEqual([expectedPath]);
    expect(
      gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
    ).toBe("");
  }, 180_000);

  test('commits both sides of the changeset rename when .changeset/config.json sets "commit": true', async () => {
    const repo = lockedRepository("pin-move-commit-true-changeset-");
    const configText = readFileSync(
      join(repo, ".changeset/config.json"),
      "utf8",
    );
    const updatedConfig = configText.replace(
      '"commit": false',
      '"commit": true',
    );
    expect(updatedConfig).not.toBe(configText);
    commitIn(repo, "enable changesets commit mode", {
      ".changeset/config.json": updatedConfig,
    });
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    const new7 = fixture.targetCommit.slice(0, 7);
    const expectedBranch = `pin-move/${new7}`;
    const expectedPath = `.changeset/kernel-pin-${new7}.md`;

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
    expect(
      gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
    ).toBe("");
    expect(branchChangesetFiles(repo, "HEAD")).toEqual([expectedPath]);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(expectedBranch);

    const rerun = await runPinMove([
      fixture.targetCommit,
      "--kernel",
      fixture.kernelRepo,
      "--repository",
      repo,
    ]);
    expectRefused(rerun, "repository_pin_unchanged");
  }, 180_000);

  test("does not let an empty changeset already on the branch suppress the Pin move changeset", async () => {
    const repo = lockedRepository("pin-move-empty-changeset-");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "--quiet", "-b", "feat/empty-changeset");
    commitIn(repo, "add empty changeset", {
      ".changeset/empty-note.md": "---\n---\n\nNo release bump.\n",
    });
    const old7 = trialBase.slice(0, 7);
    const new7 = fixture.targetCommit.slice(0, 7);
    const expectedBranch = `pin-move/${new7}`;
    const expectedPath = `.changeset/kernel-pin-${new7}.md`;

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
    expect(branchChangesetFiles(repo, expectedBranch)).toEqual([
      ".changeset/empty-note.md",
      expectedPath,
    ]);
    const content = gitOutput(
      repo,
      "show",
      `${expectedBranch}:${expectedPath}`,
    );
    expect(content).toContain('"doorway-fixture": patch');
    expect(content).toContain(`Moved the kernel Pin from ${old7} to ${new7}`);
  }, 180_000);

  test("keeps an existing package-bumping changeset already on the branch and writes no second one", async () => {
    const repo = lockedRepository("pin-move-existing-changeset-");
    git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
    git(repo, "checkout", "--quiet", "-b", "feat/existing-changeset");
    commitIn(repo, "add existing changeset", {
      ".changeset/existing-work.md":
        '---\n"doorway-fixture": minor\n---\n\nExisting branch change.\n',
    });
    const new7 = fixture.targetCommit.slice(0, 7);
    const expectedBranch = `pin-move/${new7}`;

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
    expect(branchChangesetFiles(repo, expectedBranch)).toEqual([
      ".changeset/existing-work.md",
    ]);
  }, 180_000);

  test(
    "--plan prints the Changeset line when it would write one and omits it when unchanged or already covered",
    async () => {
      const repo = lockedRepository("pin-move-plan-changeset-");
      const old7 = trialBase.slice(0, 7);
      const new7 = fixture.targetCommit.slice(0, 7);
      const expectedLine = `Changeset: .changeset/kernel-pin-${new7}.md (patch, Moved the kernel Pin from ${old7} to ${new7})`;
      const planArgs = (commit: string) => [
        commit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
        "--plan",
      ];

      const covered = await runPinMove(planArgs(fixture.targetCommit), 15_000);
      expect({ exit: covered.exit, stderr: covered.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(covered.stdout).toContain(expectedLine);

      const unchanged = await runPinMove(planArgs(trialBase), 15_000);
      expect({ exit: unchanged.exit, stderr: unchanged.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(unchanged.stdout).not.toContain("Changeset:");

      git(repo, "update-ref", "refs/remotes/origin/main", "HEAD");
      git(repo, "checkout", "--quiet", "-b", "feat/plan-empty");
      commitIn(repo, "add empty changeset", {
        ".changeset/empty-note.md": "---\n---\n\nNo release bump.\n",
      });
      const withEmpty = await runPinMove(
        planArgs(fixture.targetCommit),
        15_000,
      );
      expect({ exit: withEmpty.exit, stderr: withEmpty.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(withEmpty.stdout).toContain(expectedLine);

      commitIn(repo, "add package changeset", {
        ".changeset/existing-work.md":
          '---\n"doorway-fixture": minor\n---\n\nExisting branch change.\n',
      });
      const withPackage = await runPinMove(
        planArgs(fixture.targetCommit),
        15_000,
      );
      expect({ exit: withPackage.exit, stderr: withPackage.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      expect(withPackage.stdout).not.toContain("Changeset:");
    },
    processWatchdog(3),
  );

  test("in process: failedAttempt preserves a CliError code, message, and repair as a RepositoryPinRefusal", async () => {
    const repo = testFolder("pin-move-cli-error-");
    try {
      git(repo, "init", "--quiet", "-b", "main");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test");
      commitIn(repo, "initial", { "package.json": "{}\n" });
      const branch = "pin-move/1234567";
      git(repo, "checkout", "--quiet", "-b", branch);
      writeFileSync(join(repo, "package.json"), '{"changed":true}\n');
      const error = new CliError(
        "changeset_add_failed",
        "cannot write changeset",
        "add the changeset by hand, then rerun",
        1,
        false,
      );
      const result = await withEnvironment(gitEnv, () =>
        failedAttempt(
          {
            repository: repo,
            startingRef: "main",
            branch,
            subject: "chore(kernel): failed Pin move from 0000000 to 1234567",
            edited: ["package.json"],
            kernelPackage: "agent-cli-kernel",
            startingPin: "0".repeat(40),
            regenerate: false,
            active: {},
          },
          error,
          false,
        ),
      );
      expect(result).toBeInstanceOf(RepositoryPinRefusal);
      expect(result instanceof RepositoryPinRefusal ? result.code : "").toBe(
        "changeset_add_failed",
      );
      expect(result.message).toContain("cannot write changeset");
      expect(result.message).toContain(
        "Repair: add the changeset by hand, then rerun",
      );
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
