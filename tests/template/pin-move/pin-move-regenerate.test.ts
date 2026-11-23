import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import {
  expectRefused,
  installedKernelCommit,
  pinMoveRepositoryFixture,
} from "../../support/pin-move-repository-fixture.ts";
import { spawnBounded } from "../../support/process.ts";

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
    expect(run.stdout).toContain("  regenerated.txt\n");

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
    expect(failed.exit).toBe(1);
    expect(failed.stderr).toContain(
      `repository_check_failed: regenerate failed on branch ${branch} in ${realpathSync(repo)}:`,
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
      "Repair: Fix the failure regenerate reports, then run pin-move again.",
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

  test("no pin-move repair line tells the operator to force-delete a branch or to stash", () => {
    const sources = [
      "scripts/pin-move.ts",
      "scripts/pin-move-branch.ts",
      "scripts/pin-move-repository.ts",
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
