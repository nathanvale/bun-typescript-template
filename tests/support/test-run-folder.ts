import { afterAll } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commandOf,
  insideFolder,
  type ProcessRow,
  processRows,
  reportProcessRows,
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
  afterAll(() => stopChildrenLeft(runFolder));
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

function descendantsOf(
  rows: readonly ProcessRow[],
): { pid: number; group: number; row: ProcessRow }[] {
  const own = rows.find((row) => row.pid === process.pid)?.group;
  const family = new Set([process.pid]);
  for (let grew = true; grew; ) {
    grew = false;
    for (const row of rows)
      if (!family.has(row.pid) && family.has(row.parentPid)) {
        family.add(row.pid);
        grew = true;
      }
  }
  return rows
    .filter((row) => row.pid !== process.pid && family.has(row.pid))
    .map((row) => ({
      pid: row.pid,
      group: row.group === own ? 0 : row.group,
      row,
    }));
}

function stopChildGroups(): void {
  const listed = processRows();
  if (!listed.ok) return;
  for (const child of descendantsOf(listed.rows))
    tryIgnore(() =>
      child.group === 0
        ? stopProcess(child.pid, false)
        : stopProcess(child.group, true),
    );
}

function stopChildrenLeft(folder: string): void {
  const listed = processRows();
  if (!listed.ok) {
    if (process.env.CI === "true") throw new Error(listed.message);
    reportProcessRows(folder, listed.message, (line) =>
      process.stderr.write(`${line}\n`),
    );
    return;
  }
  const left = descendantsOf(listed.rows).map(({ pid, group, row }) => ({
    pid,
    group,
    text: `  ${row.text}: ${commandOf(row.pid) || "(exited)"}`,
  }));
  for (const row of left)
    if (row.group === 0) stopProcess(row.pid, false);
    else stopProcess(row.group, true);
  if (left.length > 0)
    throw new Error(
      `Tests left ${left.length} child process(es) running at teardown, and they were stopped:\n${left.map((row) => row.text).join("\n")}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
    );
}
