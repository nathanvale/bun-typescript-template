import { afterAll } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  insideFolder,
  stopProcess,
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

function runnerGone(testRunProcess: number): boolean {
  if (process.ppid !== testRunProcess) return true;
  try {
    process.kill(testRunProcess, 0);
    return false;
  } catch (error) {
    return Reflect.get(Object(error), "code") !== "EPERM";
  }
}

function guard(runFolder: string, testRunProcess: number): void {
  writeFileSync(join(runFolder, teardownMark), "");
  const removeRunFolder = () =>
    tryIgnore(() => rmSync(runFolder, { recursive: true, force: true }));
  const removeIfRunnerGone = () => {
    if (runnerGone(testRunProcess)) removeRunFolder();
  };
  afterAll(removeIfRunnerGone);
  process.on("exit", removeIfRunnerGone);
  setInterval(() => {
    if (!runnerGone(testRunProcess)) return;
    removeRunFolder();
    stopProcess(0, false, "SIGKILL");
  }, 500).unref();
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
