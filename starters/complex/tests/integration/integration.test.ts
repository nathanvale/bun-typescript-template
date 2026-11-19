import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { OperationResult } from "../../src/commands-contract.ts";
import { appendJournal, valueHash } from "../../src/journal.ts";
import { testFolder } from "../support/test-folder.ts";

interface ObservedDocument {
  result: Omit<OperationResult, "message"> & { runId: string };
  [key: string]: unknown;
  phase: string;
  runId: string;
  effectId: string;
  journalVersion: number;
  expectedValueHash: string;
  ownerToken: string;
}
function parseObserved(text: string | undefined): ObservedDocument {
  if (text === undefined) throw new Error("Missing observed JSON document.");
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an observed JSON object.");
  return value as ObservedDocument;
}
function journalEntry(
  rows: ObservedDocument[],
  index: number,
): ObservedDocument {
  const row = rows[index];
  if (row === undefined) throw new Error(`Missing journal row ${index}`);
  return row;
}

const ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];

function journalPath(state: string): string {
  return `${state}.journal.jsonl`;
}

function lockPath(state: string): string {
  return `${state}.journal.lock`;
}

function invoke(state: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", ...args],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: state,
        XDG_STATE_HOME: join(dirname(state), "diagnostics-state"),
      },
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

function reached(met: () => boolean, failure: string): Promise<void> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const poll = setInterval(() => {
      if (met()) resolve();
      else if (performance.now() - started >= 2_000) reject(new Error(failure));
      else return;
      clearInterval(poll);
    }, 2);
  });
}

function waitFor(path: string): Promise<void> {
  return reached(() => existsSync(path), `process did not reach ${path}`);
}

function markers(directory: string, suffix: string): number {
  if (!existsSync(directory)) return 0;
  return readdirSync(directory).filter((entry) => entry.endsWith(suffix))
    .length;
}

function waitForCount(
  directory: string,
  suffix: string,
  count: number,
): Promise<void> {
  return reached(
    () => markers(directory, suffix) === count,
    `processes did not produce ${count} ${suffix} markers`,
  );
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("human help and selected-command discovery expose the supported routes", async () => {
  const root = testFolder("complex-starter-help-");
  roots.push(root);
  const state = join(root, "state.json");

  const help = invoke(state, "--help");
  expect(help.exitCode).toBe(0);
  expect(help.stderr).toBe("");
  expect(help.stdout).toContain(
    "Usage: example status | set --value VALUE [--preview] | recover [--json]",
  );
  expect(help.stdout).toContain("example --discover-command COMMAND_IDENTITY");

  const discovery = invoke(
    state,
    "--discover-command",
    "example.status",
    "--json",
  );
  expect(discovery.exitCode).toBe(0);
  expect(discovery.stderr).toBe("");
  expect(parseObserved(discovery.stdout)).toMatchObject({
    result: {
      data: {
        command: { commandIdentity: "example.status" },
        semantics: "possible-outcomes",
      },
    },
  });
  expect(await Bun.file(state).exists()).toBe(false);
});

test("preview preserves state and apply writes exactly once", async () => {
  const root = testFolder("complex-starter-");
  roots.push(root);
  const state = join(root, "state.json");
  const preview = invoke(
    state,
    "set",
    "--value",
    "enabled",
    "--preview",
    "--json",
  );
  expect(preview.exitCode).toBe(0);
  expect(await Bun.file(state).exists()).toBe(false);
  expect(parseObserved(preview.stdout).result.transactionState).toBe(
    "unchanged",
  );

  const apply = invoke(state, "set", "--value", "enabled", "--json");
  expect(apply.exitCode).toBe(0);
  expect(apply.stderr).toBe("");
  expect(parseObserved(apply.stdout).result.transactionState).toBe("completed");
  expect(JSON.parse(await readFile(state, "utf8")) as unknown).toEqual({
    value: "enabled",
  });
  const journal = (await readFile(journalPath(state), "utf8"))
    .trim()
    .split("\n")
    .map((line) => parseObserved(line));
  expect(journal.map((record) => record.phase)).toEqual([
    "intent",
    "completed",
  ]);
  expect(journalEntry(journal, 0).runId).toBe(journalEntry(journal, 1).runId);
});

test.each([
  ["malformed JSON", "{broken"],
  ["schema-invalid JSON", `${JSON.stringify({ value: 42 })}\n`],
])(
  "status reports %s as a deterministic internal failure",
  async (_case, contents) => {
    const root = testFolder("complex-starter-invalid-state-");
    roots.push(root);
    const state = join(root, "state.json");
    await writeFile(state, contents);

    const result = invoke(state, "status", "--json");
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("");
    expect(parseObserved(result.stdout).result).toMatchObject({
      causeCode: "INTERNAL_RESULT_UNCHANGED",
      commandIdentity: "example.status",
      outcome: "failed",
      retryable: false,
      transactionState: "unchanged",
    });
  },
);

test("two processes serialize one completed set and one safe refusal", async () => {
  const root = testFolder("complex-starter-concurrent-set-");
  roots.push(root);
  const state = join(root, "state.json");
  const barrier = join(root, "barrier");
  const start = (value: string, ownerToken: string) => {
    const child = Bun.spawn(
      [
        process.execPath,
        "run",
        "src/cli.ts",
        "set",
        "--value",
        value,
        "--json",
      ],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLI_EXAMPLE_STATE: state,
          XDG_STATE_HOME: join(root, "diagnostics-state"),
          CLI_EXAMPLE_TEST_LOCK_BARRIER_PATH: barrier,
          CLI_EXAMPLE_TEST_LOCK_OWNER_TOKEN: ownerToken,
          NODE_ENV: "test",
        },
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    return Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]).then(([stdout, stderr, exitCode]) => ({
      exitCode,
      stderr,
      stdout,
      value,
      ownerToken,
    }));
  };
  const first = start("first", "contender-first");
  const second = start("second", "contender-second");
  await waitForCount(barrier, ".ready", 2);
  await writeFile(join(barrier, "start"), "start\n");
  await waitForCount(barrier, ".claimed", 1);
  const claimed = (await readdir(barrier)).find((entry) =>
    entry.endsWith(".claimed"),
  );
  const owner = parseObserved(await readFile(lockPath(state), "utf8"));
  expect(owner).toMatchObject({
    lockVersion: 1,
    pid: expect.any(Number) as unknown,
  });
  expect(["contender-first", "contender-second"]).toContain(owner.ownerToken);
  expect(claimed).toBe(`${owner.ownerToken}.claimed`);
  expect((await stat(lockPath(state))).mode & 0o777).toBe(0o600);
  const refused = await Promise.race([first, second]);
  await writeFile(join(barrier, "finish"), "finish\n");
  const results = await Promise.all([first, second]);

  expect(refused.exitCode).toBe(3);
  expect(results.map((result) => result.exitCode).sort()).toEqual([0, 3]);
  expect(results.every((result) => result.stderr === "")).toBe(true);
  const completed = results.find((result) => result.exitCode === 0);
  expect(completed).toBeDefined();
  if (completed === undefined)
    throw new Error("No successful contender was observed.");
  expect(parseObserved(refused.stdout).result).toMatchObject({
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    outcome: "refused",
    retryable: false,
    transactionState: "unchanged",
  });
  expect(JSON.parse(await readFile(state, "utf8")) as unknown).toEqual({
    value: completed.value,
  });
  const journal = (await readFile(journalPath(state), "utf8"))
    .trim()
    .split("\n")
    .map((line) => parseObserved(line));
  expect(journal).toHaveLength(2);
  expect(journal.map((record) => record.phase)).toEqual([
    "intent",
    "completed",
  ]);
  expect(journal.map((record) => record.effectId)).toEqual([
    "effect.set-state",
    "effect.set-state",
  ]);
  expect(journal.map((record) => record.journalVersion)).toEqual([1, 1]);
  expect(journalEntry(journal, 0).runId).toBe(journalEntry(journal, 1).runId);
  expect(journalEntry(journal, 0).runId).toBe(completed.ownerToken);
  expect(journalEntry(journal, 0).expectedValueHash).toBe(
    journalEntry(journal, 1).expectedValueHash,
  );
  expect(journalEntry(journal, 0).expectedValueHash).toMatch(/^[0-9a-f]{64}$/);
  expect(await Bun.file(lockPath(state)).exists()).toBe(false);
});

test.each(["enabled", "next"])(
  "recovery followed by set %s reconciles completion without replaying it",
  async (requestedValue) => {
    const root = testFolder("complex-starter-recover-");
    roots.push(root);
    const state = join(root, "state.json");
    await writeFile(
      journalPath(state),
      `${JSON.stringify({
        effectId: "effect.set-state",
        expectedValueHash:
          "fb9cf75606b4070dd6a9705810906bba28d0e2ea74ff301b999a91dbb68c7d98",
        journalVersion: 1,
        phase: "intent",
        runId: "interrupted-run",
      })}\n`,
    );
    await writeFile(state, '{"value":"enabled"}\n');
    const before = await readFile(state);
    const beforeStat = await stat(state);
    const journalBefore = await readFile(journalPath(state));

    const recovered = invoke(state, "recover", "--json");
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    expect(parseObserved(recovered.stdout).result).toMatchObject({
      causeCode: "SUCCESS_UNCHANGED",
      commandIdentity: "example.recover",
      transactionState: "unchanged",
      effects: {
        completed: [],
        remaining: [],
        uncertain: [],
        inventoryComplete: true,
      },
      data: { pendingEffect: "effect.set-state", observedState: "completed" },
    });
    expect(await readFile(state)).toEqual(before);
    expect(await readFile(journalPath(state))).toEqual(journalBefore);

    const next = invoke(state, "set", "--value", requestedValue, "--json");
    expect(next.exitCode).toBe(0);
    expect(next.stderr).toBe("");
    expect(JSON.parse(await readFile(state, "utf8")) as unknown).toEqual({
      value: requestedValue,
    });
    const records = (await readFile(journalPath(state), "utf8"))
      .trim()
      .split("\n")
      .map(parseObserved);
    expect(records.map((row) => row.phase)).toEqual(
      requestedValue === "enabled"
        ? ["intent", "completed"]
        : ["intent", "completed", "intent", "completed"],
    );
    expect(journalEntry(records, 1).runId).toBe("interrupted-run");
    if (requestedValue === "enabled") {
      expect((await stat(state)).ino).toBe(beforeStat.ino);
      expect((await stat(state)).mtimeMs).toBe(beforeStat.mtimeMs);
      expect(parseObserved(next.stdout).result.transactionState).toBe(
        "unchanged",
      );
    }
    expect(invoke(state, "recover", "--json").exitCode).toBe(0);
    const following = invoke(state, "set", "--value", "final", "--json");
    expect(following.exitCode).toBe(0);
    expect(JSON.parse(await readFile(state, "utf8")) as unknown).toEqual({
      value: "final",
    });
  },
);

test("recover keeps a pending effect unknown when persisted state is invalid", async () => {
  const root = testFolder("complex-starter-recover-invalid-");
  roots.push(root);
  const state = join(root, "state.json");
  await appendJournal(state, {
    effectId: "effect.set-state",
    expectedValueHash: valueHash("enabled"),
    journalVersion: 1,
    phase: "intent",
    runId: "interrupted-run",
  });
  await writeFile(state, "{broken");

  const recovered = invoke(state, "recover", "--json");
  expect(recovered.exitCode).toBe(1);
  expect(recovered.stderr).toBe("");
  expect(parseObserved(recovered.stdout).result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    effects: {
      completed: [],
      remaining: [],
      uncertain: [],
      inventoryComplete: true,
    },
    outcome: "failed",
    retryable: false,
    transactionState: "unchanged",
  });
  const next = invoke(state, "set", "--value", "next", "--json");
  expect(next.exitCode).toBe(3);
  expect(next.stderr).toBe("");
  expect(parseObserved(next.stdout).result).toMatchObject({
    causeCode: "DOMAIN_PRIOR_RUN_PENDING",
    outcome: "refused",
    transactionState: "unchanged",
    data: null,
    effects: {
      completed: [],
      remaining: [],
      uncertain: [],
      inventoryComplete: true,
    },
  });
  expect(await readFile(state, "utf8")).toBe("{broken");
  expect(
    (await readFile(journalPath(state), "utf8")).trim().split("\n"),
  ).toHaveLength(1);
});

test("public routes ignore held-open stdin and finish after stdout drains", async () => {
  const root = testFolder("complex-starter-lifecycle-");
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
        XDG_STATE_HOME: join(root, "diagnostics-state"),
      },
      stdin: "pipe",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(parseObserved(stdout).result.commandIdentity).toBe("example.status");
  await child.stdin.end();
});

test.each(["SIGINT", "SIGTERM"] as const)(
  "%s after handler readiness stops output at the 500ms flush deadline",
  async (signal) => {
    const root = testFolder("complex-starter-signal-");
    roots.push(root);
    const ready = join(root, "ready");
    const child = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "status", "--json"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLI_EXAMPLE_STATE: join(root, "state.json"),
          XDG_STATE_HOME: join(root, "diagnostics-state"),
          CLI_EXAMPLE_TEST_DELAY_MS: "2000",
          CLI_EXAMPLE_TEST_DIAGNOSTIC_FLUSH_MS: "2000",
          CLI_EXAMPLE_TEST_READY_PATH: ready,
          NODE_ENV: "test",
        },
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    await waitFor(ready);
    const started = performance.now();
    child.kill(signal);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(400);
    expect(elapsed).toBeLessThan(750);
    expect(exitCode).toBe(signal === "SIGINT" ? 130 : 143);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
  },
);

test("a repeated termination exits immediately during diagnostic flush", async () => {
  const root = testFolder("complex-starter-repeat-");
  roots.push(root);
  const ready = join(root, "ready");
  const flushing = join(root, "flushing");
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
        XDG_STATE_HOME: join(root, "diagnostics-state"),
        CLI_EXAMPLE_TEST_DELAY_MS: "2000",
        CLI_EXAMPLE_TEST_DIAGNOSTIC_FLUSH_MS: "2000",
        CLI_EXAMPLE_TEST_DIAGNOSTIC_FLUSH_PATH: flushing,
        CLI_EXAMPLE_TEST_READY_PATH: ready,
        NODE_ENV: "test",
      },
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  await waitFor(ready);
  child.kill("SIGINT");
  await waitFor(flushing);
  const started = performance.now();
  child.kill("SIGINT");
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(performance.now() - started).toBeLessThan(250);
  expect(exitCode).toBe(130);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
});

test.each(["uncaught", "unhandled"] as const)(
  "%s crash makes one silent emergency exit",
  async (crash) => {
    const root = testFolder("complex-starter-crash-");
    roots.push(root);
    const ready = join(root, "ready");
    const state = join(root, "state.json");
    const child = Bun.spawn(
      [process.execPath, "run", "src/cli.ts", "status", "--json"],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          CLI_EXAMPLE_STATE: state,
          XDG_STATE_HOME: join(root, "diagnostics-state"),
          CLI_EXAMPLE_TEST_CRASH: crash,
          CLI_EXAMPLE_TEST_READY_PATH: ready,
          NODE_ENV: "test",
        },
        stdin: "ignore",
        stderr: "pipe",
        stdout: "pipe",
      },
    );
    await waitFor(ready);
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(exitCode).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toBe("");
    expect(await Bun.file(state).exists()).toBe(false);
  },
);

test("consumer disappearance before a large stdout drain exits internal", async () => {
  const root = testFolder("complex-starter-epipe-");
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
        XDG_STATE_HOME: join(root, "diagnostics-state"),
        CLI_EXAMPLE_TEST_OUTPUT_BYTES: "4000000",
        NODE_ENV: "test",
      },
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  await child.stdout.cancel();
  const [stderr, exitCode] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(1);
  expect(stderr).toBe("");
});

test("a live consumer receives the complete large envelope before normal exit", async () => {
  const root = testFolder("complex-starter-drain-");
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
        XDG_STATE_HOME: join(root, "diagnostics-state"),
        CLI_EXAMPLE_TEST_OUTPUT_BYTES: "1000000",
        NODE_ENV: "test",
      },
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(0);
  expect(stderr).toBe("");
  expect(
    (parseObserved(stdout).result.data as { padding: string }).padding,
  ).toHaveLength(1_000_000);
});

test("an interrupted set leaves intent, refuses replay, and recovers read-only", async () => {
  const root = testFolder("complex-starter-interrupted-");
  roots.push(root);
  const state = join(root, "state.json");
  const ready = join(root, "intent-ready");
  const child = Bun.spawn(
    [
      process.execPath,
      "run",
      "src/cli.ts",
      "set",
      "--value",
      "enabled",
      "--json",
    ],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: state,
        XDG_STATE_HOME: join(root, "diagnostics-state"),
        CLI_EXAMPLE_TEST_AFTER_INTENT_DELAY_MS: "2000",
        CLI_EXAMPLE_TEST_AFTER_INTENT_READY_PATH: ready,
        NODE_ENV: "test",
      },
      stdin: "ignore",
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  await waitFor(ready);
  child.kill("SIGTERM");
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  expect(exitCode).toBe(143);
  expect(stdout).toBe("");
  expect(stderr).toBe("");
  expect(await Bun.file(state).exists()).toBe(false);
  expect(
    (await readFile(journalPath(state), "utf8")).trim().split("\n"),
  ).toHaveLength(1);
  expect(await Bun.file(lockPath(state)).exists()).toBe(true);

  const replay = invoke(state, "set", "--value", "enabled", "--json");
  expect(replay.exitCode).toBe(3);
  expect(parseObserved(replay.stdout).result).toMatchObject({
    causeCode: "DOMAIN_PRECONDITION_UNMET",
    nextAction: expect.stringContaining(
      "Remove crash residue only after",
    ) as unknown,
    outcome: "refused",
    retryable: false,
    transactionState: "unchanged",
  });
  expect(await Bun.file(state).exists()).toBe(false);
  expect(await Bun.file(lockPath(state)).exists()).toBe(true);

  const recovery = invoke(state, "recover", "--json");
  expect(recovery.exitCode).toBe(1);
  expect(parseObserved(recovery.stdout).result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    outcome: "failed",
    retryable: false,
    transactionState: "unchanged",
  });
  expect(
    (await readFile(journalPath(state), "utf8")).trim().split("\n"),
  ).toHaveLength(1);
  expect(await Bun.file(lockPath(state)).exists()).toBe(true);
});
