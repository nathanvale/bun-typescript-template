import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { invoke } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { timed, whileTemplateGitHangs } from "../../support/hung-git.ts";
import { processWatchdog } from "../../support/process.ts";

const folder = ownedFolders();
const bound = 4_000;

describe("Bootstrap reading the template's commit for Template provenance", () => {
  test(
    "refuses within its bound when git does not answer, naming the git command and its repair, and publishes nothing",
    async () => {
      const destination = join(folder("template-revision-"), "demo-app");
      const { value, milliseconds } = await whileTemplateGitHangs(
        folder("template-revision-git-"),
        () =>
          timed(() =>
            invoke(
              "--destination",
              destination,
              "--source-packet",
              "/abs/packets/demo",
              "--json",
            ),
          ),
      );
      expect({
        exitCode: value.exitCode,
        stdout: value.stdout,
        stderr: JSON.parse(value.stderr) as unknown,
        published: existsSync(destination),
      }).toEqual({
        exitCode: 1,
        stdout: "",
        stderr: {
          schemaVersion: 1,
          status: "refused",
          error: {
            code: "template_revision_unavailable",
            message: `git rev-parse HEAD did not finish within ${bound} ms while reading the template's commit`,
            repair:
              "run that git command by hand in the template to see where it waits, then rerun the same command",
            retrySafe: false,
          },
        },
        published: false,
      });
      expect(milliseconds).toBeGreaterThanOrEqual(bound);
      expect(milliseconds).toBeLessThan(bound + 3_000);
    },
    processWatchdog(1),
  );
});
