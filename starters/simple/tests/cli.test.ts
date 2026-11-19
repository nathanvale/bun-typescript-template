function parseEnvelope(text: string) {
  const value: unknown = JSON.parse(text);
  return value as {
    result: {
      runId: string;
      commandIdentity: string;
      data: {
        command: { commandIdentity: string };
        stations: { causeCode: string; outcome: string }[];
      };
    };
  };
}

import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { testFolder } from "./support/test-folder.ts";

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
  const root = testFolder("simple-starter-test-");
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
  const root = testFolder("simple-starter-test-");
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
  const root = testFolder("simple-starter-test-");
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

function waitForFile(path: string): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (existsSync(path)) resolve();
      else if (performance.now() - started >= 5_000)
        reject(new Error(`Timed out waiting for ${path}`));
      else return;
      clearInterval(poll);
    }, 1);
  });
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
  const envelope = parseEnvelope(result.stdout);
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
      "example.dispatch",
      "example.help",
      "example.status",
      "example.template.info",
    ],
    contractVersion: "2.0.0",
    envelopeVersion: 2,
    message: "The machine result could not be serialized.",
    result: {
      causeCode: "INTERNAL_RESULT_UNCHANGED",
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
      handoff: {
        owner: "operator",
        reason: "The read-only command could not produce its result.",
        inspect: [
          "Inspect the command implementation and output transport before another run.",
        ],
      },
      outcome: "failed",
      repairAction:
        "Repair the command or output transport before another run.",
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
    "handoff",
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
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      handoff: {
        owner: "operator",
        reason: "The read-only command could not produce its result.",
        inspect: [
          "Inspect the command implementation and output transport before another run.",
        ],
      },
      outcome: "failed",
      repairAction:
        "Repair the command or output transport before another run.",
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
  expect(result.stderr).toBe("");
  expect(result.stderr).not.toContain("EPIPE");
  expect(result.stderr).not.toContain("Bun v");
});

test("human status reports a repair action after stdout emission fails", async () => {
  const result = invokeWithPreload(await outputFailurePreload(), "status");

  expect(result.exitCode).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toBe(
    "The status output could not be emitted. Repair: Repair the command or output transport before another run.\n",
  );
});

test("human help names the supported invocation", () => {
  const result = invoke("--help");
  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stdout).toBe(
    "Usage: example COMMAND [--json]\nstatus\ntemplate info\n",
  );
});

test("selected-command discovery describes the status stations", () => {
  const result = invoke("--discover-command", "example.status", "--json");
  expect(result.exitCode).toBe(0);
  const envelope = parseEnvelope(result.stdout);
  expect(envelope.result.data.command.commandIdentity).toBe("example.status");
  expect(
    envelope.result.data.stations
      .map((station: { causeCode: string; outcome: string }) =>
        [station.causeCode, station.outcome].join("|"),
      )
      .sort(),
  ).toEqual(["INTERNAL_RESULT_UNCHANGED|failed", "SUCCESS_UNCHANGED|success"]);
  expect(
    envelope.result.data.stations.find(
      (station: { causeCode: string }) =>
        station.causeCode === "INTERNAL_RESULT_UNCHANGED",
    ),
  ).toMatchObject({
    guidance: {
      handoff: {
        owner: "operator",
        reason: "The read-only command could not produce its result.",
        inspect: [
          "Inspect the command implementation and output transport before another run.",
        ],
      },
    },
    repairAction: "Repair the command or output transport before another run.",
    trigger: "The selected read-only domain cannot load or complete.",
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

async function operationPreload(
  guidance: Record<string, unknown> | string,
): Promise<string> {
  const root = testFolder("simple-starter-test-");
  scratchRoots.push(root);
  const preload = join(root, "operation.ts");
  await writeFile(
    preload,
    `import { commands } from ${JSON.stringify(join(ROOT, "src/commands.ts"))};
commands[0].execute = async () => ({
  commandIdentity: "example.status", data: null, message: "Inspection failed.",
  causeCode: "INTERNAL_RESULT_UNCHANGED", effectClass: "inspect",
  effects: { completed: [], remaining: [], uncertain: [], inventoryComplete: true },
  exitCode: 1, failureClass: "internal", outcome: "failed", repairAction: "Inspect implementation.",
  retryable: false, transactionState: "unchanged", ...${typeof guidance === "string" ? guidance : JSON.stringify(guidance)}
});
`,
  );
  return preload;
}

test("domain handoff guidance excludes the success nextAction", async () => {
  const handoff = {
    owner: "operator",
    reason: "Implementation needs repair.",
    inspect: ["Inspect implementation."],
  };
  const observed = invokeWithPreload(
    await operationPreload({ handoff }),
    "status",
    "--json",
  );
  expect(observed.exitCode).toBe(1);
  expect(observed.stderr).toBe("");
  expect(observed.stdout.trim().split("\n")).toHaveLength(1);
  const envelope = parseEnvelope(observed.stdout);
  expect(envelope.result).toMatchObject({
    commandIdentity: "example.status",
    outcome: "failed",
    handoff,
  });
  expect(envelope.result).not.toHaveProperty("nextAction");
});

test("domain handoff guidance preserves a valid optional resource", async () => {
  const handoff = {
    owner: "human",
    reason: "Inspect the recorded file.",
    inspect: ["Inspect the recorded file independently."],
    resource: { kind: "file", id: "example" },
  };
  const observed = invokeWithPreload(
    await operationPreload({ handoff }),
    "status",
    "--json",
  );
  expect(observed.exitCode).toBe(1);
  expect(observed.stderr).toBe("");
  expect(parseEnvelope(observed.stdout).result).toMatchObject({ handoff });
  expect(parseEnvelope(observed.stdout).result).not.toHaveProperty(
    "nextAction",
  );
});

const invalidGuidance: [string, Record<string, unknown> | string][] = [
  ["missing", {}],
  [
    "both",
    {
      nextAction: "Inspect implementation.",
      handoff: {
        owner: "operator",
        reason: "Repair needed.",
        inspect: ["Inspect implementation."],
      },
    },
  ],
  [
    "undefined nextAction on success",
    '{ nextAction: undefined, exitCode: 0, outcome: "success", causeCode: "SUCCESS_UNCHANGED", failureClass: null, repairAction: null }',
  ],
  ["null nextAction", { nextAction: null }],
  ["blank nextAction", { nextAction: "  " }],
  ["numeric nextAction", { nextAction: 1 }],
  ["undefined handoff", "{ handoff: undefined }"],
  ["null handoff", { handoff: null }],
  [
    "unknown owner",
    {
      handoff: {
        owner: "agent",
        reason: "Repair needed.",
        inspect: ["Inspect implementation."],
      },
    },
  ],
  [
    "blank reason",
    {
      handoff: {
        owner: "operator",
        reason: " ",
        inspect: ["Inspect implementation."],
      },
    },
  ],
  [
    "empty inspection",
    { handoff: { owner: "operator", reason: "Repair needed.", inspect: [] } },
  ],
  [
    "blank inspection",
    {
      handoff: { owner: "operator", reason: "Repair needed.", inspect: [" "] },
    },
  ],
  [
    "unknown handoff key",
    {
      handoff: {
        owner: "operator",
        reason: "Repair needed.",
        inspect: ["Inspect implementation."],
        extra: true,
      },
    },
  ],
  [
    "undefined resource",
    '{ handoff: { owner: "operator", reason: "Repair needed.", inspect: ["Inspect implementation."], resource: undefined } }',
  ],
  [
    "blank resource id",
    {
      handoff: {
        owner: "operator",
        reason: "Repair needed.",
        inspect: ["Inspect implementation."],
        resource: { kind: "file", id: " " },
      },
    },
  ],
  [
    "unknown resource key",
    {
      handoff: {
        owner: "operator",
        reason: "Repair needed.",
        inspect: ["Inspect implementation."],
        resource: { kind: "file", id: "example", extra: true },
      },
    },
  ],
];

for (const [name, guidance] of invalidGuidance) {
  test(`invalid domain guidance uses bounded fallback: ${name}`, async () => {
    const observed = invokeWithPreload(
      await operationPreload(guidance),
      "status",
      "--json",
    );
    expect(observed.exitCode).toBe(1);
    expect(observed.stderr).toBe("");
    expect(observed.stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(observed.stdout)).toMatchObject({
      message: "The machine result could not be serialized.",
      result: {
        commandIdentity: "example.status",
        outcome: "failed",
        causeCode: "INTERNAL_RESULT_UNCHANGED",
        handoff: { owner: "operator" },
      },
    });
    expect(parseEnvelope(observed.stdout).result).not.toHaveProperty(
      "nextAction",
    );
  });
}

for (const [args, identity, exitCode] of [
  [["--help"], "example.help", 0],
  [["--discover"], "example.discovery", 0],
  [["--discover-command", "example.status"], "example.command-discovery", 0],
  [[], "example.dispatch", 2],
] as const) {
  test(`builtin stdout errors are handled before dispatch: ${identity}`, async () => {
    const normal = invoke(...args, "--json");
    expect(normal.exitCode).toBe(exitCode);
    expect(normal.stderr).toBe("");
    expect(parseEnvelope(normal.stdout).result.commandIdentity).toBe(identity);
    const root = testFolder("simple-starter-test-");
    scratchRoots.push(root);
    const preload = join(root, "async-output.ts");
    await writeFile(
      preload,
      'process.stdout.write = () => { queueMicrotask(() => process.stdout.emit("error", Object.assign(new Error("fixture transport failure"), { code: "EPIPE" }))); return true; };\n',
    );
    const failed = invokeWithPreload(preload, ...args, "--json");
    expect(failed.exitCode).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toBe("");
  });
}
