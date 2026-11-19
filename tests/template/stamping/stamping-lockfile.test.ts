import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapWithKernel } from "../../../src/bootstrap.ts";
import {
  notUtf8,
  stampingFixture,
  tokenText,
} from "../../support/stamping-fixture.ts";

const run = stampingFixture();

describe("the lockfile Bootstrap takes as an input", () => {
  test("a supplied lockfile arrives in the generated repository byte for byte", async () => {
    const bytes = new Uint8Array([
      ...new TextEncoder().encode(tokenText),
      ...notUtf8,
    ]);
    const { destination, request } = run({
      lockfile: { source: "supplied", bytes },
    });
    await bootstrapWithKernel(request);
    expect(new Uint8Array(readFileSync(join(destination, "bun.lock")))).toEqual(
      bytes,
    );
  });

  test("a run with no lockfile places none", async () => {
    const { destination, request } = run({ lockfile: { source: "none" } });
    await bootstrapWithKernel(request);
    expect(existsSync(join(destination, "package.json"))).toBe(true);
    expect(existsSync(join(destination, "bun.lock"))).toBe(false);
  });
});
