import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Fault, replayAll } from "../../../scripts/planted-faults.ts";
import {
  createPlantedFaultFixture,
  guarded,
  headOf,
  limitTests,
  type Planted,
  recorded,
  recordsPath,
  rejection,
  sample,
  stepVariable,
  unguarded,
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { commit, gitOutput, worktrees } from "../../support/git-fixture.ts";

const { isolated, planted, repository } = createPlantedFaultFixture();

describe("replayAll", () => {
  const environment = { [stepVariable]: "120" };

  async function replayedAll(
    root: string,
    ids: readonly string[] = [],
    env: Readonly<Record<string, string | undefined>> = environment,
  ) {
    return isolated(() => replayAll(root, ids, env));
  }

  function killedAndSurvivor(): Planted & { survivor: Fault } {
    const subject = planted();
    const survivor: Fault = {
      ...subject.fault,
      id: "weak",
      title: "^L\\.weak ",
    };
    recorded(subject.root, [subject.fault, survivor]);
    return { ...subject, survivor };
  }

  test("exits 0 and says so when every fault is KILLED", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = await replayedAll(subject.root);

    expect(run.result).toBe(0);
    const [verdict, summary, ...rest] = run.stdout.split("\n");
    expect(verdict).toMatch(
      new RegExp(
        `^KILLED ${subject.id} in [\\d.]+ s\\. Failed: L\\.refuses NaN \\| L\\.refuses NaN twice$`,
      ),
    );
    expect(summary).toMatch(
      new RegExp(
        `^1 of 1 planted faults KILLED in [\\d.]+ s, [\\d.]+ s per fault, with Bun ${Bun.version.replaceAll(".", "\\.")}\\.$`,
      ),
    );
    expect(rest).toEqual([""]);
    expect(run.stderr).toBe("");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays every record in order and exits 1 when one survives", async () => {
    const { root, id } = killedAndSurvivor();
    let wall = 0;

    const run = await isolated(async () => {
      const began = performance.now();
      try {
        return await replayAll(root, [], environment);
      } finally {
        wall = (performance.now() - began) / 1000;
      }
    });

    expect(run.result).toBe(1);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toStartWith(`KILLED ${id} in `);
    expect(lines[1]).toStartWith("SURVIVED weak in ");
    expect(lines[2]).toBe(
      "Repair: change tests/limit.test.ts so that test fails with the patch applied. Done when bun run fault-replay weak passes.",
    );
    expect(lines[3]).toMatch(
      /^1 of 2 planted faults KILLED in [\d.]+ s, [\d.]+ s per fault, with Bun /,
    );
    expect(run.leftovers).toEqual([]);
    const seconds = (line: string | undefined, after: string) =>
      Number(line?.match(new RegExp(`${after}(\\d+\\.\\d)`))?.[1]);
    const first = seconds(lines[0], " in ");
    const second = seconds(lines[1], " in ");
    const total = seconds(lines[3], "KILLED in ");
    const each = seconds(lines[3], " s, ");
    expect(first).toBeGreaterThanOrEqual(0);
    expect(second).toBeGreaterThanOrEqual(0);
    expect(first + second).toBeLessThanOrEqual(total + 0.2);
    expect(total).toBeLessThanOrEqual(wall + 0.06);
    expect(Math.abs(each * 2 - total)).toBeLessThanOrEqual(0.15);
  }, 60_000);

  test("replays only the records its ids name", async () => {
    const { root, id } = killedAndSurvivor();

    const run = await replayedAll(root, [id]);

    expect(run.result).toBe(0);
    expect(run.stdout).not.toContain("SURVIVED");
    expect(run.stdout).toContain("1 of 1 planted faults KILLED in ");
  }, 60_000);

  test("refuses an unknown id before replaying anything", async () => {
    const { root, id } = killedAndSurvivor();

    const run = await replayedAll(root, [id, "nope", "gone"]);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `No fault record nope, gone in ${recordsPath}. Repair: pass an id that file lists.\n`,
    );
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("reports an unknown id before it reads the step limit", async () => {
    const { root } = killedAndSurvivor();

    const run = await replayedAll(root, ["nope"], { [stepVariable]: "x" });

    expect(run.result).toBe(2);
    expect(run.stderr).toContain("No fault record nope in ");
  }, 60_000);

  test.each([
    ["no records file", null],
    ["an empty records list", "[]"],
  ])(
    "exits 1 and says it checks nothing with %s",
    async (_name, content) => {
      const root = repository("planted-faults-empty-");
      commit(root, "base", { "package.json": "{}" });
      if (content !== null) write(root, recordsPath, content);

      const run = await replayedAll(root);

      expect(run.result).toBe(1);
      expect(run.stdout).toBe(
        `${recordsPath} has no fault record, so this gate checks nothing. Repair: add one with bun run planted-fault:add, or remove the fault-replay gate.\n`,
      );
      expect(run.stderr).toBe("");
    },
    60_000,
  );

  test("refuses a step limit that is not a positive number", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = replayedAll(subject.root, [], { [stepVariable]: "-3" });

    expect(await rejection(run)).toBe(
      `${stepVariable} is '-3'. Repair: set it to a positive number of seconds, or unset it for 300 s.`,
    );
  }, 60_000);

  test("reports TIMEOUT with the limit in seconds and exits 1", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);

    const run = await replayedAll(subject.root, [], {
      [stepVariable]: "0.001",
    });

    expect(run.result).toBe(1);
    expect(run.stdout).toContain(
      "did not finish within 0.001 s, so the planted fault has no verdict.",
    );
    expect(run.stdout).toContain("0 of 1 planted faults KILLED in ");
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays uncommitted and untracked work, leaving the tree as it was", async () => {
    const root = repository("planted-faults-dirty-");
    commit(root, "base", {
      "package.json": JSON.stringify({ name: "fixture", private: true }),
      ".gitignore": "node_modules/\n",
      "src/limit.ts": unguarded,
    });
    const fault: Fault = {
      ...sample,
      id: "dirty-limit",
      patch: "tests/planted-faults/patches/dirty-limit.patch",
    };
    write(root, "src/limit.ts", guarded);
    write(
      root,
      fault.patch,
      gitOutput(root, "diff", "-R", "--", "src/limit.ts"),
    );
    write(root, "tests/limit.test.ts", limitTests);
    write(root, recordsPath, `${JSON.stringify([fault], null, 2)}\n`);
    const head = headOf(root);
    const status = gitOutput(root, "status", "--porcelain");

    const run = await replayedAll(root);

    expect(run.result).toBe(0);
    expect(run.stdout).toContain(`KILLED ${fault.id} in `);
    expect(headOf(root)).toBe(head);
    expect(gitOutput(root, "status", "--porcelain")).toBe(status);
    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(guarded);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("replays a clean tree at its own head", async () => {
    const subject = planted();
    recorded(subject.root, [subject.fault]);
    const head = headOf(subject.root);
    const objects = gitOutput(subject.root, "count-objects");

    const run = await replayedAll(subject.root);

    expect(run.result).toBe(0);
    expect(headOf(subject.root)).toBe(head);
    expect(gitOutput(subject.root, "status", "--porcelain")).toBe("");
    expect(gitOutput(subject.root, "count-objects")).toBe(objects);
  }, 60_000);
});
