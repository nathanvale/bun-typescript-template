import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import {
  insideFolder,
  leftoverFolders,
  runTests,
  stopProcess,
  testRunFolderVariable,
} from "../../../scripts/test-run.ts";
import {
  ownedFolders,
  testRunFiles,
  write,
} from "../../support/fixture-files.ts";
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

async function runIn(
  root: string,
  temp: string,
  strict: boolean,
  args: readonly string[] = [],
) {
  const lines: string[] = [];
  const { exitCode: exit } = await runTests(args, {
    cwd: root,
    env: outsideRun(temp),
    leftoverFolders: [temp],
    strict,
    report: (line) => lines.push(line),
    limitMilliseconds: runBound,
  });
  return { exit, text: lines.join("\n") };
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
      text: 'bun test did not load tests/support/test-run-folder.ts, so plain bun test is unguarded and a killed test run would leave its folder behind. Repair: add preload = ["./tests/support/test-run-folder.ts"] under [test] in bunfig.toml.',
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
