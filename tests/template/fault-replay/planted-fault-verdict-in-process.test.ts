import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { replay } from "../../../scripts/planted-faults.ts";
import { write } from "../../support/fixture-files.ts";
import {
  createPlantedFaultFixture,
  headOf,
  type Planted,
} from "../../support/planted-fault-in-process-fixture.ts";

const { isolated, planted } = createPlantedFaultFixture();

const boundedRunner = join(import.meta.dir, "../../support/process.ts");

const testFile = (
  body: string,
  imports = "",
) => `import { expect, test } from "bun:test";
import { limit } from "../src/limit.ts";
${imports}
const refused = (() => {
  try {
    limit(Number.NaN);
    return false;
  } catch {
    return true;
  }
})();

${body}`;

const hangs = "await new Promise(() => {});";

const untested = "no test that passed without it failed";

function withPatch(cause: string): string {
  return `fails with the patch applied, ${cause}, so the planted fault shows nothing.`;
}

async function replayed(subject: Planted, removesBound?: true) {
  const fault =
    removesBound === undefined
      ? subject.fault
      : { ...subject.fault, removesBound };
  const run = await isolated(() =>
    replay(subject.root, fault, headOf(subject.root), 120_000),
  );
  expect(run.leftovers).toEqual([]);
  return run.result;
}

describe("replay credits a kill only to a test that passed without the patch and failed by its own check with it", () => {
  test("BROKEN when, with the patch applied, the named test outruns Bun's test timer", async () => {
    const subject = planted({
      tests: testFile(`test("L.refuses NaN", async () => {
  if (!refused) ${hangs}
}, 100);
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch("but only by timing out (L.refuses NaN)"),
    });
  }, 60_000);

  test("BROKEN when, with the patch applied, a child the named test starts outruns its bound", async () => {
    const subject = planted({
      tests: testFile(
        `test("L.refuses NaN", async () => {
  if (!refused) await spawnBounded(["sleep", "5"], { boundMilliseconds: 100 });
}, 30_000);
`,
        `import { spawnBounded } from ${JSON.stringify(boundedRunner)};\n`,
      ),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch("but only by timing out (L.refuses NaN)"),
    });
  }, 60_000);

  test("BROKEN when, with the patch applied, the test file fails to import its module", async () => {
    const subject = planted();
    write(
      subject.root,
      subject.fault.patch,
      `diff --git a/src/limit.ts b/src/limit.ts
--- a/src/limit.ts
+++ b/src/limit.ts
@@ -1,3 +1,3 @@
-export function limit(value: number): number {
+export function bound(value: number): number {
   if (Number.isNaN(value)) throw new TypeError("limit must be a number");
   return value;
`,
    );

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch("but its test file did not load"),
    });
  }, 60_000);

  test("BROKEN when, with the patch applied, the title selects no test", async () => {
    const subject = planted({
      tests: testFile(`if (refused) test("L.refuses NaN", () => {});
test("L.weak keeps a number", () => {
  expect(limit(1)).toBe(1);
});
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch(`but ${untested}`),
    });
  }, 60_000);

  test("BROKEN when, with the patch applied, only a test the clean run did not run fails", async () => {
    const subject = planted({
      tests:
        testFile(`test(refused ? "L.refuses NaN" : "L.refuses another", () => {
  expect(refused).toBe(true);
});
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch(`but ${untested}`),
    });
  }, 60_000);

  test("BROKEN when the named test outruns Bun's test timer without the patch", async () => {
    const subject = planted({
      tests: testFile(`test("L.refuses NaN", async () => {
  if (refused) ${hangs}
}, 100);
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: "fails without the patch, so the planted fault shows nothing.",
    });
  }, 60_000);

  test("BROKEN when the title selects only tests marked todo without the patch", async () => {
    const subject = planted({
      tests: testFile(`test.todo("L.refuses NaN");
test.todo("L.refuses NaN later");
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause:
        "passes without the patch but runs no test, so the planted fault shows nothing.",
    });
  }, 60_000);

  test("KILLED names only the selected test that failed by its own check when another timed out", async () => {
    const subject = planted({
      tests: testFile(`test("L.refuses NaN", () => {
  expect(refused).toBe(true);
});
test("L.refuses NaN in time", async () => {
  if (!refused) ${hangs}
}, 100);
`),
    });

    expect(await replayed(subject)).toEqual({
      kind: "KILLED",
      failing: ["L.refuses NaN"],
    });
  }, 60_000);
});

describe("replay credits a kill only to a failed assertion in a test it names once", () => {
  test("BROKEN when a beforeEach hook throws once the patch is applied", async () => {
    const subject = planted({
      tests: testFile(
        `beforeEach(() => {
  if (!refused) throw new Error("setup crashed");
});
test("L.refuses NaN", () => {
  expect(limit(1)).toBe(1);
});
`,
        `import { beforeEach } from "bun:test";\n`,
      ),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch("but by no failed assertion (L.refuses NaN: Error)"),
    });
  }, 60_000);

  test("BROKEN when the test body crashes after a passing assertion once the patch is applied", async () => {
    const subject = planted({
      tests: testFile(`test("L.refuses NaN", () => {
  expect(limit(1)).toBe(1);
  if (!refused) throw new TypeError("crashed");
});
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch("but by no failed assertion (L.refuses NaN: TypeError)"),
    });
  }, 60_000);

  test("BROKEN when the title selects a test name the report holds twice", async () => {
    const subject = planted({
      tests: testFile(`test("L.refuses NaN", () => {
  expect(limit(1)).toBe(1);
});
(refused ? test.skip : test)("L.refuses NaN", () => {
  expect(refused).toBe(true);
});
`),
    });

    expect(await replayed(subject)).toMatchObject({
      kind: "BROKEN",
      cause:
        "passes without the patch but has more than one test named L.refuses NaN, so the planted fault shows nothing.",
    });
  }, 60_000);
});

describe("replay credits a timeout as a kill only for a record whose fault removes a bound", () => {
  const timesOut = testFile(`test("L.refuses NaN", async () => {
  if (!refused) ${hangs}
}, 100);
`);

  test("KILLED when the record has removesBound and the named test outruns Bun's test timer with the patch applied", async () => {
    const subject = planted({ tests: timesOut });

    expect(await replayed(subject, true)).toEqual({
      kind: "KILLED",
      failing: ["L.refuses NaN"],
    });
  }, 60_000);

  test("KILLED when the record has removesBound and a child the named test starts outruns its bound", async () => {
    const subject = planted({
      tests: testFile(
        `test("L.refuses NaN", async () => {
  if (!refused) await spawnBounded(["sleep", "5"], { boundMilliseconds: 100 });
}, 30_000);
`,
        `import { spawnBounded } from ${JSON.stringify(boundedRunner)};\n`,
      ),
    });

    expect(await replayed(subject, true)).toEqual({
      kind: "KILLED",
      failing: ["L.refuses NaN"],
    });
  }, 60_000);

  test("BROKEN when the record has removesBound but the test file fails to load with the patch applied", async () => {
    const subject = planted({
      tests:
        testFile(`if (!refused) throw new Error("does not load with the patch");
test("L.refuses NaN", () => {});
`),
    });

    expect(await replayed(subject, true)).toMatchObject({
      kind: "BROKEN",
      cause: withPatch("but its test file did not load"),
    });
  }, 60_000);

  test("SURVIVED when the record has removesBound and the named test still passes with the patch applied", async () => {
    const subject = planted({ title: "^L\\.weak " });

    expect(await replayed(subject, true)).toEqual({ kind: "SURVIVED" });
  }, 60_000);
});
