import { expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import {
  runTests,
  type TestRunEnvironment,
  testRunProcessMark,
  testRunProcessVariable,
} from "../../../scripts/test-run.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { processWatchdog, watchLedger } from "../../support/process.ts";
import {
  outsideTestRun,
  testRunSpecimen,
} from "../../support/test-run-fixture.ts";

const folder = ownedFolders();
const bound = 20_000;

const specimen = (tests: Readonly<Record<string, string>>) =>
  testRunSpecimen(folder, tests);

const runCase = (
  tests: Readonly<Record<string, string>>,
  env: TestRunEnvironment,
  leftover: readonly string[],
  strict: boolean,
  lines: string[] = [],
) =>
  runTests([], {
    cwd: specimen(tests),
    env,
    leftoverFolders: leftover,
    strict,
    report: (line) => lines.push(line),
    limitMilliseconds: bound,
  });

const startRun = (
  tests: Readonly<Record<string, string>>,
  temp: string,
  extra: TestRunEnvironment,
) =>
  startChild([process.execPath, "scripts/test-run.ts"], {
    cwd: specimen(tests),
    env: outsideTestRun(temp, extra),
    limitMilliseconds: bound,
    graceMilliseconds: 0,
  });

test(
  "under CI, two real concurrent runs pass and leave nothing behind",
  async () => {
    const concurrentTemp = folder("test-run-concurrent-");
    const ledger = join(folder("test-run-ledger-"), "real-overlap");
    const wait = (writeLine: string, waitFor: string) =>
      `import { test } from "bun:test";\nimport { appendFileSync, existsSync, readFileSync } from "node:fs";\ntest("o", async () => { const f = process.env.L; appendFileSync(f, ${JSON.stringify(`${writeLine}\n`)}); const t = Date.now(); await new Promise((r) => { const p = setInterval(() => { if (!(existsSync(f) ? readFileSync(f, "utf8") : "").split("\\n").includes(${JSON.stringify(waitFor)}) && Date.now() - t < 10_000) return; clearInterval(p); r(undefined); }, 10); }); }, 20_000);\n`;
    const first = startRun(
      { "tests/a.test.ts": wait("a-on", "b-on") },
      concurrentTemp,
      { CI: "true", L: ledger },
    );
    const watchA = watchLedger(ledger, "a-on", bound);
    let second: ReturnType<typeof startRun> | undefined;
    try {
      await watchA.reached;
      second = startRun(
        { "tests/b.test.ts": wait("b-on", "a-off") },
        concurrentTemp,
        { CI: "true", L: ledger },
      );
      const firstResult = await first.finished;
      writeFileSync(ledger, `${readFileSync(ledger, "utf8")}a-off\n`);
      const secondResult = await second.finished;
      expect(firstResult.stderr).toContain(" 1 pass\n");
      expect(secondResult.stderr).toContain(" 1 pass\n");
      expect(firstResult.stderr).not.toContain(concurrentTemp);
      expect(secondResult.stderr).not.toContain(concurrentTemp);
      expect(readdirSync(concurrentTemp)).toEqual([]);
    } finally {
      watchA.stop();
      writeFileSync(ledger, "b-on\na-off\n");
      first.stop();
      second?.stop();
      await Promise.allSettled([first.finished, second?.finished]);
    }
  },
  processWatchdog(2),
);

test(
  "when Bun.spawn fails to start bun test, runTests removes its run folder and marker",
  async () => {
    const temp = folder("test-run-temp-");
    const missing = join(folder("test-run-missing-"), "does-not-exist");
    let caught: unknown;
    try {
      await runTests([], {
        cwd: missing,
        env: outsideTestRun(temp),
        leftoverFolders: [temp],
        strict: true,
        report: () => {},
        limitMilliseconds: bound,
      });
    } catch (error) {
      caught = error;
    }
    expect(String(caught)).toMatch(/ENOENT|No such file/i);
    expect(readdirSync(temp)).toEqual([]);
  },
  processWatchdog(1),
);

test(
  "a strict run does not report a concurrent run folder seen before its process marker appears",
  async () => {
    const temp = folder("test-run-temp-");
    const ledger = join(folder("test-run-ledger-"), "startup-race");
    const racerScript = `import { appendFileSync, closeSync, constants, existsSync, mkdirSync, openSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
const dir = join(process.env.T, \`test-run-\${process.pid}-starting\`);
mkdirSync(dir);
appendFileSync(process.env.L, "created\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40);
const tmp = join(dir, ${JSON.stringify(`${testRunProcessMark}.tmp`)});
const fd = openSync(tmp, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
writeSync(fd, \`${testRunProcessVariable}=\${process.pid}\\n\`);
renameSync(tmp, join(dir, ${JSON.stringify(testRunProcessMark)}));
appendFileSync(process.env.L, "marked\\n");
await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (!existsSync(process.env.STOP)) return;
    clearInterval(poll);
    closeSync(fd);
    resolve(undefined);
  }, 10);
});`;
    const stopFile = join(folder("test-run-stop-"), "stop");
    const racer = startChild([process.execPath, "-e", racerScript], {
      env: outsideTestRun(temp, { T: temp, L: ledger, STOP: stopFile }),
      limitMilliseconds: bound,
      graceMilliseconds: 0,
    });
    const created = watchLedger(ledger, "created", bound);
    const lines: string[] = [];
    try {
      const run = runCase(
        {
          "tests/race.test.ts": `import { test } from "bun:test";\nimport { existsSync, readFileSync } from "node:fs";\ntest("waits for dir creation", async () => { const f = process.env.L; const t = Date.now(); await new Promise((r) => { const p = setInterval(() => { if (!(existsSync(f) ? readFileSync(f, "utf8") : "").includes("created") && Date.now() - t < 5_000) return; clearInterval(p); r(undefined); }, 5); }); });\n`,
        },
        outsideTestRun(temp, { L: ledger }),
        [temp],
        true,
        lines,
      );
      await created.reached;
      const result = await run;
      expect({ exitCode: result.exitCode, lines }).toEqual({
        exitCode: 0,
        lines: [],
      });
    } finally {
      created.stop();
      writeFileSync(stopFile, "1");
      racer.stop();
      await racer.finished;
    }
  },
  processWatchdog(1),
);

test(
  "a strict run does not report a markerless test-run-<pid>-x folder while that pid lives past 250 ms, and reports it once the pid exits",
  async () => {
    const temp = folder("test-run-temp-");
    const ledger = join(folder("test-run-ledger-"), "live-markerless");
    const stopFile = join(folder("test-run-stop-"), "stop");
    const holderScript = `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(process.env.L, "ready\\n");
await new Promise((resolve) => {
  const poll = setInterval(() => {
    if (!existsSync(process.env.STOP)) return;
    clearInterval(poll);
    resolve(undefined);
  }, 10);
});`;
    const holder = startChild([process.execPath, "-e", holderScript], {
      env: outsideTestRun(temp, { L: ledger, STOP: stopFile }),
      limitMilliseconds: bound,
      graceMilliseconds: 0,
    });
    const ready = watchLedger(ledger, "ready", bound);
    const liveDir = join(temp, `test-run-${holder.pid}-x`);
    const liveLines: string[] = [];
    try {
      await ready.reached;
      const liveResult = await runCase(
        {
          "tests/live-markerless.test.ts": `import { test } from "bun:test";\nimport { mkdirSync } from "node:fs";\ntest("makes markerless live pid dir", () => { mkdirSync(${JSON.stringify(liveDir)}); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300); });\n`,
        },
        outsideTestRun(temp),
        [temp],
        true,
        liveLines,
      );
      expect({ exitCode: liveResult.exitCode, lines: liveLines }).toEqual({
        exitCode: 0,
        lines: [],
      });
    } finally {
      ready.stop();
      writeFileSync(stopFile, "1");
      holder.stop();
      await holder.finished;
    }

    const deadTemp = folder("test-run-dead-markerless-");
    const deadDir = join(deadTemp, `test-run-${holder.pid}-x`);
    const deadLines: string[] = [];
    const deadResult = await runCase(
      {
        "tests/dead-markerless.test.ts": `import { test } from "bun:test";\nimport { mkdirSync } from "node:fs";\ntest("makes markerless dead pid dir", () => { mkdirSync(${JSON.stringify(deadDir)}); });\n`,
      },
      outsideTestRun(deadTemp),
      [deadTemp],
      true,
      deadLines,
    );
    expect(deadResult.exitCode).toBe(1);
    expect(deadLines.join("\n")).toContain(`\n  ${deadDir}\n`);
  },
  processWatchdog(1),
);
