import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendJournal, valueHash } from "../../src/journal.ts";

const ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];

function journalPath(state: string): string {
  return `${state}.journal.jsonl`;
}

function invoke(state: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", ...args],
    {
      cwd: ROOT,
      env: { ...process.env, CLI_EXAMPLE_STATE: state },
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

async function waitFor(path: string): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (!(await Bun.file(path).exists())) {
    if (performance.now() >= deadline) {
      throw new Error(`process did not reach ${path}`);
    }
    await Bun.sleep(2);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("preview preserves state and apply writes exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-"));
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
  expect(JSON.parse(preview.stdout).result.transactionState).toBe("unchanged");

  const apply = invoke(state, "set", "--value", "enabled", "--json");
  expect(apply.exitCode).toBe(0);
  expect(apply.stderr).toBe("");
  expect(JSON.parse(apply.stdout).result.transactionState).toBe("completed");
  expect(JSON.parse(await readFile(state, "utf8"))).toEqual({
    value: "enabled",
  });
  const journal = (await readFile(journalPath(state), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(journal.map((record) => record.phase)).toEqual([
    "intent",
    "completed",
  ]);
  expect(journal[0].runId).toBe(journal[1].runId);
});

test("recover inspects a pending journal intent and never replays it", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-recover-"));
  roots.push(root);
  const state = join(root, "state.json");
  await appendJournal(state, {
    effectId: "effect.set-state",
    expectedValueHash: valueHash("enabled"),
    journalVersion: 1,
    phase: "intent",
    runId: "interrupted-run",
  });
  await writeFile(state, `${JSON.stringify({ value: "enabled" })}\n`);
  const before = await readFile(state);

  const recovered = invoke(state, "recover", "--json");
  expect(recovered.exitCode).toBe(0);
  expect(recovered.stderr).toBe("");
  expect(JSON.parse(recovered.stdout).result).toMatchObject({
    causeCode: "SUCCESS_COMPLETED",
    commandIdentity: "example.recover",
    retryable: false,
    transactionState: "completed",
  });
  expect(await readFile(state)).toEqual(before);
  expect(
    (await readFile(journalPath(state), "utf8")).trim().split("\n"),
  ).toHaveLength(1);
});

test("public routes ignore held-open stdin and finish after stdout drains", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-lifecycle-"));
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: { ...process.env, CLI_EXAMPLE_STATE: join(root, "state.json") },
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
  expect(JSON.parse(stdout).result.commandIdentity).toBe("example.status");
  child.stdin.end();
});

test.each([
  "SIGINT",
  "SIGTERM",
] as const)("%s after handler readiness stops output at the 500ms flush deadline", async (signal) => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-signal-"));
  roots.push(root);
  const ready = join(root, "ready");
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
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
});

test("a repeated termination exits immediately during diagnostic flush", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-repeat-"));
  roots.push(root);
  const ready = join(root, "ready");
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
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
  child.kill("SIGINT");
  await Bun.sleep(30);
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

test.each([
  "uncaught",
  "unhandled",
] as const)("%s crash makes one silent emergency exit", async (crash) => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-crash-"));
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
});

test("consumer disappearance before a large stdout drain exits internal", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-epipe-"));
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
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
  const root = await mkdtemp(join(tmpdir(), "complex-starter-drain-"));
  roots.push(root);
  const child = Bun.spawn(
    [process.execPath, "run", "src/cli.ts", "status", "--json"],
    {
      cwd: ROOT,
      env: {
        ...process.env,
        CLI_EXAMPLE_STATE: join(root, "state.json"),
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
  expect(JSON.parse(stdout).result.data.padding).toHaveLength(1_000_000);
});

test("an interrupted set leaves intent, refuses replay, and recovers read-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-interrupted-"));
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

  const replay = invoke(state, "set", "--value", "enabled", "--json");
  expect(replay.exitCode).toBe(3);
  expect(JSON.parse(replay.stdout).result).toMatchObject({
    causeCode: "DOMAIN_PRIOR_RUN_PENDING",
    outcome: "failed",
    retryable: false,
    transactionState: "unknown",
  });
  expect(await Bun.file(state).exists()).toBe(false);

  const recovery = invoke(state, "recover", "--json");
  expect(recovery.exitCode).toBe(1);
  expect(JSON.parse(recovery.stdout).result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    outcome: "failed",
    retryable: false,
    transactionState: "unknown",
  });
  expect(
    (await readFile(journalPath(state), "utf8")).trim().split("\n"),
  ).toHaveLength(1);
});
