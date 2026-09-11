import { expect, test } from "bun:test";
import { greet } from "./index.ts";

test("greet returns a greeting for the given name", () => {
	expect(greet("World")).toBe("Hello, World!");
});
