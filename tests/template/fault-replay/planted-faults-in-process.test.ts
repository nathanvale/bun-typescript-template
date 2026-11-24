import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Verdict } from "../../../scripts/planted-fault-verdict.ts";
import { type Fault, replay } from "../../../scripts/planted-faults.ts";
import {
  createPlantedFaultFixture,
  guarded,
  headOf,
  limitTests,
  type Planted,
  rejection,
  unguarded,
} from "../../support/planted-fault-in-process-fixture.ts";
import { testRunFiles, write } from "../../support/fixture-files.ts";
import { gitOutput, commit, worktrees } from "../../support/git-fixture.ts";

const { isolated, planted } = createPlantedFaultFixture();

const killedBy = ["L.refuses NaN", "L.refuses NaN twice"];

const redTest = `test("L.red is red without the fault", () => {
  expect(limit(1)).toBe(2);
});
`;

const guardLine =
  'if (Number.isNaN(value)) throw new TypeError("limit must be a number");';

const insertion = `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,3 +1,4 @@
 export function limit(value: number): number {
+  if (Number.isNaN(value)) return value;
   ${guardLine}
   return value;
`;

const twoRegions = `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,4 +1,3 @@
 export function limit(value: number): number {
-  ${guardLine}
   return value;
-}
+};
`;

function ambiguous(places: string, count = 2): string {
  return `anchor ambiguous: the removed text of hunk 1, starting "${guardLine}", is at ${count} places: ${places}. Its context lines do not choose one, and a planted fault in the wrong place still fails its test, so it was not applied.`;
}

function renamed(
  root: string,
  extra: Record<string, string | null> = {},
): void {
  gitOutput(root, "mv", "src/limit.ts", "src/bound.ts");
  commit(root, "rename limit to bound", {
    "tests/limit.test.ts": limitTests.replace(
      "../src/limit.ts",
      "../src/bound.ts",
    ),
    ...extra,
  });
}

function outputOf(verdict: Verdict): string {
  if (verdict.kind === "STALE" || verdict.kind === "BROKEN")
    return verdict.output;
  throw new Error(`${verdict.kind} carries no output.`);
}

describe("replay", () => {
  const limit = 120_000;

  async function replayed(subject: Planted, overrides: Partial<Fault> = {}) {
    return isolated(() =>
      replay(
        subject.root,
        { ...subject.fault, ...overrides },
        headOf(subject.root),
        limit,
      ),
    );
  }

  test("KILLED lists, in file order, every test that fails once the fault is applied", async () => {
    const subject = planted();

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
    expect(run.stdout).toBe("");
  }, 60_000);

  test("SURVIVED when the named test still passes with the fault applied", async () => {
    const subject = planted();

    const run = await replayed(subject, { title: "^L\\.weak " });

    expect(run.result).toEqual({ kind: "SURVIVED" });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("KILLED when the guarded line's neighbours changed after the patch was made", async () => {
    const subject = planted();
    commit(subject.root, "return the number", {
      "src/limit.ts": guarded.replace("return value;", "return Number(value);"),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("KILLED in the tracked file its guarded text moved to", async () => {
    const subject = planted();
    renamed(subject.root);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("STALE anchor ambiguous, naming each place, when its moved guarded text is in two tracked files", async () => {
    const subject = planted();
    renamed(subject.root, { "src/copy.ts": guarded });
    const status = gitOutput(subject.root, "status", "--porcelain");

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: ambiguous("src/bound.ts:2, src/copy.ts:2"),
    });
    expect(gitOutput(subject.root, "status", "--porcelain")).toBe(status);
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("STALE anchor ambiguous at only the real blank lines when its moved removed text is one blank line", async () => {
    const subject = planted();
    write(
      subject.root,
      subject.fault.patch,
      `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -2,3 +2,2 @@
   ${guardLine}
-
   return value;
`,
    );
    const spaced = guarded.replace("  return value;", "\n  return value;");
    renamed(subject.root, {
      "src/bound.ts": spaced,
      "src/copy.ts": spaced,
      ...Object.fromEntries(
        Object.keys(testRunFiles()).map((path) => [path, null]),
      ),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: `anchor ambiguous: the removed text of hunk 1, starting "", is at 3 places: src/bound.ts:3, src/copy.ts:3, tests/limit.test.ts:3. Its context lines do not choose one, and a planted fault in the wrong place still fails its test, so it was not applied.`,
    });
  }, 60_000);

  test("STALE anchor ambiguous when its guarded text and context occur twice in its file", async () => {
    const subject = planted();
    commit(subject.root, "show the source", {
      "src/limit.ts": `${guarded}\nexport const shown = \`\n${guarded}\`;\n`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: ambiguous("src/limit.ts:2, src/limit.ts:8"),
    });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test.each([
    [10, ""],
    [11, ", and 1 more"],
  ])(
    "STALE anchor ambiguous at %i places names at most ten of them",
    async (count, more) => {
      const subject = planted();
      const copies = Array.from(
        { length: count - 1 },
        (_, index) => `\nexport const shown${index} = \`\n${guarded}\`;\n`,
      );
      const text = [guarded, ...copies].join("");
      commit(subject.root, "show the source", { "src/limit.ts": text });
      const lines = text.split("\n");
      const places = lines.flatMap((line, index) =>
        line === `  ${guardLine}` ? [`src/limit.ts:${index + 1}`] : [],
      );

      const run = await replayed(subject);

      expect(places).toHaveLength(count);
      expect(run.result).toEqual({
        kind: "STALE",
        output: ambiguous(`${places.slice(0, 10).join(", ")}${more}`, count),
      });
    },
    60_000,
  );

  test("KILLED where its context lines choose one of two places holding its guarded text", async () => {
    const subject = planted();
    const copy = guarded.replace("function limit", "function shown");
    commit(subject.root, "show the source", {
      "src/limit.ts": `${guarded}\nexport const shown = \`\n${copy}\`;\n`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  function twoPlaces(
    first: { head: string; tail: string },
    second: { head: string; tail: string },
  ): string {
    const place = (name: string, { head, tail }: typeof first) =>
      guarded
        .replace("function limit", `function ${name}`)
        .replace("number {", head)
        .replace("return value;", tail);
    return `${place("limit", first)}\n${place("shown", second)}`;
  }

  const drifted = "number | string {";

  test("KILLED where only the line after its guarded text chooses one of two places, though the line before drifted at both", async () => {
    const subject = planted();
    commit(subject.root, "widen and show", {
      "src/limit.ts": twoPlaces(
        { head: drifted, tail: "return value;" },
        { head: drifted, tail: "return Number(value);" },
      ),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test.each([
    [
      "no side separates them",
      { head: drifted, tail: "return value;" },
      { head: drifted, tail: "return value;" },
    ],
    [
      "each side prefers a different place",
      { head: "number {", tail: "return Number(value);" },
      { head: drifted, tail: "return value;" },
    ],
  ])(
    "STALE anchor ambiguous when %s",
    async (_name, first, second) => {
      const subject = planted();
      commit(subject.root, "show the source", {
        "src/limit.ts": twoPlaces(first, second),
      });

      const run = await replayed(subject);

      expect(run.result).toEqual({
        kind: "STALE",
        output: ambiguous("src/limit.ts:2, src/limit.ts:7"),
      });
    },
    60_000,
  );

  test("STALE anchor absent when the guarded line itself was edited", async () => {
    const subject = planted();
    commit(subject.root, "reword the refusal", {
      "src/limit.ts": guarded.replace("must be", "has to be"),
      "tests/limit.test.ts": limitTests.replaceAll("must be", "has to be"),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: `anchor absent: the removed text of hunk 1, starting "${guardLine}", is not in src/limit.ts or any other tracked file.`,
    });
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("KILLED when a patch only inserts lines and its context is in place", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, insertion);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("KILLED when only the context between a hunk's two changed regions was edited", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, twoRegions);
    commit(subject.root, "return the number", {
      "src/limit.ts": guarded.replace("return value;", "return Number(value);"),
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("STALE anchor absent when a patch only inserts lines and its file moved", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, insertion);
    renamed(subject.root);

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output:
        'anchor absent: the context of hunk 1, starting "export function limit(value: number): number {", is not in src/limit.ts.',
    });
  }, 60_000);

  test.each([
    [
      "creates",
      `diff --git a/src/extra.ts b/src/extra.ts
new file mode 100644
--- /dev/null
+++ b/src/extra.ts
@@ -0,0 +1 @@
+export const extra = 1;
`,
    ],
    [
      "deletes",
      `diff --git a/src/limit.ts b/src/limit.ts
deleted file mode 100644
--- a/src/limit.ts
+++ /dev/null
@@ -1,4 +0,0 @@
${guarded
  .trimEnd()
  .split("\n")
  .map((line) => `-${line}`)
  .join("\n")}
`,
    ],
  ])(
    "STALE when the patch %s a whole file",
    async (_verb, patch) => {
      const subject = planted();
      write(subject.root, subject.fault.patch, patch);

      const run = await replayed(subject);

      expect(run.result).toEqual({
        kind: "STALE",
        output: `${subject.fault.patch} creates or deletes a whole file, which replay does not place. It plants a fault only inside a file that exists before and after the patch.`,
      });
    },
    60_000,
  );

  test("STALE when the patch holds no hunk", async () => {
    const subject = planted();
    write(subject.root, subject.fault.patch, "");

    const run = await replayed(subject);

    expect(run.result).toEqual({
      kind: "STALE",
      output: `${subject.fault.patch} holds no hunk to apply.`,
    });
  }, 60_000);

  test("refuses a fault whose patch file is missing, naming the file, before it adds a worktree", async () => {
    const subject = planted();
    const patch = "tests/planted-faults/patches/gone.patch";

    const run = isolated(() =>
      replay(
        subject.root,
        { ...subject.fault, patch },
        headOf(subject.root),
        limit,
      ),
    );

    expect(await rejection(run)).toBe(
      `${patch} does not exist, so ${subject.id} has no planted fault to apply. Repair: plant the fault again by hand, run git diff -- <each file you edited> > '${patch}', then undo the planted edit. Done when bun run fault-replay ${subject.id} passes.`,
    );
    expect(worktrees(subject.root)).toEqual([subject.root]);
  }, 60_000);

  test("BROKEN when the named test already fails without the fault", async () => {
    const subject = planted({
      tests: `${limitTests}${redTest}`,
      title: "^L\\.red ",
    });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("BROKEN");
    expect(outputOf(run.result)).toContain("(fail) L.red is red without");
    expect(worktrees(subject.root)).toEqual([subject.root]);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("BROKEN when the test file fails to load before the fault", async () => {
    const subject = planted({ tests: "throw new Error('does not load');\n" });

    const run = await replayed(subject);

    expect(run.result.kind).toBe("BROKEN");
    expect(outputOf(run.result)).toContain("does not load");
  }, 60_000);

  test("runs only the test file the record names", async () => {
    const subject = planted({
      elsewhere: `import { test } from "bun:test";

test("L.refuses elsewhere", () => {
  throw new Error("a test in another file");
});
`,
    });

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
  }, 60_000);

  test("refuses to give a verdict when the test run dies by a signal", async () => {
    const subject = planted({
      tests: `import { test } from "bun:test";

test("L.refuses dies", () => {
  process.kill(process.pid, "SIGKILL");
});
`,
    });

    const run = isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), limit),
    );

    expect(await rejection(run)).toBe(
      `${process.execPath} scripts/test-run.ts ./tests/limit.test.ts -t ^L\\.refuses  was killed by SIGKILL while replaying ${subject.id}, so it has no verdict.`,
    );
  }, 60_000);

  test("TIMEOUT names a step of the replay as the one that outran the limit, and cleans up", async () => {
    const subject = planted();

    const run = await isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), 1),
    );

    expect(run.result.kind).toBe("TIMEOUT");
    const step = String(Reflect.get(run.result, "step"));
    const bun = process.execPath;
    expect(
      [
        "git worktree add --detach --quiet ",
        "git ls-files ",
        `${bun} install --frozen-lockfile`,
        `${bun} test ./tests/`,
      ].some((start) => step.startsWith(start)),
    ).toBe(true);
    expect(run.leftovers).toEqual([]);
  }, 60_000);

  test("refuses a commit git cannot check out, naming git's words", async () => {
    const subject = planted();

    const run = isolated(() =>
      replay(subject.root, subject.fault, "0".repeat(40), limit),
    );

    expect(await rejection(run)).toContain("invalid reference");
  }, 60_000);

  test("refuses when the install fails, naming the fault and the output", async () => {
    const subject = planted({ manifest: "{ not json" });

    const run = isolated(() =>
      replay(subject.root, subject.fault, headOf(subject.root), limit),
    );

    expect(await rejection(run)).toStartWith(
      `bun install --frozen-lockfile failed while replaying ${subject.id}:\n`,
    );
  }, 60_000);

  test("replays the commit it is given, not the working tree", async () => {
    const subject = planted();
    write(subject.root, "src/limit.ts", unguarded);

    const run = await replayed(subject);

    expect(run.result).toEqual({ kind: "KILLED", failing: killedBy });
    expect(readFileSync(join(subject.root, "src/limit.ts"), "utf8")).toBe(
      unguarded,
    );
  }, 60_000);
});
