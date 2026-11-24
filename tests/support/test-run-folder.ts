import { afterAll } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  childProcessRows,
  commandOf,
  processRows,
  stopProcess,
} from "../../scripts/test-run-process.ts";
import {
  insideFolder,
  teardownMark,
  testRunFolderVariable,
  testRunProcessVariable,
} from "../../scripts/test-run.ts";

function real(path: string | undefined): string | undefined {
  try {
    return path === undefined ? undefined : realpathSync.native(path);
  } catch {
    return undefined;
  }
}

function tryIgnore(step: () => void): void {
  try {
    step();
  } catch (error) {
    void error;
  }
}

function guard(runFolder: string, testRunProcess: number): void {
  writeFileSync(join(runFolder, teardownMark), "");
  setInterval(() => {
    try {
      process.kill(testRunProcess, 0);
    } catch {
      tryIgnore(stopChildGroups);
      tryIgnore(() => rmSync(runFolder, { recursive: true, force: true }));
      stopProcess(0, false, "SIGKILL");
    }
  }, 500).unref();
  afterAll(stopChildrenLeft);
}

const runFolder = real(process.env[testRunFolderVariable]);
const temp = real(process.env.TMPDIR);
const testRunProcess = Number(process.env[testRunProcessVariable]);
const inPackageScriptUnderCi =
  process.env.CI === "true" && process.env.npm_lifecycle_event !== undefined;
if (
  Number.isInteger(testRunProcess) &&
  testRunProcess > 0 &&
  runFolder !== undefined &&
  temp !== undefined &&
  insideFolder(temp, runFolder)
)
  guard(runFolder, testRunProcess);
else if (inPackageScriptUnderCi)
  throw new Error(
    "bun test started without scripts/test-run.ts in a package script under CI, so its tests and their children would write to the system temp folder. Repair: make the test script bun scripts/test-run.ts, and pass test paths and bun test options after it.",
  );
else
  process.stderr.write(
    "Warning: bun test started without scripts/test-run.ts, so child processes can write outside a test run folder, into the system temp folder. bun run test is the guarded route.\n",
  );

function stopChildGroups(): void {
  for (const child of childProcessRows(processRows()))
    tryIgnore(() =>
      stopProcess(
        child.group === 0 ? child.pid : child.group,
        child.group !== 0,
      ),
    );
}

function stopChildrenLeft(): void {
  const left = childProcessRows(processRows()).map(({ pid, group, row }) => ({
    pid,
    group,
    text: `  ${row.text}: ${commandOf(row.pid) || "(exited)"}`,
  }));
  for (const row of left)
    stopProcess(row.group === 0 ? row.pid : row.group, row.group !== 0);
  if (left.length > 0)
    throw new Error(
      `Tests left ${left.length} child process(es) running at teardown, and they were stopped:\n${left.map((row) => row.text).join("\n")}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
    );
}
