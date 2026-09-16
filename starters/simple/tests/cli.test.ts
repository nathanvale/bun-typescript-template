import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const scratchRoots: string[] = [];

function invokeProcess(command: string[]) {
  const result = Bun.spawnSync(command, {
    cwd: ROOT,
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function invoke(...args: string[]) {
  return invokeProcess([process.execPath, "run", "src/cli.ts", ...args]);
}

function invokeWithPreload(preload: string, ...args: string[]) {
  return invokeProcess([
    process.execPath,
    "run",
    "--preload",
    preload,
    "src/cli.ts",
    ...args,
  ]);
}

async function serializerFailurePreload(): Promise<string> {
  const root = await mkdtemp("/tmp/simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "serializer-failure.ts");
  await writeFile(
    preload,
    `const stringify = JSON.stringify;
JSON.stringify = (...args) => {
  const [value] = args;
  if (
    typeof value === "object" &&
    value !== null &&
    "result" in value &&
    typeof value.result === "object" &&
    value.result !== null &&
    "outcome" in value.result &&
    value.result.outcome === "success"
  ) {
    JSON.stringify = stringify;
    throw new Error("fixture serializer failure");
  }
  return stringify(...args);
};
`,
  );
  return preload;
}

afterEach(async () => {
  await Promise.all(
    scratchRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

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

test("machine status emits a strict internal fallback after serialization fails", async () => {
  const result = invokeWithPreload(
    await serializerFailurePreload(),
    "status",
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  const envelope = JSON.parse(result.stdout);
  expect(Object.keys(envelope).sort()).toEqual([
    "availablePaths",
    "contractVersion",
    "envelopeVersion",
    "message",
    "result",
  ]);
  expect(envelope).toMatchObject({
    availablePaths: [
      "example.command-discovery",
      "example.discovery",
      "example.help",
      "example.status",
    ],
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    message: "The machine result could not be serialized.",
    result: {
      causeCode: "INTERNAL_RESULT_SERIALIZATION",
      commandIdentity: "example.status",
      data: null,
      effectClass: "inspect",
      effects: {
        completed: [],
        inventoryComplete: true,
        remaining: [],
        uncertain: [],
      },
      exitCode: 1,
      failureClass: "internal",
      nextAction: "Inspect the runtime and retry example status.",
      outcome: "failed",
      repairAction: "Inspect the serialization failure before retrying.",
      retryable: false,
      transactionState: "unchanged",
    },
  });
  expect(Object.keys(envelope.result).sort()).toEqual([
    "causeCode",
    "commandIdentity",
    "data",
    "effectClass",
    "effects",
    "exitCode",
    "failureClass",
    "nextAction",
    "outcome",
    "repairAction",
    "retryable",
    "runId",
    "transactionState",
  ]);
  expect(envelope.result.runId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
  );
});

test("human help names the supported invocation", () => {
  const result = invoke("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe("Usage: example status [--json]\n");
});

test("selected-command discovery describes the status stations", () => {
  const result = invoke("--discover-command", "example.status", "--json");
  expect(result.exitCode).toBe(0);
  const envelope = JSON.parse(result.stdout);
  expect(envelope.result.data.command.commandIdentity).toBe("example.status");
  expect(
    envelope.result.data.stations
      .map((station: { causeCode: string; outcome: string }) =>
        [station.causeCode, station.outcome].join("|"),
      )
      .sort(),
  ).toEqual([
    "INTERNAL_RESULT_SERIALIZATION|failed",
    "SUCCESS_UNCHANGED|success",
  ]);
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
