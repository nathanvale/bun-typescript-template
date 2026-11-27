import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  failedAttempt,
  parseGitChanges,
  RepositoryPinRefusal,
  repositoryGit,
} from "../../../src/pin-move-branch.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import {
  expectRefused,
  installedKernelCommit,
  pinMoveRepositoryFixture,
} from "../../support/pin-move-repository-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const fixture = pinMoveRepositoryFixture();

const writesInstalledKernel = `bun -e "require('node:fs').writeFileSync('regenerated.txt', require('node:fs').readFileSync('node_modules/agent-cli-kernel/.bun-tag'))"`;
const writesThenExitsThree = `bun -e "require('node:fs').writeFileSync('regenerated.txt', 'partial'); process.exit(3)"`;

const regeneratedTest = `import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

test("regenerated.txt names the installed kernel", () => {
  const root = join(import.meta.dir, "..");
  expect(readFileSync(join(root, "regenerated.txt"), "utf8")).toBe(
    readFileSync(join(root, "node_modules/agent-cli-kernel/.bun-tag"), "utf8"),
  );
});
`;

function manifestWithRegenerate(repo: string, script: string): string {
  const manifest: unknown = JSON.parse(
    readFileSync(join(repo, "package.json"), "utf8"),
  );
  const scripts: unknown = Reflect.get(Object(manifest), "scripts");
  Reflect.set(Object(scripts), "regenerate", script);
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function regenerate(repo: string): Promise<void> {
  const run = await spawnBounded([process.execPath, "run", "regenerate"], {
    cwd: repo,
    env: fixture.pinMoveEnv(fixture.remoteBin),
    boundMilliseconds: 30_000,
  });
  expect({ exit: run.exit, stderr: run.stderr }).toMatchObject({ exit: 0 });
}

async function commitRegenerateStep(repo: string): Promise<void> {
  commitIn(repo, "add a regenerate step that writes the installed kernel", {
    "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
    "package.json": manifestWithRegenerate(repo, writesInstalledKernel),
    "tests/regenerated.test.ts": regeneratedTest,
  });
  await regenerate(repo);
  git(repo, "add", "--", "regenerated.txt");
  git(repo, "commit", "--quiet", "-m", "regenerate for the starting kernel");
}

function pinMoveBranches(repo: string): string[] {
  return gitOutput(
    repo,
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads/pin-move",
  )
    .split("\n")
    .filter((line) => line !== "");
}

function moveTo(repo: string) {
  return fixture.runPinMove([
    fixture.targetCommit,
    "--kernel",
    fixture.kernelRepo,
    "--repository",
    repo,
  ]);
}

function cleanStatus(repo: string): string {
  return gitOutput(repo, "status", "--porcelain", "--untracked-files=all");
}

describe("pin-move --repository with a regenerate step", () => {
  test("commits what the regenerate step changed with the Pin change, and a second regenerate or pin-move changes nothing", async () => {
    const repo = await fixture.installedRepository("pin-move-regenerate-");
    await commitRegenerateStep(repo);
    const branch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;
    const run = await moveTo(repo);
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(
      gitOutput(repo, "show", "--name-only", "--format=", "HEAD")
        .split("\n")
        .filter((line) => line !== ""),
    ).toEqual([
      ".agents/skills/agent-cli-kernel/SKILL.md",
      ".agents/skills/verify-cli/SKILL.md",
      `.changeset/kernel-pin-${fixture.targetCommit.slice(0, 7)}.md`,
      "bun.lock",
      "package.json",
      "regenerated.txt",
    ]);
    expect(fixture.targetCommit).toStartWith(installedKernelCommit(repo));
    expect(gitOutput(repo, "show", "HEAD:regenerated.txt")).toBe(
      readFileSync(
        join(repo, "node_modules/agent-cli-kernel/.bun-tag"),
        "utf8",
      ),
    );
    expect(run.stdout).toContain("regenerated.txt");

    await regenerate(repo);
    expect(cleanStatus(repo)).toBe("");
    const head = git(repo, "rev-parse", "HEAD");
    expectRefused(await moveTo(repo), "repository_pin_unchanged");
    expect(git(repo, "rev-parse", "HEAD")).toBe(head);
    expect(pinMoveBranches(repo)).toEqual([branch]);
    expect(cleanStatus(repo)).toBe("");
  }, 240_000);

  test("refuses when the regenerate step exits non-zero, keeps the attempt and its partial output on a renamed branch, and a rerun after the fix moves the Pin with no force", async () => {
    const repo = await fixture.installedRepository("pin-move-regenerate-fail-");
    commitIn(repo, "add a regenerate step that fails", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
      "package.json": manifestWithRegenerate(repo, writesThenExitsThree),
    });
    const mainBefore = git(repo, "rev-parse", "main");
    const branch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;

    const failed = await moveTo(repo);
    expect(failed.exit).toBe(3);
    expect(failed.stderr).toContain("[DOMAIN_PIN_REPOSITORY_CHECK_FAILED]");
    expect(failed.stderr).toContain(
      `regenerate failed on branch ${branch} in ${realpathSync(repo)}:`,
    );
    expect(failed.stderr).toContain("exited 3");
    const [kept = ""] = pinMoveBranches(repo);
    expect(pinMoveBranches(repo)).toEqual([
      `${branch}-failed-${git(repo, "rev-parse", "--short", kept)}`,
    ]);
    expect(failed.stderr).toContain(
      `The failed attempt is kept on branch ${kept} for inspection; main is checked out again and was not changed.`,
    );
    expect(failed.stderr).toContain(
      "Repair: Fix the failure regenerate reports, then run bun run pin:move again.",
    );
    expect(failed.stderr).not.toContain("branch -D");
    expect(failed.stderr).not.toContain("stash");
    expect(git(repo, "log", "-1", "--format=%s", kept)).toBe(
      `chore(kernel): failed Pin move from ${trialBase.slice(0, 7)} to ${fixture.targetCommit.slice(0, 7)} (repository_check_failed)`,
    );
    expect(git(repo, "show", `${kept}:regenerated.txt`)).toBe("partial");
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(git(repo, "rev-parse", "main")).toBe(mainBefore);
    expect(cleanStatus(repo)).toBe("");

    await commitRegenerateStep(repo);
    const rerun = await moveTo(repo);
    expect({ exit: rerun.exit, stderr: rerun.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
    expect(pinMoveBranches(repo)).toEqual([branch, kept]);
  }, 300_000);

  test("commits a regenerate step that renames a tracked file with git mv and creates a colon-prefixed file", async () => {
    const repo = await fixture.installedRepository("pin-move-rename-literal-");
    const renameAndLiteral = `bun -e "const fs = require('node:fs'); const cp = require('node:child_process'); if (fs.existsSync('old-name.txt')) cp.execFileSync('git', ['mv', '--', 'old-name.txt', 'new-name.txt']); fs.writeFileSync(':literal.txt', 'lit'); fs.writeFileSync('regenerated.txt', fs.readFileSync('node_modules/agent-cli-kernel/.bun-tag'))"`;
    commitIn(
      repo,
      "add tracked file and regenerate step that renames and writes colon file",
      {
        "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
        "old-name.txt": "before\n",
        "package.json": manifestWithRegenerate(repo, renameAndLiteral),
        "regenerated.txt": "old\n",
      },
    );

    const run = await moveTo(repo);
    expect({ exit: run.exit, stderr: run.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
    const committed = gitOutput(
      repo,
      "show",
      "--no-renames",
      "--name-only",
      "--format=",
      "HEAD",
    )
      .split("\n")
      .filter((line) => line !== "");
    expect(committed).toContain(":literal.txt");
    expect(committed).toContain("new-name.txt");
    expect(committed).toContain("old-name.txt");
    expect(committed).toContain("regenerated.txt");
    expect(
      gitOutput(repo, "ls-tree", "--name-only", "HEAD")
        .split("\n")
        .includes("old-name.txt"),
    ).toBe(false);
    expect(cleanStatus(repo)).toBe("");
  }, 240_000);

  test("when a pre-commit hook refuses the Pin move commit after regenerate deletes a tracked file, keeps the deletion on the renamed branch with a true repair", async () => {
    const repo = await fixture.installedRepository("pin-move-hook-delete-");
    const deletesTracked = `bun -e "const fs = require('node:fs'); fs.rmSync('delete-me.txt', { force: true }); fs.writeFileSync('regenerated.txt', fs.readFileSync('node_modules/agent-cli-kernel/.bun-tag'))"`;
    commitIn(repo, "add tracked file deleted by regenerate", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
      "delete-me.txt": "remove me\n",
      "package.json": manifestWithRegenerate(repo, deletesTracked),
      "regenerated.txt": "old\n",
    });
    const hook = join(repo, ".git", "hooks", "pre-commit");
    writeFileSync(hook, '#!/bin/sh\necho "pre-commit refused" >&2\nexit 1\n');
    chmodSync(hook, 0o755);
    const branch = `pin-move/${fixture.targetCommit.slice(0, 7)}`;

    const failed = await moveTo(repo);
    expect(failed.exit).toBe(3);
    expect(failed.stderr).toContain("[DOMAIN_PIN_MOVE_FAILED_RESTORED]");
    expect(failed.stderr).toContain("pre-commit refused");
    const [kept = ""] = pinMoveBranches(repo);
    expect(pinMoveBranches(repo)).toEqual([
      `${branch}-failed-${git(repo, "rev-parse", "--short", kept)}`,
    ]);
    expect(failed.stderr).toContain(
      `The failed attempt is kept on branch ${kept} for inspection; main is checked out again and was not changed.`,
    );
    expect(failed.stderr).toContain("Repair: Fix why git commit failed");
    expect(failed.stderr).not.toContain(
      `Commit the staged pin move on branch ${branch}`,
    );
    expect(
      gitOutput(repo, "ls-tree", "--name-only", kept)
        .split("\n")
        .includes("delete-me.txt"),
    ).toBe(false);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(cleanStatus(repo)).toBe("");
  }, 240_000);

  test("in process: parseGitChanges keeps both paths of a rename record and marks staged-only deletions", () => {
    const parsed = parseGitChanges(
      "R  new.txt\0old.txt\0D  del.txt\0 D unstaged.txt\0?? :literal.txt\0",
    );
    expect(parsed.all).toEqual([
      ":literal.txt",
      "del.txt",
      "new.txt",
      "old.txt",
      "unstaged.txt",
    ]);
    expect([...parsed.stagedOnly].sort()).toEqual([
      "del.txt",
      "new.txt",
      "old.txt",
    ]);
  });

  test("in process: when git branch -m times out during failed-attempt recovery, checkout still runs and the original failure and repair stay", async () => {
    const repo = testFolder("pin-move-rename-timeout-");
    try {
      git(repo, "init", "--quiet", "-b", "main");
      git(repo, "config", "user.email", "test@example.com");
      git(repo, "config", "user.name", "Test");
      commitIn(repo, "initial", { "package.json": "{}\n" });
      const branch = "pin-move/1234567";
      git(repo, "checkout", "--quiet", "-b", branch);
      writeFileSync(join(repo, "package.json"), '{"changed":true}\n');
      const original = new RepositoryPinRefusal(
        "repository_check_failed",
        "regenerate failed.",
        "Fix the failure regenerate reports, then run bun run pin:move again.",
      );
      const result = await failedAttempt(
        {
          repository: repo,
          startingRef: "main",
          branch,
          subject: "chore(kernel): failed Pin move from 0000000 to 1234567",
          edited: ["package.json"],
          kernelPackage: "agent-cli-kernel",
          startingPin: "0".repeat(40),
          regenerate: true,
          active: {},
        },
        original,
        false,
        (target, args) => {
          if (args[0] === "branch" && args[1] === "-m")
            throw new RepositoryPinRefusal(
              "repository_git_failed",
              `git ${args.join(" ")} did not finish within 20000 ms in ${target}.`,
              "Run git branch -m to see where it waits.",
            );
          return repositoryGit(target, args);
        },
      );
      expect(result).toBeInstanceOf(RepositoryPinRefusal);
      expect(result instanceof RepositoryPinRefusal ? result.code : "").toBe(
        "repository_check_failed",
      );
      expect(result.message).toContain(
        "Repair: Fix the failure regenerate reports, then run bun run pin:move again.",
      );
      expect(result.message).toContain(
        `pin move could not rename branch ${branch} to ${branch}-failed-`,
      );
      expect(result.message).toContain(
        `Rename it with git branch -m ${branch}`,
      );
      expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
      expect(cleanStatus(repo)).toBe("");
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("no pin move repair line tells the operator to force-delete a branch or to stash", () => {
    const sources = [
      "src/pin-move.ts",
      "src/pin-move-branch.ts",
      "scripts/pin-move-report.ts",
      "src/pin-move-repository.ts",
    ].map((file) => ({
      file,
      forbidden:
        /branch -D|--delete --force|stash/.exec(
          readFileSync(join(ROOT, file), "utf8"),
        )?.[0] ?? "",
    }));
    expect(sources).toEqual(
      sources.map(({ file }) => ({ file, forbidden: "" })),
    );
  });
});
