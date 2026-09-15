import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseSetArguments, validateSetInput } from "../../src/engine.ts";

const ROOT = resolve(import.meta.dir, "../..");

test.each([
  ["enabled", true],
  ["", false],
  ["x".repeat(129), false],
])("set input requires a bounded nonempty value %#", (value, success) => {
  expect(validateSetInput(value, false).success).toBe(success);
});

test.each([
  [["--value", "enabled"], { preview: false, value: "enabled" }],
  [["--value", "enabled", "--preview"], { preview: true, value: "enabled" }],
  [["--preview", "--value", "enabled"], { preview: true, value: "enabled" }],
] as const)("set arguments accept the exact supported shape %#", (args, data) => {
  expect(parseSetArguments([...args])).toEqual({ data, success: true });
});

test.each([
  [[]],
  [["--value"]],
  [["--value", "--preview"]],
  [["--value", "enabled", "--value", "disabled"]],
  [["--preview", "--preview", "--value", "enabled"]],
  [["--value", "enabled", "--unknown"]],
  [["--value", "enabled", "--preveiw"]],
  [["--value", "enabled", "extra"]],
  [["enabled", "--value", "disabled"]],
] as const)("set arguments reject unsupported shape %#", (args) => {
  expect(parseSetArguments(args).success).toBe(false);
});

test("a rejected public set invocation does not create the state path", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-invalid-set-"));
  const state = join(root, "state.json");
  try {
    const result = Bun.spawnSync(
      [
        process.execPath,
        "run",
        "src/cli.ts",
        "set",
        "--value",
        "enabled",
        "--preveiw",
        "--json",
      ],
      {
        cwd: ROOT,
        env: { ...process.env, CLI_EXAMPLE_STATE: state },
        stderr: "pipe",
        stdout: "pipe",
      },
    );

    expect(result.exitCode).toBe(4);
    expect(result.stderr.toString()).toBe("");
    expect(JSON.parse(result.stdout.toString()).result).toMatchObject({
      causeCode: "SCHEMA_INVALID_INPUT",
      outcome: "refused",
      transactionState: "unchanged",
    });
    expect(await Bun.file(state).exists()).toBe(false);
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
