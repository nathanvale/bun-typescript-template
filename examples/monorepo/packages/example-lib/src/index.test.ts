import { expect, test } from "bun:test";
import { add } from "./index.ts";

test("add sums two numbers", () => {
	expect(add(2, 3)).toBe(5);
});
