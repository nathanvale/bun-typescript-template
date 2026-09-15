import { expect, test } from "bun:test";
import { validateSetInput } from "../../src/engine.ts";

test("set input requires a bounded nonempty value", () => {
  expect(validateSetInput("enabled", false).success).toBe(true);
  expect(validateSetInput("", false).success).toBe(false);
  expect(validateSetInput("x".repeat(129), false).success).toBe(false);
});
