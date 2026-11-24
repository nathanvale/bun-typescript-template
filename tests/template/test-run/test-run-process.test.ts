import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import {
  leftoverFolders,
  processRows,
  reportProcessRows,
  runTests,
  stopProcess,
  type TestRunEnvironment,
  testRunFolderVariable,
} from "../../../scripts/test-run.ts";
import {
  ownedFolders,
  testRunFiles,
  write,
  writeExecutable,
} from "../../support/fixture-files.ts";
import {
  processAlive,
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";

const folder = ownedFolders();
const bound = 20_000;
const pass = 'import { test } from "bun:test";\ntest("ok", () => {});\n';
const psRepair = "Repair: make ps answer, then run the tests again.";

const specimen = (tests: Readonly<Record<string, string>>) => {
  const root = folder("test-run-specimen-");
  for (const [p, t] of Object.entries({ ...testRunFiles(), ...tests }))
    write(root, p, t);
  return root;
};

const psEnv = (temp: string, ps: string, extra: TestRunEnvironment = {}) => {
  const dir = folder("test-run-stub-");
  writeExecutable(dir, "ps", ps);
  return {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH ?? ""}`,
    TMPDIR: temp,
    CI: undefined,
    npm_lifecycle_event: undefined,
    [testRunFolderVariable]: undefined,
    ...extra,
  };
};

async function reap(pids: readonly number[]): Promise<number[]> {
  const started = Date.now();
  const left = await new Promise<number[]>((resolve) => {
    const poll = setInterval(() => {
      const alive = pids.filter(processAlive);
      if (alive.length > 0 && Date.now() - started < 2_000) return;
      clearInterval(poll);
      resolve(alive);
    }, 20);
  });
  for (const pid of left) stopProcess(pid, true);
  return left;
}

const runCase = (
  tests: Readonly<Record<string, string>>,
  env: TestRunEnvironment,
  leftover: readonly string[],
  strict: boolean,
  lines: string[] = [],
  limit = bound,
) =>
  runTests([], {
    cwd: specimen(tests),
    env,
    leftoverFolders: leftover,
    strict,
    report: (l) => lines.push(l),
    limitMilliseconds: limit,
  });

const startRun = (
  tests: Readonly<Record<string, string>>,
  temp: string,
  ps: string,
  extra: TestRunEnvironment,
) =>
  startChild([process.execPath, "scripts/test-run.ts"], {
    cwd: specimen(tests),
    env: psEnv(temp, ps, extra),
    limitMilliseconds: bound,
    graceMilliseconds: 0,
  });

test.each([
  ["without CI", undefined, 0],
  ["under CI", "true", 1],
] as const)(
  "when ps is refused %s, the test run still stops its process group",
  async (_label, ci, exit) => {
    const temp = folder("test-run-temp-");
    const L = join(folder("test-run-ledger-"), "pid");
    const child =
      'import { test } from "bun:test";\ntest("c", () => { Bun.spawnSync(["sh", "-c", \'sleep 30 >/dev/null 2>&1 & echo "$!" > "$L"\']); });\n';
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: specimen({ "tests/c.test.ts": child, "tests/p.test.ts": pass }),
      env: psEnv(temp, 'echo "ps: EPERM" >&2\nexit 1', { CI: ci, L }),
      processGroup: true,
    });
    const pid = Number(readFileSync(L, "utf8").trim());
    expect([pid > 0, run.exit]).toEqual([true, exit]);
    if (ci === "true") {
      expect(run.stderr).toContain("EPERM");
      expect(run.stderr).toContain(psRepair);
    } else
      expect(
        run.stderr.split("Warning: process listing is unavailable").length - 1,
      ).toBe(1);
    expect([...(await reap([pid])), ...readdirSync(temp)]).toEqual([]);
  },
  processWatchdog(1),
);

test("when ps cannot be spawned, processRows reports the refusal and reportProcessRows warns once", () => {
  const empty = folder("test-run-empty-path-");
  const result = processRows({ PATH: empty });
  expect(result.ok).toBe(false);
  if (result.ok) return;
  expect(result.message).toContain(psRepair);
  const lines: string[] = [];
  reportProcessRows(empty, result.message, (l) => lines.push(l));
  reportProcessRows(empty, result.message, (l) => lines.push(l));
  expect(lines).toHaveLength(1);
});

test(
  "two concurrent strict test runs do not report each other's live test run folder as a leftover",
  async () => {
    const temp = folder("test-run-temp-");
    const L = join(folder("test-run-ledger-"), "overlap");
    const env = psEnv(temp, "exit 0", { L });
    const wait = (w: string, g: string) =>
      `import { test } from "bun:test";\nimport { appendFileSync, existsSync, readFileSync } from "node:fs";\ntest("o", async () => { const f = process.env.L; appendFileSync(f, ${JSON.stringify(`${w}\n`)}); const t = Date.now(); await new Promise((r) => { const p = setInterval(() => { if (!(existsSync(f) ? readFileSync(f, "utf8") : "").split("\\n").includes(${JSON.stringify(g)}) && Date.now() - t < 10_000) return; clearInterval(p); r(undefined); }, 10); }); }, 20_000);\n`;
    const lines: string[] = [];
    const a = runCase(
      { "tests/a.test.ts": wait("a-on", "b-on") },
      env,
      [temp],
      true,
      lines,
    );
    const wa = watchLedger(L, "a-on", bound);
    let b: ReturnType<typeof runCase> | undefined;
    try {
      await wa.reached;
      b = runCase(
        { "tests/b.test.ts": wait("b-on", "a-off") },
        env,
        [temp],
        true,
        lines,
      );
      const ra = await a;
      writeFileSync(L, `${readFileSync(L, "utf8")}a-off\n`);
      expect([
        ra.exitCode,
        (await b).exitCode,
        ...lines,
        ...readdirSync(temp),
      ]).toEqual([0, 0]);
    } finally {
      wa.stop();
      writeFileSync(L, "b-on\na-off\n");
      await Promise.allSettled([a, b]);
    }
  },
  processWatchdog(2),
);

test(
  "when the test run is killed, the preload stops detached child process groups before removing the run folder",
  async () => {
    const temp = folder("test-run-temp-");
    const dir = folder("test-run-watchdog-");
    const [L, P, O] = [join(dir, "l"), join(dir, "p"), join(dir, "o")];
    const ps =
      'if [ -n "$TEST_RUN_FOLDER" ] && [ -d "$TEST_RUN_FOLDER" ]; then echo "ok" >> "$O"; fi\nif [ -f "$P" ]; then read b c < "$P"; echo "$b 1 $b S"; echo "$c $b $c S"; fi';
    const body =
      'import { test } from "bun:test";\nimport { appendFileSync, writeFileSync } from "node:fs";\ntest("h", async () => { const c = Bun.spawn(["sleep", "308"], { detached: true }); writeFileSync(process.env.P, `${process.pid} ${c.pid}\\n`); appendFileSync(process.env.L, `${process.pid}\\n${c.pid}\\nready\\n`); await new Promise(() => {}); }, 60_000);\n';
    const run = startRun({ "tests/h.test.ts": body }, temp, ps, { L, P, O });
    const w = watchLedger(L, "ready", bound);
    try {
      await w.reached;
    } finally {
      run.stop();
      w.stop();
      await run.finished;
    }
    const pids = readFileSync(L, "utf8").split("\n").slice(0, 2).map(Number);
    expect(pids.length === 2 && pids.every((p) => p > 0)).toBe(true);
    expect([...(await reap(pids)), ...readdirSync(temp)]).toEqual([]);
    expect(existsSync(O) && readFileSync(O, "utf8")).toContain("ok");
  },
  processWatchdog(1),
);

test.each([
  ["after the grace window", false, 1_500, 4_500],
  ["immediately on a second signal", true, 0, 1_200],
] as const)(
  "when bun test traps SIGTERM, the test run escalates to SIGKILL %s",
  async (_label, second, minMs, maxMs) => {
    const temp = folder("test-run-temp-");
    const L = join(folder("test-run-ledger-"), "sig");
    const body =
      'import { test } from "bun:test";\nimport { appendFileSync } from "node:fs";\ntest("t", async () => { process.on("SIGTERM", () => appendFileSync(process.env.L, "trapped\\n")); await Bun.spawn(["sh", "-c", \'trap "" TERM; echo "$$" >> "$L"; echo ready >> "$L"; sleep 6\']).exited; }, 20_000);\n';
    const run = startRun({ "tests/t.test.ts": body }, temp, "exit 0", { L });
    const [r, t] = [
      watchLedger(L, "ready", bound),
      watchLedger(L, "trapped", bound),
    ];
    let at: number;
    let signaled = false;
    try {
      await r.reached;
      if (second) {
        run.signal("SIGTERM");
        await t.reached;
      }
      at = Date.now();
      run.signal("SIGTERM");
      signaled = true;
    } finally {
      r.stop();
      t.stop();
      if (!signaled) {
        run.stop();
        await run.finished;
      }
    }
    const result = await run.finished;
    const elapsed = Date.now() - at;
    const pid = Number(readFileSync(L, "utf8").split("\n")[0]);
    expect(pid).toBeGreaterThan(0);
    const left = await reap([pid]);
    expect(elapsed).toBeGreaterThanOrEqual(minMs);
    expect(elapsed).toBeLessThan(maxMs);
    expect([result.signalCode, ...left, ...readdirSync(temp)]).toEqual([
      "SIGKILL",
    ]);
  },
  processWatchdog(1),
);

test.skipIf(process.getuid?.() === 0)(
  "an unreadable leftover folder is reported instead of read as empty",
  async () => {
    const temp = folder("test-run-temp-");
    const locked = join(folder("test-run-unreadable-"), "locked");
    mkdirSync(locked);
    chmodSync(locked, 0o000);
    let caught: unknown;
    try {
      await runCase(
        { "tests/p.test.ts": pass },
        psEnv(temp, "exit 0"),
        [locked],
        true,
      );
    } catch (error) {
      caught = error;
    } finally {
      chmodSync(locked, 0o700);
    }
    expect(String(caught)).toMatch(/EACCES|permission denied/i);
  },
  processWatchdog(1),
);

test("leftoverFolders refuses a failing bare temp subprocess instead of reading it as empty", () => {
  const temp = folder("test-run-temp-");
  const bad = writeExecutable(
    folder("test-run-stub-"),
    "bun",
    'echo "bare temp failed" >&2\nexit 1',
  );
  expect(() => leftoverFolders({ TMPDIR: temp }, bad)).toThrow(
    "Reading the bare system temp folder",
  );
});

test(
  "limitMilliseconds stops a hanging test run and its process group before the test finishes",
  async () => {
    const temp = folder("test-run-temp-");
    const L = join(folder("test-run-ledger-"), "limit");
    const body =
      'import { test } from "bun:test";\nimport { appendFileSync } from "node:fs";\ntest("s", async () => { const c = Bun.spawn(["sleep", "5"]); appendFileSync(process.env.L, `${process.pid}\\n${c.pid}\\nready\\n`); await c.exited; }, 20_000);\n';
    const started = Date.now();
    const result = await runCase(
      { "tests/s.test.ts": body },
      psEnv(temp, "exit 0", { L }),
      [temp],
      false,
      [],
      1_500,
    );
    const elapsed = Date.now() - started;
    expect(existsSync(L)).toBe(true);
    const pids = readFileSync(L, "utf8").split("\n").slice(0, 2).map(Number);
    expect(pids.length === 2 && pids.every((p) => p > 0)).toBe(true);
    expect([
      result.signalCode,
      ...(await reap(pids)),
      ...readdirSync(temp),
    ]).toEqual(["SIGKILL"]);
    expect(elapsed).toBeLessThan(3_500);
  },
  processWatchdog(1),
);
