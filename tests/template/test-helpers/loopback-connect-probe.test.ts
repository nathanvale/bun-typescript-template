import { describe, expect, test } from "bun:test";
import { shouldSkipLoopback } from "../../support/loopback-connect-probe.ts";

const skipLoopback = await shouldSkipLoopback();

test("skips and prints reason once when loopback connect is refused without CI, fails loudly under CI=true, and runs when allowed", async () => {
  const notices: string[] = [];
  const report = (line: string) => {
    notices.push(line);
  };

  const skipped = await shouldSkipLoopback({
    probe: () => Promise.resolve(false),
    env: {},
    report,
  });
  expect(skipped).toBe(true);
  expect(notices).toEqual([
    "needs-loopback: skipped, loopback connect refused by sandbox",
  ]);

  let ciError: unknown;
  try {
    await shouldSkipLoopback({
      probe: () => Promise.resolve(false),
      env: { CI: "true" },
      report,
    });
  } catch (error) {
    ciError = error;
  }
  expect(ciError).toBeInstanceOf(Error);
  expect(ciError instanceof Error ? ciError.message : "").toMatch(
    /loopback-connect-probe.*loopback connect refused by sandbox/,
  );
  expect(notices).toHaveLength(1);

  const skippedWhenAllowed = await shouldSkipLoopback({
    probe: () => Promise.resolve(true),
    env: { CI: "true" },
    report,
  });
  expect(skippedWhenAllowed).toBe(false);
  expect(notices).toHaveLength(1);
});

describe.skipIf(skipLoopback)("needs-loopback real probe", () => {
  test("the real probe allows loopback on a host without a loopback sandbox", async () => {
    const notices: string[] = [];
    const skipped = await shouldSkipLoopback({
      env: { CI: "true" },
      report: (line) => {
        notices.push(line);
      },
    });
    expect(skipped).toBe(false);
    expect(notices).toEqual([]);
  });
});
