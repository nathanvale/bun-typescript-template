import { describe, expect, test } from "bun:test";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { KERNEL_LOCKFILE } from "../../../src/recipe.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  bootstrapRow,
  generatedJson,
  kernelRowFixture,
  leftBehind,
} from "../../support/kernel-row-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { callInCopy, templateCopy } from "../../support/template-copy.ts";

const run = kernelRowFixture();
const folder = ownedFolders();

describe("the kernel row's lockfile", () => {
  test(
    "a kernel lockfile asked of a template that holds none is refused before any staging folder exists",
    async () => {
      const row = run();
      const copy = templateCopy(folder("kernel-row-template-"), [
        KERNEL_LOCKFILE,
      ]);
      expect(
        await callInCopy(copy, "src/bootstrap.ts", "bootstrapWithKernel", {
          ...row.request,
          lockfile: "committed",
        }),
      ).toEqual({
        refused: {
          code: "kernel_lockfile_missing",
          message: `the template has no kernel lockfile at ${KERNEL_LOCKFILE}`,
        },
      });
      expect(leftBehind(row)).toBe("no folder");
    },
    processWatchdog(1),
  );

  test("the template's kernel lockfile reaches the generated repository byte for byte", async () => {
    const { destination, request } = run();
    await bootstrapRow({ ...request, lockfile: "committed" });
    expect(readFileSync(join(destination, "bun.lock"), "utf8")).toBe(
      readFileSync(join(ROOT, KERNEL_LOCKFILE), "utf8"),
    );
  });

  test("supplied bytes reach the generated repository unchanged, after token substitution, even where they hold a token or are not UTF-8 text", async () => {
    const { destination, request } = run();
    const bytes = new Uint8Array(
      Buffer.concat([
        Buffer.from('{ "name": "__REPOSITORY_NAME__" }\n'),
        Buffer.from([0xff, 0xfe, 0x0a]),
      ]),
    );
    await bootstrapRow({ ...request, lockfile: bytes });
    expect(new Uint8Array(readFileSync(join(destination, "bun.lock")))).toEqual(
      bytes,
    );
  });

  test("a Pin from a local clone names the clone's real path as a git address, at the commit in full", async () => {
    const { destination, request } = run();
    await bootstrapRow({ ...request, kernelFrom: "clone" });
    const { dependencies } = generatedJson(destination, "package.json") as {
      dependencies: Record<string, string>;
    };
    expect(dependencies).toEqual({
      "agent-cli-kernel": `git+${pathToFileURL(realpathSync(request.kernel.repository)).href}#${request.kernel.commit}`,
    });
  });
});
