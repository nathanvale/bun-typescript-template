import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { check, release } from "../../../scripts/check-commits.ts";
import {
  captured,
  createCommitCheckFixture,
  ledgered,
  ledgerScript,
  refusal,
} from "../../support/check-commits-in-process-fixture.ts";
import { git, worktreeLines } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const { folder, repositoryAt, inTemporaryFolder, worktreeAt } =
  createCommitCheckFixture();

const lockfileListingADroppedDependency = JSON.stringify({
  lockfileVersion: 1,
  workspaces: { "": { dependencies: { dep: "file:./dep" } } },
  packages: { dep: ["dep@file:dep", {}] },
});

describe("release", () => {
  test("a registered worktree is removed with its administrative folder", () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "plain");

    release(run, dir, admin);

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(worktreeLines(root)).toEqual([`worktree ${realpathSync(root)}`]);
  });

  test("a worktree git refuses to remove loses the administrative folder that still names it", async () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "locked");
    git(root, "worktree", "lock", dir);

    const shown = await captured(() => release(run, dir, admin));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(false);
    expect(worktreeLines(root)).toEqual([`worktree ${realpathSync(root)}`]);
    expect(shown.stderr).toBe("");
  });

  test("a worktree git refuses to remove keeps a registration that names another folder, and says how to repair it", async () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "moved");
    git(root, "worktree", "lock", dir);
    writeFileSync(join(admin, "gitdir"), join(dir, "elsewhere", ".git"));

    const shown = await captured(() => release(run, dir, admin));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(true);
    expect(shown.stderr).toBe(
      `git worktree remove failed for ${dir}, and ${admin} no longer names it, so that registration stays. Repair: git worktree prune\n`,
    );
  });

  test("a worktree git refuses to remove leaves another worktree's stale registration, which git worktree prune would delete", async () => {
    const { root, run } = repositoryAt();
    const stale = worktreeAt(root, "stale");
    rmSync(stale.dir, { recursive: true, force: true });
    const { dir, admin } = worktreeAt(root, "locked");
    git(root, "worktree", "lock", dir);

    await captured(() => release(run, dir, admin));

    expect(existsSync(admin)).toBe(false);
    expect(existsSync(stale.admin)).toBe(true);
  });

  test("a locked worktree whose administrative folder lost its gitdir file keeps that folder", async () => {
    const { root, run } = repositoryAt();
    const { dir, admin } = worktreeAt(root, "headless");
    git(root, "worktree", "lock", dir);
    rmSync(join(admin, "gitdir"));

    const shown = await captured(() => release(run, dir, admin));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(admin)).toBe(true);
    expect(shown.stderr).toContain("no longer names it");
  });

  test("a folder git does not know is deleted quietly when no administrative folder was found", async () => {
    const { root, run } = repositoryAt();
    const dir = join(folder("check-commits-process-tree-"), "unknown");
    mkdirSync(dir);
    writeFileSync(join(dir, "left-over"), "");

    const shown = await captured(() => release(run, dir, undefined));

    expect(existsSync(dir)).toBe(false);
    expect(shown.stderr).toBe("");
    expect(worktreeLines(root)).toHaveLength(1);
  });

  test("a folder git does not know is deleted quietly when its administrative folder is already gone", async () => {
    const { run } = repositoryAt();
    const dir = join(folder("check-commits-process-tree-"), "unknown");
    mkdirSync(dir);

    const shown = await captured(() =>
      release(run, dir, join(dir, "no-such-admin")),
    );

    expect(existsSync(dir)).toBe(false);
    expect(shown.stderr).toBe("");
  });

  test("a worktree git removed itself leaves any folder that was passed as its administrative folder alone", async () => {
    const { root, run } = repositoryAt();
    const { dir } = worktreeAt(root, "removed-by-git");
    const bystander = folder("check-commits-process-bystander-");
    writeFileSync(join(bystander, "gitdir"), join(dir, ".git"));

    const shown = await captured(() => release(run, dir, bystander));

    expect(existsSync(dir)).toBe(false);
    expect(existsSync(bystander)).toBe(true);
    expect(shown.stderr).toBe("");
  });
});

describe("check", () => {
  test(
    "a green commit runs typecheck then lint in a worktree under the temporary folder, is judged green, and leaves no worktree behind",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const places = `${ledger}-places`;
      const { root, commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(
            ledger,
            "typecheck",
            `pwd >> '${places}'; true`,
          ),
          lint: ledgerScript(ledger, "lint", `pwd >> '${places}'; true`),
        },
      });
      const green = commit("a green commit", { "a.txt": "a" });

      const { checked, temporary } = await inTemporaryFolder(
        async (temporary) => {
          const result = await check(run, green);
          expect(readdirSync(temporary)).toEqual([]);
          return { checked: result, temporary };
        },
      );

      const [first = "", second] = readFileSync(places, "utf8")
        .split("\n")
        .filter(Boolean);
      expect(checked).toEqual({ ...green, result: { status: "green" } });
      expect(ledgered(ledger)).toEqual(["typecheck", "lint"]);
      expect(dirname(first)).toBe(realpathSync(temporary));
      expect(basename(first).startsWith("check-commits-")).toBe(true);
      expect(second).toBe(first);
      expect(worktreeLines(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a failing typecheck is red at that step and lint never runs",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { root, commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "test ! -e type-error"),
          lint: ledgerScript(ledger, "lint", "true"),
        },
      });
      const red = commit("add a type error", { "type-error": "" });

      const checked = await check(run, red);

      expect(checked).toMatchObject({
        ...red,
        result: { status: "red", failed: ["run", "typecheck"] },
      });
      expect(checked.result).toHaveProperty(
        "output",
        expect.stringContaining('error: script "typecheck" exited with code 1'),
      );
      expect(ledgered(ledger)).toEqual(["typecheck"]);
      expect(worktreeLines(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a failing lint is red at that step after typecheck passed",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "true"),
          lint: ledgerScript(ledger, "lint", "test ! -e lint-error"),
        },
      });
      const red = commit("add a lint error", { "lint-error": "" });

      const checked = await check(run, red);

      expect(checked).toMatchObject({
        ...red,
        result: { status: "red", failed: ["run", "lint"] },
      });
      expect(checked.result).toHaveProperty(
        "output",
        expect.stringContaining('error: script "lint" exited with code 1'),
      );
      expect(ledgered(ledger)).toEqual(["typecheck", "lint"]);
    },
    processWatchdog(1),
  );

  test(
    "a lockfile that does not match its manifest is red at the frozen install, before any script runs",
    async () => {
      const ledger = join(folder("check-commits-process-ledger-"), "steps");
      const { commit, run } = repositoryAt({
        scripts: {
          typecheck: ledgerScript(ledger, "typecheck", "true"),
          lint: ledgerScript(ledger, "lint", "true"),
        },
      });
      const red = commit("keep a lockfile for a removed dependency", {
        "bun.lock": lockfileListingADroppedDependency,
      });

      const checked = await check(run, red);

      expect(checked).toMatchObject({
        ...red,
        result: { status: "red", failed: ["install", "--frozen-lockfile"] },
      });
      expect(checked.result).toHaveProperty(
        "output",
        expect.stringContaining(
          "error: lockfile had changes, but lockfile is frozen",
        ),
      );
      expect(ledgered(ledger)).toEqual([]);
    },
    processWatchdog(1),
  );

  test(
    "a commit git cannot check out is refused with git's own message and leaves no worktree behind",
    async () => {
      const { root, run } = repositoryAt();
      const sha = "0".repeat(40);

      await inTemporaryFolder(async (temporary) => {
        expect(
          await refusal(
            check(run, { sha, short: "0000000", subject: "no such commit" }),
          ),
        ).toBe(`fatal: invalid reference: ${sha}`);
        expect(readdirSync(temporary)).toEqual([]);
      });

      expect(worktreeLines(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a step killed by a signal gives no verdict, names the step and the commit, and leaves no worktree behind",
    async () => {
      const { root, commit, run } = repositoryAt({
        scripts: { typecheck: "kill -KILL $PPID", lint: "true" },
      });
      const killed = commit("kill the typecheck", { "a.txt": "a" });

      await inTemporaryFolder(async (temporary) => {
        expect(await refusal(check(run, killed))).toBe(
          `bun run typecheck was killed by SIGKILL while checking ${killed.short}, so it has no verdict.`,
        );
        expect(readdirSync(temporary)).toEqual([]);
      });

      expect(worktreeLines(root)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "a worktree a step locked is still released, with its administrative folder, and nothing is printed",
    async () => {
      const { root, run, commit } = repositoryAt({
        scripts: {
          typecheck: 'git worktree lock "$PWD"',
          lint: "true",
        },
      });
      const locked = commit("lock the worktree from a step", { "a.txt": "a" });

      const shown = await inTemporaryFolder(async (temporary) => {
        const result = await captured(() => check(run, locked));
        expect(readdirSync(temporary)).toEqual([]);
        return result;
      });

      expect(shown.value).toEqual({ ...locked, result: { status: "green" } });
      expect(shown.stderr).toBe("");
      expect(worktreeLines(root)).toEqual([`worktree ${realpathSync(root)}`]);
      expect(readdirSync(join(root, ".git", "worktrees"))).toEqual([]);
    },
    processWatchdog(1),
  );
});
