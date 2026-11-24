import { afterAll } from "bun:test";
import { realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  commandOf,
  insideFolder,
  processRows,
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

function guard(runFolder: string, testRunProcess: number): void {
  writeFileSync(join(runFolder, teardownMark), "");
  setInterval(() => {
    try {
      process.kill(testRunProcess, 0);
    } catch {
      rmSync(runFolder, { recursive: true, force: true });
      process.kill(0, "SIGKILL");
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

function childrenLeft(): { pid: number; group: number; text: string }[] {
  const rows = processRows();
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
      text: `  ${row.text}: ${commandOf(row.pid) || "(exited)"}`,
    }));
}

function stopChildrenLeft(): void {
  const left = childrenLeft();
  for (const row of left)
    if (row.group === 0) stopProcess(row.pid, false);
    else stopProcess(row.group, true);
  if (left.length > 0)
    throw new Error(
      `Tests left ${left.length} child process(es) running at teardown, and they were stopped:\n${left.map((row) => row.text).join("\n")}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
    );
}
