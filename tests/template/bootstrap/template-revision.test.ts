import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../../src/bootstrap.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { timed, whileGitHangs } from "../../support/hung-git.ts";
import { processWatchdog } from "../../support/process.ts";

const folder = ownedFolders();
const bound = 4_000;

describe("Bootstrap reading the template's commit for Template provenance", () => {
  test(
    "refuses within its bound when git does not answer, and publishes nothing",
    async () => {
      const destination = join(folder("template-revision-"), "demo-app");
      const { value, milliseconds } = await whileGitHangs(
        folder("template-revision-git-"),
        () =>
          timed(() =>
            main([
              "--profile",
              "durable",
              "--destination",
              destination,
              "--source-packet",
              "/abs/packets/demo",
              "--json",
            ]),
          ),
      );
      expect({
        exitCode: value,
        withinBound:
          milliseconds >= bound - 100 && milliseconds < bound + 1_500,
        published: existsSync(destination),
      }).toEqual({ exitCode: 1, withinBound: true, published: false });
    },
    processWatchdog(1),
  );
});
