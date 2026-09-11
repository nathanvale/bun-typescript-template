import { expect, test } from "bun:test"
import { greet } from "./index"

test("greet returns a friendly message", () => {
  expect(greet("world")).toBe("Hello, world!")
})
