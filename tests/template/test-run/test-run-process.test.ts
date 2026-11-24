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
  childProcessRows,
  commandOf,
  leftoverFolders,
  leftoverProcessProblems,
  processRows,
  runTests,
  stopProcess,
  type TestRunEnvironment,
  testRunFolderVariable,
  testRunProcessMark,
  testRunProcessVariable,
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

test(
  "when ps is refused, teardown stops a detached child and the launcher stops any remaining process group child",
  async () => {
    const temp = folder("test-run-temp-");
    const L = join(folder("test-run-ledger-"), "pids");
    const child =
      'import { test } from "bun:test";\nimport { appendFileSync } from "node:fs";\ntest("c", () => { const d = Bun.spawn(["sleep", "30"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); appendFileSync(process.env.L, `${d.pid}\\n`); Bun.spawnSync(["sh", "-c", \'sleep 31 >/dev/null 2>&1 & echo "$!" >> "$L"\']); });\n';
    let left: number[] = [];
    let pids: number[];
    let run: Awaited<ReturnType<typeof spawnBounded>>;
    try {
      run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
        cwd: specimen({ "tests/c.test.ts": child, "tests/p.test.ts": pass }),
        env: psEnv(temp, 'echo "ps: EPERM" >&2\nexit 1', { L }),
        processGroup: true,
      });
    } finally {
      pids = existsSync(L)
        ? readFileSync(L, "utf8").trim().split("\n").map(Number)
        : [];
      if (pids.length > 0) left = await reap(pids);
    }
    expect([pids.length === 2 && pids.every((p) => p > 0), run.exit]).toEqual([
      true,
      1,
    ]);
    expect(run.stderr).toContain(
      "Tests left 1 child process(es) running at teardown, and they were stopped:",
    );
    expect(run.stderr).toContain(": sleep 30");
    expect(run.stderr).toContain(": sleep 31");
    expect([...left, ...readdirSync(temp)]).toEqual([]);
  },
  processWatchdog(1),
);

test("when all process listing routes fail, processRows refuses with a repair and leftoverProcessProblems fails closed", () => {
  const temp = folder("test-run-temp-");
  const empty = folder("test-run-empty-path-");
  const exited = processRows(
    psEnv(temp, 'echo "ps: EPERM" >&2\nexit 1'),
    "freebsd",
  );
  expect(exited.ok).toBe(false);
  if (!exited.ok) {
    expect(exited.message).toContain("EPERM");
    expect(exited.message).toContain(psRepair);
    expect(leftoverProcessProblems(1, exited)).toEqual([exited.message]);
    expect(() => childProcessRows(exited, 1)).toThrow(psRepair);
  }
  const missing = processRows({ PATH: empty }, "linux", join(empty, "no-proc"));
  expect(missing.ok).toBe(false);
  if (!missing.ok) {
    expect(missing.message).toContain("no-proc");
    expect(missing.message).toContain("Fallback:");
    expect(missing.message).toContain(psRepair);
  }
  const emptyProc = processRows({ PATH: empty }, "linux", empty);
  expect(emptyProc.ok).toBe(false);
  if (!emptyProc.ok)
    expect(emptyProc.message).toContain("no readable processes");
});

test("linux /proc listing parses stat with spaces and parentheses, skips zombies, and reads cmdline", () => {
  const proc = folder("test-run-proc-");
  write(proc, "42/stat", "42 (my (app) 1) S 10 42 10 0 -1\n");
  write(proc, "42/cmdline", "sleep\x0030\x00");
  write(proc, "43/stat", "43 (defunct) Z 10 43 10 0 -1\n");
  expect(processRows({}, "linux", proc)).toEqual({
    ok: true,
    rows: [
      {
        pid: 42,
        parentPid: 10,
        group: 42,
        text: "pid 42 (process group 42, state S)",
      },
    ],
  });
  expect(commandOf(42, {}, "linux", proc)).toBe("sleep 30");
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
  "when the test run is killed and ps is refused, the preload still stops detached child processes",
  async () => {
    const temp = folder("test-run-temp-");
    const L = join(folder("test-run-ledger-"), "killed-detached");
    const body =
      'import { test } from "bun:test";\nimport { appendFileSync } from "node:fs";\ntest("h", async () => { const c = Bun.spawn(["sleep", "308"], { detached: true, stdin: "ignore", stdout: "ignore", stderr: "ignore" }); appendFileSync(process.env.L, `${process.pid}\\n${c.pid}\\nready\\n`); await new Promise(() => {}); }, 60_000);\n';
    const run = startRun(
      { "tests/h.test.ts": body },
      temp,
      'echo "ps: EPERM" >&2\nexit 1',
      { L },
    );
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

test(
  "a strict test run fails and names leaked test-run-* files, folders, stale marks and links to live run folders",
  async () => {
    const temp = folder("test-run-temp-");
    const live = folder("test-run-live-");
    writeFileSync(
      join(live, testRunProcessMark),
      `${testRunProcessVariable}=${process.pid}\n`,
    );
    const leaked = [
      "test-run-planted-file",
      "test-run-planted-dir",
      "test-run-planted-stale",
      "test-run-planted-bom",
      "test-run-planted-link",
      "test-run-planted-mark-link",
    ];
    const body = `import { test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
test("l", async () => {
  const t = process.env.T, live = process.env.LIVE, m = ${JSON.stringify(testRunProcessMark)}, d = Bun.spawn(["true"]);
  await d.exited;
  writeFileSync(join(t, "test-run-planted-file"), "x");
  mkdirSync(join(t, "test-run-planted-dir"));
  mkdirSync(join(t, "test-run-planted-stale"));
  writeFileSync(join(t, "test-run-planted-stale", m), \`${testRunProcessVariable}=\${d.pid}\\n\`);
  mkdirSync(join(t, "test-run-planted-bom"));
  writeFileSync(join(t, "test-run-planted-bom", m), \`\\uFEFF${testRunProcessVariable}=\${process.pid}\\n\`);
  symlinkSync(live, join(t, "test-run-planted-link"));
  mkdirSync(join(t, "test-run-planted-mark-link"));
  symlinkSync(join(live, m), join(t, "test-run-planted-mark-link", m));
});`;
    const lines: string[] = [];
    const result = await runCase(
      { "tests/l.test.ts": body },
      psEnv(temp, "exit 0", { T: temp, LIVE: live }),
      [temp],
      true,
      lines,
    );
    const text = lines.join("\n");
    expect(result.exitCode).toBe(1);
    expect(text).toContain(
      "Tests left 6 entry(ies) in the system temp folder, outside the test run folder:",
    );
    for (const name of leaked)
      expect(text).toContain(`\n  ${join(temp, name)}`);
  },
  processWatchdog(1),
);
