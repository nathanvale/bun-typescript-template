import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KERNEL_RECIPE, RECIPES } from "../../../src/recipe.ts";
import { invoke } from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { refused, repairs } from "../../support/kernel-refusal.ts";
import {
  bootstrapRefusal,
  kernelRowFixture,
  leftBehind,
} from "../../support/kernel-row-fixture.ts";

const run = kernelRowFixture();

describe("refusals before any staging folder exists", () => {
  test("a missing kernel repository leaves nothing behind", async () => {
    const row = run();
    const missing = join(row.parent, "no-kernel-here");
    expect(
      await bootstrapRefusal({
        ...row.request,
        kernel: { ...row.request.kernel, repository: missing },
      }),
    ).toEqual(
      refused(
        "kernel_repository_missing",
        `No git repository is at ${missing}: that path does not exist.`,
        repairs.repository,
      ),
    );
    expect(leftBehind(row)).toBe("no folder");
  });

  test("a missing commit leaves nothing behind", async () => {
    const row = run();
    const commit = "f".repeat(40);
    const { repository } = row.request.kernel;
    expect(
      await bootstrapRefusal({
        ...row.request,
        kernel: { repository, commit },
      }),
    ).toEqual(
      refused(
        "kernel_commit_missing",
        `Commit ${commit} is not in the git repository at ${repository}.`,
        repairs.commit,
      ),
    );
    expect(leftBehind(row)).toBe("no folder");
  });
});

describe("the kernel row stays off the command line", () => {
  test("the recipes the command line selects from do not hold the kernel row", () => {
    expect(RECIPES.includes(KERNEL_RECIPE)).toBe(false);
    expect(RECIPES.map(({ cli }) => cli).includes("kernel")).toBe(false);
  });

  test.each(["--addon", "--kernel", "--lockfile"])(
    "Bootstrap refuses %s as an unknown argument",
    async (option) => {
      const refusal = await invoke(
        "--profile",
        "durable",
        option,
        "state",
        "--destination",
        "/abs/never/made",
        "--source-packet",
        "/abs/packets/demo",
        "--json",
      );
      expect({
        exitCode: refusal.exitCode,
        stderr: JSON.parse(refusal.stderr) as unknown,
      }).toEqual({
        exitCode: 2,
        stderr: {
          schemaVersion: 1,
          status: "refused",
          error: {
            code: "unknown_argument",
            message: `unknown argument: ${option}`,
            repair: "run bun run bootstrap --help",
            retrySafe: true,
          },
        },
      });
    },
    processWatchdog(1),
  );

  test(
    "--starter kernel is refused as an unsupported starter",
    async () => {
      const refusal = await invoke(
        "--profile",
        "durable",
        "--starter",
        "kernel",
        "--destination",
        "/abs/never/made",
        "--source-packet",
        "/abs/packets/demo",
        "--json",
      );
      expect({
        exitCode: refusal.exitCode,
        code: (JSON.parse(refusal.stderr) as { error: { code: string } }).error
          .code,
      }).toEqual({ exitCode: 2, code: "invalid_starter" });
    },
    processWatchdog(1),
  );
});
