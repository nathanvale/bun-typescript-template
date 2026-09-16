import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
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

async function outputFailurePreload(): Promise<string> {
  const root = await mkdtemp("/tmp/simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "output-failure.ts");
  await writeFile(
    preload,
    `const write = process.stdout.write.bind(process.stdout);
let failed = false;
process.stdout.write = (chunk, ...args) => {
  if (!failed) {
    failed = true;
    throw new Error("fixture stdout failure");
  }
  return write(chunk, ...args);
};
`,
  );
  return preload;
}

type ClosedStdoutPreload = {
  preload: string;
  ready: string;
  release: string;
};

async function closedStdoutPreload(): Promise<ClosedStdoutPreload> {
  const root = await mkdtemp("/tmp/simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "closed-stdout.ts");
  const ready = join(root, "ready");
  const release = join(root, "release");
  await writeFile(
    preload,
    `import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";

const readyPath = ${JSON.stringify(ready)};
const releasePath = ${JSON.stringify(release)};
await writeFile(readyPath, "ready");
while (!existsSync(releasePath)) await Bun.sleep(1);
`,
  );
  return { preload, ready, release };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 5_000; attempt += 1) {
    if (existsSync(path)) return;
    await Bun.sleep(1);
  }
  throw new Error(`Timed out waiting for ${path}`);
}

async function invokeWithClosedStdoutReader(
  fixture: ClosedStdoutPreload,
  ...args: string[]
) {
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "--preload",
      fixture.preload,
      "src/cli.ts",
      ...args,
    ],
    {
      cwd: ROOT,
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const stderr = new Response(child.stderr).text();
  const stdoutReader = child.stdout.getReader();
  const stdoutRead = stdoutReader.read();
  try {
    await waitForFile(fixture.ready);
    await stdoutReader.cancel();
    const stdoutResult = await stdoutRead;
    await writeFile(fixture.release, "release");
    const [stderrText, exitCode] = await Promise.all([stderr, child.exited]);
    return {
      exitCode,
      stderr: stderrText,
      stdout: stdoutResult.done
        ? ""
        : new TextDecoder().decode(stdoutResult.value),
    };
  } finally {
    if (!existsSync(fixture.release)) {
      await writeFile(fixture.release, "release");
    }
    await stdoutReader.cancel();
    await child.exited;
  }
}

afterEach(async () => {
  const roots = scratchRoots.splice(0);
  await Promise.all(
    roots.map((root) => rm(root, { force: true, recursive: true })),
  );
  for (const root of roots) expect(existsSync(root)).toBe(false);
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

test("machine status emits a distinct internal fallback after stdout emission fails", async () => {
  const result = invokeWithPreload(
    await outputFailurePreload(),
    "status",
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(result.stdout.trim().split("\n")).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toMatchObject({
    message: "The status output could not be emitted.",
    result: {
      causeCode: "INTERNAL_RESULT_EMISSION",
      nextAction: "Inspect the status output and retry example status.",
      outcome: "failed",
      repairAction: "Inspect the status output stream before retrying.",
    },
  });
});

test("machine status reports repair guidance after a real stdout reader closes", async () => {
  const result = await invokeWithClosedStdoutReader(
    await closedStdoutPreload(),
    "status",
    "--json",
  );

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "The status output could not be emitted.\n" +
      "Repair: Inspect the status output stream before retrying.\n",
  );
  expect(result.stderr).not.toContain("EPIPE");
  expect(result.stderr).not.toContain("Bun v");
});

test("human status reports a repair action after stdout emission fails", async () => {
  const result = invokeWithPreload(await outputFailurePreload(), "status");

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "The status output could not be emitted.\n" +
      "Repair: Inspect the status output stream before retrying.\n",
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
    "INTERNAL_RESULT_EMISSION|failed",
    "INTERNAL_RESULT_SERIALIZATION|failed",
    "SUCCESS_UNCHANGED|success",
  ]);
  expect(
    envelope.result.data.stations.find(
      (station: { causeCode: string }) =>
        station.causeCode === "INTERNAL_RESULT_EMISSION",
    ),
  ).toMatchObject({
    guidance: {
      nextAction: "Inspect the status output and retry example status.",
    },
    repairAction: "Inspect the status output stream before retrying.",
    trigger: "The status output cannot be emitted.",
  });
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
