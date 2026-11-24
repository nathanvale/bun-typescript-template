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

const runFolder = real(process.env[testRunFolderVariable]);
const temp = real(process.env.TMPDIR);
const testRunProcess = Number(process.env[testRunProcessVariable]);
if (
  !Number.isInteger(testRunProcess) ||
  testRunProcess <= 0 ||
  runFolder === undefined ||
  temp === undefined ||
  !insideFolder(temp, runFolder)
)
  throw new Error(
    "bun test started without scripts/test-run.ts, so its tests and their children would write to the system temp folder. Repair: start tests with bun run test, and pass test paths and bun test options after it.",
  );
writeFileSync(join(runFolder, teardownMark), "");

setInterval(() => {
  try {
    process.kill(testRunProcess, 0);
  } catch {
    rmSync(runFolder, { recursive: true, force: true });
    process.kill(0, "SIGKILL");
  }
}, 500).unref();

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

afterAll(() => {
  const left = childrenLeft();
  for (const row of left)
    if (row.group === 0) stopProcess(row.pid, false);
    else stopProcess(row.group, true);
  if (left.length > 0)
    throw new Error(
      `Tests left ${left.length} child process(es) running at teardown, and they were stopped:\n${left.map((row) => row.text).join("\n")}\nRepair: end each child a test starts before the test ends: await its exit, or stop it in finally.`,
    );
});
