import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative } from "node:path";

export type TestRunEnvironment = Readonly<Record<string, string | undefined>>;

export const testRunFolderVariable = "TEST_RUN_FOLDER";
export const testRunProcessVariable = "TEST_RUN_PID";
export const teardownMark = ".test-run-teardown";
export const testRunProcessMark = ".test-run-process";

const bareTempMilliseconds = 10_000;
const signalGraceMilliseconds = 2_000;
const runFolderPrefix = "test-run-";
const missingCodes = new Set<unknown>(["ENOENT", "ENOTDIR"]);
const stoppedCodes = new Set<unknown>(["ESRCH", "EPERM"]);
const liveMarkPattern = new RegExp(
  `^${testRunProcessVariable}=([1-9]\\d*)\\n$`,
);
const markFlags =
  constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

export function insideFolder(path: string, folder: string): boolean {
  const way = relative(folder, path);
  return way === "" || (!way.startsWith("..") && !isAbsolute(way));
}

export function stopProcess(
  pid: number,
  group: boolean,
  signal: NodeJS.Signals = "SIGKILL",
): void {
  try {
    process.kill(group ? -pid : pid, signal);
  } catch (error) {
    if (!stoppedCodes.has(Reflect.get(Object(error), "code"))) throw error;
  }
}

function namesIn(folder: string): Set<string> {
  try {
    return new Set(readdirSync(folder));
  } catch (error) {
    if (missingCodes.has(Reflect.get(Object(error), "code"))) return new Set();
    throw error;
  }
}

function realFolder(path: string): string {
  return realpathSync.native(path);
}

function bareTemp(bun: string = process.execPath): string {
  const child = Bun.spawnSync(
    [bun, "-e", "process.stdout.write(require('node:os').tmpdir())"],
    {
      env: {},
      stdout: "pipe",
      stderr: "pipe",
      timeout: bareTempMilliseconds,
      killSignal: "SIGKILL",
    },
  );
  if (child.exitedDueToTimeout || child.exitCode !== 0) {
    const why = child.exitedDueToTimeout
      ? `timed out after ${bareTempMilliseconds} ms`
      : `exited ${String(child.exitCode)}: ${child.stderr.toString().trim() || "(no output)"}`;
    throw new Error(
      `Reading the bare system temp folder with ${bun} ${why}. Repair: check that Bun starts cleanly, then run the tests again.`,
    );
  }
  return child.stdout.toString();
}

export function leftoverFolders(
  env: TestRunEnvironment,
  bun: string = process.execPath,
): string[] {
  if (env[testRunFolderVariable] !== undefined) return [];
  const folders = [env.STATE_TEST_DIR, env.TMPDIR || tmpdir(), bareTemp(bun)]
    .filter(
      (folder): folder is string =>
        folder !== undefined && folder !== "" && existsSync(folder),
    )
    .map(realFolder);
  return [...new Set(folders)];
}

export type TestRunOptions = {
  readonly cwd: string;
  readonly env: TestRunEnvironment;
  readonly leftoverFolders: readonly string[];
  readonly strict: boolean;
  readonly report: (line: string) => void;
  readonly limitMilliseconds?: number;
};

function readProcessMark(folder: string): number | undefined {
  let fd: number;
  try {
    fd = openSync(join(folder, testRunProcessMark), markFlags);
  } catch {
    return undefined;
  }
  try {
    if (!fstatSync(fd).isFile()) return undefined;
    const buffer = new Uint8Array(64);
    const bytes = readSync(fd, buffer, 0, 64, 0);
    const text = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(buffer.subarray(0, bytes));
    const pid = Number(liveMarkPattern.exec(text)?.[1]);
    return Number.isSafeInteger(pid) ? pid : undefined;
  } catch {
    return undefined;
  } finally {
    closeSync(fd);
  }
}

function isLiveRunFolder(path: string): boolean {
  try {
    if (!lstatSync(path).isDirectory()) return false;
  } catch (error) {
    return missingCodes.has(Reflect.get(Object(error), "code"));
  }
  const pid = readProcessMark(path);
  if (pid === undefined) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Reflect.get(Object(error), "code") === "EPERM";
  }
}

const bunNodeFolder = `bun-node-${process.getuid?.()}-${Bun.revision.slice(0, 9)}`;

function isBunOwnFolder(
  folder: string,
  name: string,
  stateFolder: string | undefined,
): boolean {
  if (name !== bunNodeFolder || folder === stateFolder) return false;
  try {
    return lstatSync(join(folder, name)).isDirectory();
  } catch {
    return false;
  }
}

function leftoversOf(
  folders: readonly string[],
  before: ReadonlyMap<string, Set<string>>,
  runFolder: string,
  stateFolder: string | undefined,
): string[] {
  return folders.flatMap((folder) =>
    [...namesIn(folder)]
      .filter(
        (name) =>
          !isBunOwnFolder(folder, name, stateFolder) &&
          !before.get(folder)?.has(name),
      )
      .map((name) => join(folder, name))
      .filter((path) => path !== runFolder && !isLiveRunFolder(path)),
  );
}

export type TestRunResult = {
  readonly exitCode: number;
  readonly signalCode: NodeJS.Signals | null;
};

function startBunTest(
  args: readonly string[],
  options: TestRunOptions,
  runFolder: string,
) {
  return Bun.spawn([process.execPath, "test", ...args], {
    cwd: options.cwd,
    env: {
      ...options.env,
      STATE_TEST_DIR: runFolder,
      TMP: runFolder,
      TEMP: runFolder,
      TMPDIR: runFolder,
      [testRunFolderVariable]: runFolder,
      [testRunProcessVariable]: String(process.pid),
    },
    stdio: ["inherit", "inherit", "inherit"],
    detached: true,
  });
}

async function finished(
  child: ReturnType<typeof startBunTest>,
  options: TestRunOptions,
): Promise<number> {
  const killGroup = () => stopProcess(child.pid, true, "SIGKILL");
  let escalation: ReturnType<typeof setTimeout> | undefined;
  let forwarded = false;
  const forward = (signal: NodeJS.Signals) => {
    if (forwarded) {
      clearTimeout(escalation);
      killGroup();
      return;
    }
    forwarded = true;
    stopProcess(child.pid, true, signal);
    escalation = setTimeout(killGroup, signalGraceMilliseconds);
  };
  const limit =
    options.limitMilliseconds === undefined
      ? undefined
      : setTimeout(killGroup, options.limitMilliseconds);
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
  for (const signal of signals) process.on(signal, forward);
  try {
    return await child.exited;
  } finally {
    clearTimeout(limit);
    clearTimeout(escalation);
    for (const signal of signals) process.off(signal, forward);
  }
}

function leftoverProblems(
  leftovers: readonly string[],
  options: TestRunOptions,
): string[] {
  if (leftovers.length === 0) return [];
  const message = `Tests left ${leftovers.length} entry(ies) in the system temp folder, outside the test run folder:\n${leftovers.map((path) => `  ${path}`).join("\n")}\nRepair: make temporary files under os.tmpdir() (testFolder in tests/support/test-folder.ts) and pass process.env to each child, so they land in the test run folder; write no fixed temp path. Then remove the entries above.`;
  if (options.strict) return [message];
  options.report(
    `Warning (another program on this machine may have made these): ${message}`,
  );
  return [];
}

function testRunResult(
  code: number,
  rawSignal: NodeJS.Signals | number | null,
  problemCount: number,
): TestRunResult {
  const signalCode = typeof rawSignal === "string" ? rawSignal : null;
  if (code !== 0 || signalCode !== null) return { exitCode: code, signalCode };
  return { exitCode: problemCount > 0 ? 1 : 0, signalCode };
}

export async function runTests(
  args: readonly string[],
  options: TestRunOptions,
): Promise<TestRunResult> {
  const before = new Map(
    options.leftoverFolders.map((folder) => [folder, namesIn(folder)]),
  );
  const parent = realFolder(
    options.env.STATE_TEST_DIR || options.env.TMPDIR || tmpdir(),
  );
  const runFolder = realFolder(mkdtempSync(join(parent, runFolderPrefix)));
  writeFileSync(
    join(runFolder, testRunProcessMark),
    `${testRunProcessVariable}=${process.pid}\n`,
  );
  const child = startBunTest(args, options, runFolder);
  const problems: string[] = [];
  let code: number;
  let marked: boolean;
  try {
    code = await finished(child, options);
  } finally {
    stopProcess(child.pid, true);
    marked = existsSync(join(runFolder, teardownMark));
    rmSync(runFolder, { recursive: true, force: true });
  }
  if (code === 0 && !marked)
    problems.push(
      `bun test did not load tests/support/test-run-folder.ts, so plain bun test is unguarded and a killed test run would leave its folder behind. Repair: add preload = ["./tests/support/test-run-folder.ts"] under [test] in bunfig.toml.`,
    );
  problems.push(
    ...leftoverProblems(
      leftoversOf(
        options.leftoverFolders,
        before,
        runFolder,
        options.env.STATE_TEST_DIR
          ? realFolder(options.env.STATE_TEST_DIR)
          : undefined,
      ),
      options,
    ),
  );
  for (const problem of problems) options.report(problem);
  return testRunResult(code, child.signalCode, problems.length);
}

if (import.meta.main) {
  const result = await runTests(process.argv.slice(2), {
    cwd: process.cwd(),
    env: process.env,
    leftoverFolders: leftoverFolders(process.env),
    strict: process.env.CI === "true",
    report: (line) => process.stderr.write(`${line}\n`),
  });
  if (result.signalCode !== null) process.kill(process.pid, result.signalCode);
  process.exitCode = result.exitCode;
}
