import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { KERNEL_RECIPE, RECIPES } from "../../../src/recipe.ts";
import {
  type Invocation,
  invoke,
  ROOT,
  runCommand,
} from "../../support/bootstrap-cli-fixture.ts";
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

type Envelope = {
  readonly exitCode: number;
  readonly stderr: unknown;
};

function envelopeOf(refusal: Invocation): Envelope {
  return {
    exitCode: refusal.exitCode,
    stderr: JSON.parse(refusal.stderr) as unknown,
  };
}

function refusedWith(
  exitCode: number,
  code: string,
  message: string,
  repair: string,
  retrySafe: boolean,
): Envelope {
  return {
    exitCode,
    stderr: {
      schemaVersion: 1,
      status: "refused",
      error: { code, message, repair, retrySafe },
    },
  };
}

describe("the kernel row on the command line", () => {
  test("RECIPES, the rows the toolchain and lint tests make with the template's own packages, does not hold the kernel row", () => {
    expect(RECIPES.includes(KERNEL_RECIPE)).toBe(false);
    expect(RECIPES.map(({ cli }) => cli).includes("kernel")).toBe(false);
  });

  test.each(["--addon", "--lockfile"])(
    "Bootstrap refuses %s as an unknown argument",
    async (option) => {
      const refusal = await invoke(
        "--profile",
        "durable",
        "--kernel",
        option,
        "state",
        "--destination",
        "/abs/never/made",
        "--source-packet",
        "/abs/packets/demo",
        "--json",
      );
      expect(envelopeOf(refusal)).toEqual(
        refusedWith(
          2,
          "unknown_argument",
          `unknown argument: ${option}`,
          "run bun run bootstrap --help",
          true,
        ),
      );
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

  test(
    "--kernel with a CLI starter is refused as a profile option mismatch, before any folder is made",
    async () => {
      const row = run();
      const refusal = await invoke(
        "--profile",
        "durable",
        "--kernel",
        "--starter",
        "simple",
        "--destination",
        row.destination,
        "--source-packet",
        "/abs/packets/demo",
        "--json",
      );
      expect(envelopeOf(refusal)).toEqual(
        refusedWith(
          2,
          "profile_option_mismatch",
          "--kernel and --starter cannot be combined",
          "choose --kernel or one CLI starter",
          true,
        ),
      );
      expect(leftBehind(row)).toBe("no folder");
    },
    processWatchdog(1),
  );

  test(
    "--kernel reports a missing kernel repository at KERNEL_REPOSITORY in its envelope, with the kernel reader's code and repair, before any folder is made",
    async () => {
      const row = run();
      const missing = join(row.parent, "no-kernel-here");
      const refusal = await runCommand(
        ROOT,
        [
          process.execPath,
          "run",
          "src/bootstrap.ts",
          "--profile",
          "durable",
          "--kernel",
          "--destination",
          row.destination,
          "--source-packet",
          "/abs/packets/demo",
          "--json",
        ],
        { ...process.env, KERNEL_REPOSITORY: missing },
      );
      expect(envelopeOf(refusal)).toEqual(
        refusedWith(
          1,
          "kernel_repository_missing",
          `No git repository is at ${missing}: that path does not exist.`,
          repairs.repository,
          false,
        ),
      );
      expect(leftBehind(row)).toBe("no folder");
    },
    processWatchdog(1),
  );
});
