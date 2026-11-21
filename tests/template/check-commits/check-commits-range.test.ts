import { describe, expect, test } from "bun:test";
import { readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  checkCommitsFixture,
  linkedCheckout,
  manifest,
  markers,
  repository,
  verdicts,
} from "../../support/check-commits-fixture.ts";
import {
  gitEnv,
  git,
  inherited,
  worktreeLines,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const { folder, repositoryAt, checkCommits } = checkCommitsFixture();
const lockfileListingADroppedDependency = JSON.stringify({
  lockfileVersion: 1,
  workspaces: { "": { dependencies: { dep: "file:./dep" } } },
  packages: { dep: ["dep@file:dep", {}] },
});

function wrongBunRefusals(lines: readonly string[]): string[] {
  return lines.filter((line) =>
    line.startsWith(
      `FAIL bun: found Bun ${Bun.version}, pinned 0.0.1. Repair: `,
    ),
  );
}

function rerunOf(lines: readonly string[]): string {
  const line = lines.find((each) => each.startsWith("Rerun locally: "));
  if (line === undefined) throw new Error("No Rerun locally line.");
  return line.slice("Rerun locally: ".length);
}

async function paste(root: string, command: string) {
  const run = await spawnBounded(["sh", "-c", command], {
    cwd: root,
    env: { ...inherited(), ...gitEnv },
  });
  const output = run.stdout + run.stderr;
  return { exit: run.exit, output, lines: output.split("\n") };
}

describe("check:commits", () => {
  test(
    "a red commit is named with the command that failed, and its rerun fails at the same command",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const pasted = await paste(root, rerunOf(run.lines));

      for (const lines of [run.lines, pasted.lines]) {
        expect(lines).toContain(`RED ${red.short} add a lint error`);
        expect(lines).toContain("Failed: bun run lint");
      }
      expect(run.exit).toBe(1);
      expect(pasted.exit).toBe(1);
    },
    processWatchdog(2),
  );

  test(
    "a commit that fails the real TypeScript compiler stays red after a later fix",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: {
          ...markers,
          typecheck: `"${join(repository, "node_modules/.bin/tsc")}" --noEmit typed.ts`,
        },
      });
      const green = commit("type a number", {
        "typed.ts": "export const count: number = 1;\n",
      });
      const red = commit("assign a string to the number", {
        "typed.ts": 'export const count: number = "one";\n',
      });
      const fix = commit("assign a number again", {
        "typed.ts": "export const count: number = 2;\n",
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`GREEN ${green.short} type a number`);
      expect(run.lines).toContain(
        `RED ${red.short} assign a string to the number`,
      );
      expect(run.lines).toContain("Failed: bun run typecheck");
      expect(run.lines).toContain(
        `Repair: change ${red.short} itself so that bun run typecheck passes at that commit.`,
      );
      expect(run.lines).toContain(
        "typed.ts(1,14): error TS2322: Type 'string' is not assignable to type 'number'.",
      );
      expect(run.lines).toContain(`GREEN ${fix.short} assign a number again`);
      expect(
        run.lines.filter((line) => line.startsWith("1 of 3 commits are red")),
      ).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "the rerun checks out the red commit, not the head that fixed it",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a type error", { "type-error": "" });
      const fix = commit("remove the type error", { "type-error": null });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const pasted = await paste(root, rerunOf(run.lines));

      expect(run.lines).toContain(`GREEN ${fix.short} remove the type error`);
      expect(pasted.exit).toBe(1);
      expect(verdicts(pasted.lines)).toEqual([
        `RED ${red.short} add a type error`,
      ]);
    },
    processWatchdog(2),
  );

  test(
    "a commit whose lockfile does not match its manifest is red at bun install --frozen-lockfile",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("keep a lockfile for a removed dependency", {
        "bun.lock": lockfileListingADroppedDependency,
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `RED ${red.short} keep a lockfile for a removed dependency`,
      );
      expect(run.lines).toContain("Failed: bun install --frozen-lockfile");
      expect(run.lines).toContain(
        "error: lockfile had changes, but lockfile is frozen",
      );
    },
    processWatchdog(1),
  );

  test(
    "a clean range is reported oldest first and exits 0 with a one-line summary",
    async () => {
      const { root, base, commit } = repositoryAt();
      const first = commit("first green", { "a.txt": "a" });
      const second = commit("second green", { "b.txt": "b" });

      const run = await checkCommits(root, [base.sha, second.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(0);
      expect(verdicts(run.lines)).toEqual([
        `GREEN ${first.short} first green`,
        `GREEN ${second.short} second green`,
      ]);
      expect(
        run.lines.filter((line) =>
          line.startsWith("Checked 2 commits: all green"),
        ),
      ).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "an empty range checks nothing and fails, naming the range",
    async () => {
      const { root, base } = repositoryAt();

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `No commits in ${base.sha}..HEAD to check, so this gate checks nothing. Repair: name a base that HEAD is ahead of.`,
      );
    },
    processWatchdog(1),
  );

  test(
    "a commit that is an ancestor of since is skipped",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("red before since", { "type-error": "" });
      const after = commit("fixed after since", { "type-error": null });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: red.sha,
      });

      expect(run.exit).toBe(0);
      expect(run.lines).toContain(`GREEN ${after.short} fixed after since`);
      expect(run.stdout).not.toContain(red.short);
    },
    processWatchdog(1),
  );

  test(
    "a since commit missing from the clone checks every commit in the range",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("red with no since in the clone", {
        "type-error": "",
      });

      const run = await checkCommits(root, [base.sha]);

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `since f20777f7e67d300ade253060fa2ba36f38c0ca43 is not in this clone, so every commit in ${base.sha}..HEAD is checked.`,
      );
      expect(run.lines).toContain(
        `RED ${red.short} red with no since in the clone`,
      );
    },
    processWatchdog(1),
  );

  test(
    "a merge commit is checked at its own tree, not at a parent",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: { ...markers, lint: "test ! -e left -o ! -e right" },
      });
      git(root, "switch", "--quiet", "--create", "side");
      const left = commit("add left", { left: "" });
      git(root, "switch", "--quiet", "main");
      const right = commit("add right", { right: "" });
      git(root, "merge", "--quiet", "--no-ff", "-m", "merge side", "side");
      const merge = git(root, "rev-parse", "--short", "HEAD");

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(`GREEN ${left.short} add left`);
      expect(run.lines).toContain(`GREEN ${right.short} add right`);
      expect(run.lines).toContain(`RED ${merge} merge side`);

      const pasted = await paste(root, rerunOf(run.lines));

      expect(pasted.exit).toBe(1);
      expect(verdicts(pasted.lines)).toEqual([`RED ${merge} merge side`]);
    },
    processWatchdog(2),
  );

  test(
    "a commit is judged only with the tools its own tree installs",
    async () => {
      const { root, base, commit } = repositoryAt({
        scripts: { ...markers, typecheck: "fallow --version" },
      });
      const red = commit("use a tool this commit does not install", {
        "a.txt": "a",
      });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(run.lines).toContain(
        `RED ${red.short} use a tool this commit does not install`,
      );
      expect(run.lines).toContain("Failed: bun run typecheck");
      expect(run.stdout).toContain(
        'error: script "typecheck" exited with code 127',
      );

      const pasted = await paste(root, rerunOf(run.lines));

      expect(pasted.exit).toBe(1);
      expect(verdicts(pasted.lines)).toEqual([
        `RED ${red.short} use a tool this commit does not install`,
      ]);
      expect(pasted.output).toContain(
        'error: script "typecheck" exited with code 127',
      );
    },
    processWatchdog(2),
  );

  test(
    "the printed rerun reproduces the failure when pasted twice from a linked checkout, and leaves no worktree",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });
      const caller = linkedCheckout(root);
      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      const rerun = rerunOf(run.lines);

      const first = await paste(caller, rerun);
      const second = await paste(caller, rerun);

      for (const pasted of [first, second]) {
        expect(pasted.exit).toBe(1);
        expect(verdicts(pasted.lines)).toEqual([
          `RED ${red.short} add a lint error`,
        ]);
        expect(pasted.lines).toContain(
          'error: script "lint" exited with code 1',
        );
      }
      expect(worktreeLines(root).sort()).toEqual(
        [root, caller].map((path) => `worktree ${realpathSync(path)}`).sort(),
      );
    },
    processWatchdog(3),
  );

  test(
    "the printed rerun refuses a Bun other than the pin before it touches the red commit",
    async () => {
      const { root, base, commit } = repositoryAt();
      const red = commit("add a lint error", { "lint-error": "" });
      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });
      writeFileSync(join(root, "package.json"), manifest("0.0.1", markers));

      const pasted = await paste(root, rerunOf(run.lines));

      expect(run.lines).toContain(`RED ${red.short} add a lint error`);
      expect(pasted.exit).toBe(1);
      expect(wrongBunRefusals(pasted.lines)).toHaveLength(1);
      expect(verdicts(pasted.lines)).toEqual([]);
      expect(worktreeLines(root)).toHaveLength(1);
    },
    processWatchdog(2),
  );

  test("the hosted commits job runs each commit's steps with no stored git token", async () => {
    const workflow = Bun.YAML.parse(
      await Bun.file(join(repository, ".github/workflows/ci.yml")).text(),
    ) as {
      jobs: {
        commits: { steps: { uses?: string; with?: Record<string, unknown> }[] };
      };
    };
    const checkout = workflow.jobs.commits.steps.find((step) =>
      step.uses?.startsWith("actions/checkout@"),
    );

    expect(checkout?.with).toMatchObject({
      "fetch-depth": 0,
      "persist-credentials": false,
    });
  });

  test(
    "a caller's git location variables, as a git hook sets them, never reach the fixture",
    async () => {
      const planted = folder("check-commits-planted-");
      const location = {
        GIT_DIR: join(planted, "dir"),
        GIT_INDEX_FILE: join(planted, "index"),
      };
      Object.assign(process.env, location);
      try {
        const { root, base, commit } = repositoryAt();
        const green = commit("green under a hook", { "a.txt": "a" });

        const run = await checkCommits(root, [base.sha], {
          CHECK_COMMITS_SINCE: base.sha,
        });

        expect(run.exit).toBe(0);
        expect(verdicts(run.lines)).toEqual([
          `GREEN ${green.short} green under a hook`,
        ]);
        expect(readdirSync(planted)).toEqual([]);
      } finally {
        for (const name of Object.keys(location)) delete process.env[name];
      }
    },
    processWatchdog(1),
  );

  test(
    "a running Bun other than the pin refuses before checking any commit",
    async () => {
      const { root, base, commit } = repositoryAt({ pin: "0.0.1" });
      commit("never checked", { "a.txt": "a" });

      const run = await checkCommits(root, [base.sha], {
        CHECK_COMMITS_SINCE: base.sha,
      });

      expect(run.exit).toBe(1);
      expect(wrongBunRefusals(run.lines)).toHaveLength(1);
      expect(run.lines).toContain(
        "Refused: repair the doctor's FAIL lines, then rerun.",
      );
      expect(verdicts(run.lines)).toEqual([]);
    },
    processWatchdog(1),
  );
});
