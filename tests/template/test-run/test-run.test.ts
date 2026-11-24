import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";
import {
  insideFolder,
  leftoverFolders,
  processRows,
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
import { startChild } from "../../../scripts/process-runner.ts";
import {
  processAlive,
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";

const folder = ownedFolders();
const runBound = 20_000;

const leakingRoutes = `import { test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as childProcess from "node:child_process";
const { spawnSync: destructured } = Bun;
const aliased = Bun.spawn;
const make = (route) => ["sh", "-c", \`mktemp -d "\${"$"}{TMPDIR%/}/planted-\${route}-XXXXXX"\`];
test("direct", () => { mkdtempSync(join(tmpdir(), "planted-direct-")); });
test("Bun.spawnSync", () => { Bun.spawnSync(make("spawnSync")); });
test("Bun.spawn", async () => { await Bun.spawn(make("spawn")).exited; });
test("destructured", () => { destructured(make("destructured")); });
test("aliased", async () => { await aliased(make("aliased")).exited; });
test("Bun.$", async () => { await Bun.$\`mktemp -d \${tmpdir()}/planted-shell-XXXXXX\`.quiet(); });
test("node:child_process", () => { childProcess.execSync(make("node").map((part) => \`'\${part}'\`).join(" ")); });
`;

const leftRunning = `import { test } from "bun:test";
import { spawn } from "node:child_process";
test("leaves children running", () => {
  Bun.spawn(["sleep", "301"]);
  Bun.spawn(["sleep", "302"], { detached: true });
  Bun.spawnSync(["sh", "-c", "sleep 303 >/dev/null 2>&1 &"]);
  spawn("sleep", ["304"], { detached: true, stdio: "ignore" }).unref();
  spawn("sleep", ["305"], { stdio: "ignore" });
});
`;

const hanging = `import { test } from "bun:test";
import { appendFileSync } from "node:fs";
test("hangs", async () => {
  const child = Bun.spawn(["sleep", "307"]);
  appendFileSync(process.env.HANG_LEDGER, \`\${process.pid}\\n\${child.pid}\\nready\\n\`);
  await new Promise(() => {});
}, 60_000);
`;

function gone(pids: readonly number[], bound: number): Promise<number[]> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const alive = pids.filter(processAlive);
      if (alive.length > 0 && Date.now() - started < bound) return;
      clearInterval(poll);
      resolve(alive);
    }, 20);
  });
}

const passing = `import { expect, test } from "bun:test";
test("passes", () => { expect(1).toBe(1); });
`;

function hardCoded(path: string): string {
  return `import { test } from "bun:test";
import { mkdirSync } from "node:fs";
test("writes a fixed temp path", () => { mkdirSync(${JSON.stringify(path)}); });
`;
}

function specimen(tests: Readonly<Record<string, string>>): string {
  const root = folder("test-run-specimen-");
  for (const [path, text] of Object.entries({ ...testRunFiles(), ...tests }))
    write(root, path, text);
  return root;
}

function outsideRun(temp: string): Record<string, string | undefined> {
  return {
    ...process.env,
    TMPDIR: temp,
    CI: undefined,
    npm_lifecycle_event: undefined,
    [testRunFolderVariable]: undefined,
  };
}

const psBlockedLocally = process.env.CI !== "true" && !processRows().ok;

function withPs(env: TestRunEnvironment, body: string) {
  const dir = folder("test-run-stub-");
  writeExecutable(dir, "ps", body);
  return { ...env, PATH: `${dir}${delimiter}${env.PATH ?? ""}` };
}

async function runIn(
  root: string,
  temp: string,
  strict: boolean,
  args: readonly string[] = [],
) {
  const lines: string[] = [];
  const base = outsideRun(temp);
  const { exitCode: exit } = await runTests(args, {
    cwd: root,
    env: psBlockedLocally ? withPs(base, "exit 0") : base,
    leftoverFolders: [temp],
    strict,
    report: (line) => lines.push(line),
    limitMilliseconds: runBound,
  });
  return { exit, text: lines.join("\n") };
}

function sleepsLeft(env: TestRunEnvironment = process.env): string[] {
  const own = new Set(
    [301, 302, 303, 304, 305].map((seconds) => `sleep ${seconds}`),
  );
  const ps = Bun.spawnSync(["ps", "-A", "-o", "args="], {
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: 10_000,
    killSignal: "SIGKILL",
  });
  if (ps.exitedDueToTimeout || ps.exitCode !== 0)
    throw new Error(
      `ps -A exited ${String(ps.exitCode)} while checking leftover sleep processes: ${ps.stderr.toString().trim() || "(no output)"}`,
    );
  return ps.stdout
    .toString()
    .split("\n")
    .map((line) => line.trim())
    .filter((args) => own.has(args));
}

test("insideFolder admits the folder and what it holds, and refuses a sibling with the same prefix", () => {
  expect([
    insideFolder("/run/a", "/run/a"),
    insideFolder("/run/a/b", "/run/a"),
    insideFolder("/run/ab", "/run/a"),
    insideFolder("/run", "/run/a"),
  ]).toEqual([true, true, false, false]);
});

test("leftoverFolders names none inside another test run, so a nested run leaves the system temp folder to the outer one", () => {
  const temp = folder("test-run-temp-");
  expect(
    leftoverFolders({ TMPDIR: temp, [testRunFolderVariable]: temp }),
  ).toEqual([]);
  expect(leftoverFolders({ TMPDIR: temp })).toContain(temp);
});

test(
  "the control: without the test run, each planted spawn route leaves a folder in the temp folder",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({
      "bunfig.toml": '[install]\nauto = "disable"\n',
      "tests/leaks.test.ts": leakingRoutes,
    });
    const run = await spawnBounded([process.execPath, "test"], {
      cwd: root,
      env: outsideRun(temp),
    });
    expect(run.exit).toBe(0);
    expect(
      readdirSync(temp)
        .map((name) => name.replace(/-[^-]+$/, ""))
        .toSorted(),
    ).toEqual(
      [
        "planted-spawn",
        "planted-aliased",
        "planted-destructured",
        "planted-direct",
        "planted-node",
        "planted-shell",
        "planted-spawnSync",
      ].toSorted(),
    );
  },
  processWatchdog(1),
);

test(
  "the test run keeps what every spawn route writes inside its run folder, and removes it",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({ "tests/leaks.test.ts": leakingRoutes });
    expect(await runIn(root, temp, true)).toEqual({ exit: 0, text: "" });
    expect(readdirSync(temp)).toEqual([]);
  },
  processWatchdog(1),
);

test.skipIf(psBlockedLocally)(
  "the test run fails, names and stops each child a test leaves running, by every spawn route",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({ "tests/running.test.ts": leftRunning });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideRun(temp),
      processGroup: true,
    });
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "Tests left 1 process(es) running after bun test exited, and they were stopped:",
    );
    expect(run.stderr).toContain(": sleep 303");
    expect(sleepsLeft()).toEqual([]);
  },
  processWatchdog(1),
);

test.skipIf(psBlockedLocally)(
  "the teardown check fails the file and stops each child still running when its tests end",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({ "tests/running.test.ts": leftRunning });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideRun(temp),
      processGroup: true,
    });
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "Tests left 4 child process(es) running at teardown, and they were stopped:",
    );
    for (const seconds of [301, 302, 304, 305])
      expect(run.stderr).toContain(`: sleep ${seconds}`);
    expect(sleepsLeft()).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "a strict test run fails and names an entry a test writes at a fixed path in the system temp folder",
  async () => {
    const temp = folder("test-run-temp-");
    const leftover = join(temp, "planted-fixed-path");
    const root = specimen({ "tests/fixed.test.ts": hardCoded(leftover) });
    const run = await runIn(root, temp, true);
    expect(run.exit).toBe(1);
    expect(run.text).toStartWith(
      `Tests left 1 entry(ies) in the system temp folder, outside the test run folder:\n  ${leftover}\n`,
    );
  },
  processWatchdog(1),
);

test(
  "a test run that is not strict names the same entry as a warning and passes",
  async () => {
    const temp = folder("test-run-temp-");
    const leftover = join(temp, "planted-fixed-path");
    const root = specimen({ "tests/fixed.test.ts": hardCoded(leftover) });
    const run = await runIn(root, temp, false);
    expect(run.exit).toBe(0);
    expect(run.text).toContain(`Warning (another program on this machine`);
    expect(run.text).toContain(`\n  ${leftover}\n`);
  },
  processWatchdog(1),
);

test(
  "through its entry under CI, the test run fails naming a fixed-path entry",
  async () => {
    const temp = folder("test-run-temp-");
    const leftover = join(temp, "planted-fixed-path");
    const root = specimen({ "tests/fixed.test.ts": hardCoded(leftover) });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: { ...outsideRun(temp), CI: "true" },
    });
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      `entry(ies) in the system temp folder, outside the test run folder:`,
    );
    expect(run.stderr).toContain(`\n  ${leftover}\n`);
  },
  processWatchdog(1),
);

const plainWarning =
  "Warning: bun test started without scripts/test-run.ts, so child processes can write outside a test run folder, into the system temp folder. bun run test is the guarded route.";

test(
  "under CI, a test script that runs plain bun test is refused by the preload, so bun run check fails",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({
      "package.json": JSON.stringify({ scripts: { test: "bun test" } }),
      "tests/passing.test.ts": passing,
    });
    const run = await spawnBounded([process.execPath, "run", "test"], {
      cwd: root,
      env: { ...outsideRun(temp), CI: "true" },
    });
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "\nerror: bun test started without scripts/test-run.ts in a package script under CI, so its tests and their children would write to the system temp folder.",
    );
    expect(readdirSync(temp)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "without CI, plain bun test warns once and runs its tests",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({ "tests/passing.test.ts": passing });
    const run = await spawnBounded([process.execPath, "test"], {
      cwd: root,
      env: outsideRun(temp),
    });
    expect(run.exit).toBe(0);
    expect(run.stderr.split(plainWarning).length - 1).toBe(1);
    expect(run.stderr).toContain(" 1 pass\n");
  },
  processWatchdog(1),
);

test(
  "under CI, plain bun test started outside a package script warns and runs its tests",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({ "tests/passing.test.ts": passing });
    const run = await spawnBounded([process.execPath, "test"], {
      cwd: root,
      env: { ...outsideRun(temp), CI: "true" },
    });
    expect(run.exit).toBe(0);
    expect(run.stderr).toContain(plainWarning);
    expect(run.stderr).toContain(" 1 pass\n");
  },
  processWatchdog(1),
);

test(
  "a test run whose bunfig.toml drops the preload fails naming the repair",
  async () => {
    const temp = folder("test-run-temp-");
    const root = specimen({
      "bunfig.toml": '[install]\nauto = "disable"\n',
      "tests/passing.test.ts": passing,
    });
    const run = await runIn(root, temp, true);
    expect(run).toEqual({
      exit: 1,
      text: 'bun test did not load tests/support/test-run-folder.ts, so nothing stopped a child process left at teardown. Repair: add preload = ["./tests/support/test-run-folder.ts"] under [test] in bunfig.toml.',
    });
  },
  processWatchdog(1),
);

test(
  "when the test run itself is killed, its bun test and their children stop within a second and its run folder is removed",
  async () => {
    const temp = folder("test-run-temp-");
    const ledger = join(folder("test-run-ledger-"), "ledger");
    const root = specimen({ "tests/hang.test.ts": hanging });
    const run = startChild([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: { ...outsideRun(temp), HANG_LEDGER: ledger },
      graceMilliseconds: 0,
    });
    const watch = watchLedger(ledger, "ready", runBound);
    try {
      await watch.reached;
    } finally {
      run.stop();
      watch.stop();
    }
    await run.finished;
    const pids = readFileSync(ledger, "utf8")
      .split("\n")
      .slice(0, 2)
      .map(Number);
    expect(pids.every((pid) => pid > 0)).toBe(true);
    const left = await gone(pids, 2_000);
    for (const pid of left) stopProcess(pid, true);
    expect(left).toEqual([]);
    expect(readdirSync(temp)).toEqual([]);
  },
  processWatchdog(1),
);

test("this run's own temp folder is a test run folder", () => {
  expect(process.env[testRunFolderVariable]).toBeString();
});

test("sleepsLeft refuses a non-zero ps exit instead of returning empty", () => {
  expect(() =>
    sleepsLeft(
      withPs(
        process.env,
        'echo "ps: operation not permitted (EPERM)" >&2\nexit 1',
      ),
    ),
  ).toThrow("ps -A exited 1");
});
