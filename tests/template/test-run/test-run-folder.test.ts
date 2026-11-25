import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import {
  insideFolder,
  leftoverFolders,
  stopProcess,
  testRunFolderVariable,
} from "../../../scripts/test-run.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  processAlive,
  processWatchdog,
  spawnBounded,
  watchLedger,
} from "../../support/process.ts";
import {
  outsideTestRun,
  testRunSpecimen,
} from "../../support/test-run-fixture.ts";

const folder = ownedFolders();
const runBound = 20_000;
const testFolderSource = readFileSync(
  join(import.meta.dir, "../../support/test-folder.ts"),
  "utf8",
);

function specimen(tests: Readonly<Record<string, string>>): string {
  return testRunSpecimen(folder, {
    "tests/support/test-folder.ts": testFolderSource,
    ...tests,
  });
}

function waitUntilGone(
  pids: readonly number[],
  folderPath: string,
  bound: number,
): Promise<{ readonly alive: number[]; readonly entries: string[] }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const poll = setInterval(() => {
      const alive = pids.filter(processAlive);
      const entries = readdirSync(folderPath);
      if (
        (alive.length > 0 || entries.length > 0) &&
        Date.now() - started < bound
      )
        return;
      clearInterval(poll);
      resolve({ alive, entries });
    }, 20);
  });
}

function readRecord(path: string) {
  const [
    created = "",
    runFolder = "",
    stateDir = "",
    tmpDir = "",
    tmp = "",
    temp = "",
  ] = readFileSync(path, "utf8").split("\n");
  return { created, runFolder, stateDir, tmpDir, tmp, temp };
}

const recordTestFolder = `import { test } from "bun:test";
import { writeFileSync } from "node:fs";
import { testFolder } from "./support/test-folder.ts";
test("uses testFolder", () => {
  const created = testFolder("x-");
  writeFileSync(
    process.env.RECORD_FILE,
    [
      created,
      process.env.TEST_RUN_FOLDER ?? "",
      process.env.STATE_TEST_DIR ?? "",
      process.env.TMPDIR ?? "",
      process.env.TMP ?? "",
      process.env.TEMP ?? "",
    ].join("\\n"),
  );
});
`;

const hangAfterTestFolder = `import { test } from "bun:test";
import { appendFileSync } from "node:fs";
import { testFolder } from "./support/test-folder.ts";
test("hangs after testFolder", async () => {
  const created = testFolder("x-");
  const child = Bun.spawn(["sleep", "307"]);
  appendFileSync(
    process.env.HANG_LEDGER,
    \`\${process.pid}\\n\${child.pid}\\n\${created}\\nready\\n\`,
  );
  await new Promise(() => {});
}, 60_000);
`;

test("leftoverFolders includes STATE_TEST_DIR when set and non-empty", () => {
  const temp = folder("test-run-temp-");
  const stateDir = folder("test-run-state-");
  expect(leftoverFolders({ TMPDIR: temp, STATE_TEST_DIR: stateDir })).toContain(
    stateDir,
  );
  expect(leftoverFolders({ TMPDIR: temp, STATE_TEST_DIR: "" })).not.toContain(
    stateDir,
  );
  expect(
    leftoverFolders({
      TMPDIR: temp,
      STATE_TEST_DIR: stateDir,
      [testRunFolderVariable]: temp,
    }),
  ).toEqual([]);
});

test(
  "when STATE_TEST_DIR is set, testFolder lands inside the run folder under STATE_TEST_DIR and nothing is left after the run",
  async () => {
    const temp = folder("test-run-temp-");
    const stateDir = folder("test-run-state-");
    const recordFile = join(folder("test-run-record-"), "record.txt");
    const root = specimen({ "tests/state-folder.test.ts": recordTestFolder });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideTestRun(temp, {
        STATE_TEST_DIR: stateDir,
        RECORD_FILE: recordFile,
      }),
    });
    expect(run.exit).toBe(0);
    const recorded = readRecord(recordFile);
    expect(insideFolder(recorded.runFolder, stateDir)).toBe(true);
    expect(insideFolder(recorded.created, recorded.runFolder)).toBe(true);
    expect(recorded.stateDir).toBe(recorded.runFolder);
    expect(recorded.tmpDir).toBe(recorded.runFolder);
    expect(recorded.tmp).toBe(recorded.runFolder);
    expect(recorded.temp).toBe(recorded.runFolder);
    expect(readdirSync(stateDir)).toEqual([]);
    expect(readdirSync(temp)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "when STATE_TEST_DIR is empty, the run folder uses TMPDIR and leaves nothing behind",
  async () => {
    const temp = folder("test-run-temp-");
    const recordFile = join(folder("test-run-record-"), "record.txt");
    const root = specimen({ "tests/state-folder.test.ts": recordTestFolder });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideTestRun(temp, {
        STATE_TEST_DIR: "",
        RECORD_FILE: recordFile,
      }),
    });
    expect(run.exit).toBe(0);
    const recorded = readRecord(recordFile);
    expect(insideFolder(recorded.runFolder, temp)).toBe(true);
    expect(insideFolder(recorded.created, recorded.runFolder)).toBe(true);
    expect(readdirSync(temp)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "under CI with STATE_TEST_DIR set, a strict test run fails naming a fixed-path entry left in STATE_TEST_DIR",
  async () => {
    const temp = folder("test-run-temp-");
    const stateDir = folder("test-run-state-");
    const leftover = join(stateDir, "planted-state-leftover");
    const root = specimen({
      "tests/fixed.test.ts": `import { test } from "bun:test";\nimport { mkdirSync } from "node:fs";\ntest("writes in stateDir", () => { mkdirSync(${JSON.stringify(leftover)}); });\n`,
    });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideTestRun(temp, { STATE_TEST_DIR: stateDir, CI: "true" }),
    });
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(
      "entry(ies) in the system temp folder, outside the test run folder:",
    );
    expect(run.stderr).toContain(`\n  ${leftover}\n`);
  },
  processWatchdog(1),
);

test(
  "when the launcher is killed with SIGKILL mid-test with STATE_TEST_DIR set, the watchdog removes the run folder and leaves nothing in STATE_TEST_DIR",
  async () => {
    const temp = folder("test-run-temp-");
    const stateDir = folder("test-run-state-");
    const ledger = join(folder("test-run-ledger-"), "ledger");
    const root = specimen({
      "tests/hang-state.test.ts": hangAfterTestFolder,
    });
    const run = startChild([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideTestRun(temp, {
        STATE_TEST_DIR: stateDir,
        HANG_LEDGER: ledger,
      }),
      limitMilliseconds: runBound,
      graceMilliseconds: 0,
    });
    const watch = watchLedger(ledger, "ready", runBound);
    let pids: number[] = [];
    try {
      await watch.reached;
      run.stop();
      await run.finished;
      const lines = readFileSync(ledger, "utf8").split("\n");
      pids = lines.slice(0, 2).map(Number);
      const created = lines[2] ?? "";
      expect(pids.every((pid) => pid > 0)).toBe(true);
      expect(insideFolder(created, stateDir)).toBe(true);
      const after = await waitUntilGone(pids, stateDir, 2_000);
      expect(after.alive).toEqual([]);
      expect(after.entries).toEqual([]);
      expect(readdirSync(temp)).toEqual([]);
    } finally {
      run.stop();
      watch.stop();
      for (const pid of pids) if (pid > 0) stopProcess(pid, true);
    }
  },
  processWatchdog(1),
);

test(
  "a strict test run ignores Bun's own bun-node-<uid>-<build> folder, which Bun always makes in /tmp whatever TMPDIR says, and still names a lookalike",
  async () => {
    const temp = folder("test-run-temp-");
    const stateDir = folder("test-run-state-");
    const own = join(
      stateDir,
      `bun-node-${process.getuid?.()}-${Bun.revision.slice(0, 9)}`,
    );
    const lookalike = join(
      stateDir,
      `bun-node-${process.getuid?.()}-000000000`,
    );
    const root = specimen({
      "tests/bun-node.test.ts": `import { test } from "bun:test";\nimport { mkdirSync } from "node:fs";\ntest("makes both", () => { mkdirSync(${JSON.stringify(own)}); mkdirSync(${JSON.stringify(lookalike)}); });\n`,
    });
    const run = await spawnBounded([process.execPath, "scripts/test-run.ts"], {
      cwd: root,
      env: outsideTestRun(temp, { STATE_TEST_DIR: stateDir, CI: "true" }),
    });
    expect(run.exit).toBe(1);
    expect(run.stderr).toContain(`\n  ${lookalike}\n`);
    expect(run.stderr).not.toContain(`\n  ${own}\n`);
  },
  processWatchdog(1),
);
