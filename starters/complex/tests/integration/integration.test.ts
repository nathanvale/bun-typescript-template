import { afterEach, expect, test } from "bun:test";
import {
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { appendJournal, valueHash } from "../../src/journal.ts";

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

async function waitForCount(
  directory: string,
  suffix: string,
  count: number,
): Promise<void> {
  const deadline = performance.now() + 2_000;
  while (true) {
    const entries = await readdir(directory).catch(() => []);
    if (entries.filter((entry) => entry.endsWith(suffix)).length === count) {
      return;
    }
    if (performance.now() >= deadline) {
      throw new Error(`processes did not produce ${count} ${suffix} markers`);
    }
    await Bun.sleep(2);
  }
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("human help and selected-command discovery expose the supported routes", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-help-"));
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
  expect(JSON.parse(discovery.stdout)).toMatchObject({
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

test.each([
  ["malformed JSON", "{broken"],
  ["schema-invalid JSON", `${JSON.stringify({ value: 42 })}\n`],
])("status reports %s as a deterministic internal failure", async (_case, contents) => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-invalid-state-"));
  roots.push(root);
  const state = join(root, "state.json");
  await writeFile(state, contents);

  const result = invoke(state, "status", "--json");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toBe("");
  expect(JSON.parse(result.stdout).result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNCHANGED",
    commandIdentity: "example.status",
    outcome: "failed",
    retryable: false,
    transactionState: "unchanged",
  });
});

test("two processes serialize one completed set and one safe refusal", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-concurrent-set-"));
  roots.push(root);
  const state = join(root, "state.json");
  const barrier = join(root, "barrier");
  const start = (value: string) => {
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
          CLI_EXAMPLE_TEST_LOCK_BARRIER_PATH: barrier,
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
    }));
  };
  const first = start("first");
  const second = start("second");
  await waitForCount(barrier, ".ready", 2);
  await writeFile(join(barrier, "start"), "start\n");
  await waitForCount(barrier, ".claimed", 1);
  const claimed = (await readdir(barrier)).find((entry) =>
    entry.endsWith(".claimed"),
  );
  const owner = JSON.parse(await readFile(lockPath(state), "utf8"));
  expect(owner).toEqual({
    lockVersion: 1,
    ownerToken: claimed?.replace(/\.claimed$/, ""),
    pid: expect.any(Number),
  });
  expect((await stat(lockPath(state))).mode & 0o777).toBe(0o600);
  const refused = await Promise.race([first, second]);
  await writeFile(join(barrier, "finish"), "finish\n");
  const results = await Promise.all([first, second]);

  expect(refused.exitCode).toBe(3);
  expect(results.map((result) => result.exitCode).sort()).toEqual([0, 3]);
  expect(results.every((result) => result.stderr === "")).toBe(true);
  const completed = results.find((result) => result.exitCode === 0);
  expect(completed).toBeDefined();
  expect(JSON.parse(refused.stdout).result).toMatchObject({
    causeCode: "DOMAIN_PRIOR_RUN_PENDING",
    outcome: "failed",
    retryable: false,
    transactionState: "unknown",
  });
  expect(JSON.parse(await readFile(state, "utf8"))).toEqual({
    value: completed?.value,
  });
  const journal = (await readFile(journalPath(state), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
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
  expect(journal[0].runId).toBe(journal[1].runId);
  expect(journal[0].expectedValueHash).toBe(journal[1].expectedValueHash);
  expect(journal[0].expectedValueHash).toMatch(/^[0-9a-f]{64}$/);
  expect(await Bun.file(lockPath(state)).exists()).toBe(false);
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

test("recover keeps a pending effect unknown when persisted state is invalid", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-recover-invalid-"));
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
  expect(JSON.parse(recovered.stdout).result).toMatchObject({
    causeCode: "INTERNAL_RESULT_UNKNOWN",
    effects: { uncertain: ["effect.set-state"] },
    outcome: "failed",
    retryable: false,
    transactionState: "unknown",
  });
  expect(await readFile(state, "utf8")).toBe("{broken");
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
  expect(await Bun.file(lockPath(state)).exists()).toBe(true);

  const replay = invoke(state, "set", "--value", "enabled", "--json");
  expect(replay.exitCode).toBe(3);
  expect(JSON.parse(replay.stdout).result).toMatchObject({
    causeCode: "DOMAIN_PRIOR_RUN_PENDING",
    outcome: "failed",
    retryable: false,
    transactionState: "unknown",
  });
  expect(await Bun.file(state).exists()).toBe(false);
  expect(await Bun.file(lockPath(state)).exists()).toBe(true);

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
  expect(await Bun.file(lockPath(state)).exists()).toBe(true);
});
