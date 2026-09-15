import { expect, test } from "bun:test";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

function invoke(...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", ...args],
    {
      cwd: ROOT,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

test("machine status emits one 2.0 envelope and no stderr", () => {
  const result = invoke("status", "--json");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    result: {
      commandIdentity: "example.status",
      effectClass: "inspect",
      outcome: "success",
      transactionState: "unchanged",
    },
  });
});

test("human help names the supported invocation", () => {
  const result = invoke("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("Usage: example status [--json]\n");
});

test("selected-command discovery describes only status", () => {
  const result = invoke("--discover-command", "example.status", "--json");
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result.data.command.commandIdentity).toBe("example.status");
  expect(envelope.result.data.stations).toHaveLength(1);
});

test("missing command is a focused usage refusal", () => {
  const result = invoke("--json");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout)).toMatchObject({
    result: {
      causeCode: "USAGE_INVALID_INVOCATION",
      outcome: "refused",
      transactionState: "unchanged",
    },
  });
});
