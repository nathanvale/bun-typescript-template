import { describe, expect, test } from "bun:test";
import { join } from "node:path";
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

describe("Bootstrap on the command line", () => {
  test.each([
    { option: "--addon", value: ["state"] },
    { option: "--lockfile", value: ["state"] },
    { option: "--profile", value: ["durable"] },
    { option: "--starter", value: ["simple"] },
    { option: "--monorepo", value: [] },
    { option: "--kernel", value: [] },
  ])(
    "Bootstrap refuses $option as an unknown argument",
    async ({ option, value }) => {
      const refusal = await invoke(
        option,
        ...value,
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
    "Bootstrap reports a missing kernel repository at KERNEL_REPOSITORY in its envelope, with the kernel reader's code and repair, before any folder is made",
    async () => {
      const row = run();
      const missing = join(row.parent, "no-kernel-here");
      const refusal = await runCommand(
        ROOT,
        [
          process.execPath,
          "run",
          "src/bootstrap.ts",
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
