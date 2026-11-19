import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapWithKernel } from "../../../src/bootstrap.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  firstLayout,
  kernelEntries,
} from "../../support/kernel-repository-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import {
  notUtf8,
  stampingFixture,
  tokenText,
} from "../../support/stamping-fixture.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const run = stampingFixture();
const folder = ownedFolders();
const compileBound = 60_000;

describe("stamping runs after token substitution", () => {
  test("a stamped file holding a token and a stamped file that is not valid UTF-8 keep their bytes", async () => {
    const { core } = firstLayout;
    const stamping = run({
      entries: [
        ...kernelEntries(),
        { path: `engine/${core}/token.txt`, bytes: tokenText },
        { path: `engine/${core}/bytes.bin`, bytes: notUtf8 },
      ],
    });
    await bootstrapWithKernel(stamping.request);
    const { destination } = stamping;
    expect(readFileSync(join(destination, core, "token.txt"), "utf8")).toBe(
      tokenText,
    );
    expect(
      new Uint8Array(readFileSync(join(destination, core, "bytes.bin"))),
    ).toEqual(notUtf8);
    expect(
      readFileSync(join(destination, "package.json"), "utf8"),
    ).not.toContain("__REPOSITORY_NAME__");
  });

  test(
    "stamping a staging folder that token substitution has not rendered does not compile",
    async () => {
      const probe = folder("stamping-compile-");
      writeFileSync(
        join(probe, "tsconfig.json"),
        JSON.stringify({
          extends: join(ROOT, "tsconfig.base.json"),
          compilerOptions: { typeRoots: [join(ROOT, "node_modules/@types")] },
          files: ["unrendered.ts", "rendered.ts"],
        }),
      );
      const from = (file: string) => JSON.stringify(join(ROOT, "src", file));
      const call = (staging: string) =>
        [
          `import type { Kernel } from ${from("kernel-reader.ts")};`,
          `import { type AddonSelection, type StampOrigin, stampKernel } from ${from("stamping.ts")};`,
          `import type { RenderedStaging } from ${from("token-substitution.ts")};`,
          "declare const kernel: Kernel;",
          "declare const selection: AddonSelection;",
          "declare const origin: StampOrigin;",
          staging,
          "export const written = stampKernel(staging, kernel, selection, origin);",
          "export type Used = RenderedStaging;",
          "",
        ].join("\n");
      writeFileSync(
        join(probe, "unrendered.ts"),
        call('const staging: string = "/staging";'),
      );
      writeFileSync(
        join(probe, "rendered.ts"),
        call("declare const staging: RenderedStaging;"),
      );
      const compiled = await spawnBounded(
        [join(ROOT, "node_modules/.bin/tsc"), "--noEmit", "-p", probe],
        { cwd: probe, processGroup: true, boundMilliseconds: compileBound },
      );
      const errors = compiled.stdout
        .split("\n")
        .filter((line) => line.includes("error TS"))
        .map((line) => line.replace(/\(\d+,\d+\)/, ""));
      expect({ exit: compiled.exit, errors }).toEqual({
        exit: 2,
        errors: [
          "unrendered.ts: error TS2345: Argument of type 'string' is not assignable to parameter of type 'RenderedStaging'.",
        ],
      });
      expect(existsSync(join(probe, "unrendered.js"))).toBe(false);
    },
    compileBound + 10_000,
  );
});
