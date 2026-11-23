import { afterAll, afterEach, expect } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readdirSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { write } from "./fixture-files.ts";
import {
  commit,
  gitEnv,
  gitOutput,
  inherited,
  initRepository,
  worktrees,
} from "./git-fixture.ts";
import { type SignalAt, spawnBounded } from "./process.ts";
import { testFolder } from "./test-folder.ts";

const repository = join(import.meta.dir, "../..");
const bound = 15_000;
const processGroupProbeBound = 4_000;
export const timeout = 20_000;
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };

const unguarded = `export function limit(value: number): number {
  return value;
}
`;
export const guarded = `export function limit(value: number): number {
  if (Number.isNaN(value)) throw new TypeError("limit must be a number");
  return value;
}
`;
export const refusalTest = `expect(() => limit(Number.NaN)).toThrow("limit must be a number")`;
export const tests = (
  refusal: string,
) => `import { expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { limit } from "../src/limit.ts";

appendFileSync(
  process.env.FAULTS_PIDS ?? "/dev/null",
  \`\${process.pid} \${process.ppid}\\n\`,
);

test("L.refuses NaN", () => {
  ${refusal};
});
test("L.weak keeps a number", () => {
  expect(limit(1)).toBe(1);
});
test("L.red is red without the fault", () => {
  expect(limit(1)).toBe(2);
});
test("L.tools sees only the tools its own tree installs", () => {
  expect(Bun.which("fault-replay-caller-tool")).toBeNull();
});
test("L.dies by a signal nobody sent the run", () => {
  process.kill(process.pid, "SIGKILL");
});
test("L.blocks until stopped", async () => {
  appendFileSync(process.env.FAULTS_LEDGER ?? "", "started\\n");
  await new Promise(() => undefined);
}, 60_000);
test("L.traps SIGTERM and blocks", async () => {
  process.on("SIGTERM", () => {
    appendFileSync(process.env.FAULTS_LEDGER ?? "", "trapped\\n");
  });
  appendFileSync(process.env.FAULTS_LEDGER ?? "", "started\\n");
  await new Promise(() => undefined);
}, 60_000);
`;

export function ledgered(ledger: string): { pid: number; parent: number }[] {
  if (!existsSync(ledger)) return [];
  return readFileSync(ledger, "utf8")
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [pid = Number.NaN, parent = Number.NaN] = line
        .split(" ")
        .map(Number);
      return { pid, parent };
    });
}

function running(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (Reflect.get(Object(error), "code") === "ESRCH") return false;
    throw error;
  }
}

export function exited(
  pid: number,
  boundMilliseconds = 5_000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const gone = !running(pid);
      if (!gone && Date.now() - started < boundMilliseconds) return;
      clearInterval(poll);
      resolve(gone);
    }, 5);
  });
}

async function release(ledger: string): Promise<void> {
  for (const { pid } of ledgered(ledger)) {
    const probe = Bun.spawnSync(["ps", "-o", "pgid=", "-p", String(pid)], {
      timeout: processGroupProbeBound,
      killSignal: "SIGKILL",
    });
    if (probe.exitedDueToTimeout)
      throw new Error(
        `ps did not find the process group for ${pid} within ${processGroupProbeBound} ms.`,
      );
    const group = probe.stdout.toString().trim();
    if (group !== String(pid)) continue;
    try {
      process.kill(-pid, "SIGKILL");
    } catch (error) {
      if (Reflect.get(Object(error), "code") !== "ESRCH") throw error;
    }
    await exited(pid);
  }
}

function releaseWorktrees(root: string): void {
  for (const tree of worktrees(root))
    if (tree !== root) gitOutput(root, "worktree", "remove", "--force", tree);
}

function fixtureEnv(): Record<string, string | undefined> {
  return { ...inherited(), ...gitEnv };
}

export function addFault(
  root: string,
  fix: string,
  sourcePath: string,
  testFile = "tests/limit.test.ts",
  title = "^L\\.refuses ",
) {
  return spawnBounded(
    [
      process.execPath,
      "run",
      "--silent",
      "planted-fault:add",
      fix,
      sourcePath,
      testFile,
      title,
    ],
    {
      cwd: root,
      env: fixtureEnv(),
      boundMilliseconds: bound,
      processGroup: true,
    },
  );
}

type FaultRecord = {
  id: string;
  patch: string;
  testFile: string;
  title: string;
  source: string;
};

function records(root: string): FaultRecord[] {
  return JSON.parse(
    readFileSync(join(root, "tests/planted-faults/fault-records.json"), "utf8"),
  ) as FaultRecord[];
}

export function verdicts(lines: readonly string[]): string[] {
  return lines.flatMap((line) =>
    /^(KILLED|SURVIVED|STALE|BROKEN|TIMEOUT) /.test(line)
      ? [line.split(" ", 2).join(" ")]
      : [],
  );
}

export function lineOf(lines: readonly string[], start: string): string {
  const line = lines.find((each) => each.startsWith(start));
  if (line === undefined) throw new Error(`No line starts with ${start}.`);
  return line;
}

export function expectOneTestProcessGone(pids: string): void {
  const [only, ...more] = ledgered(pids);
  expect(more).toEqual([]);
  if (only === undefined) throw new Error("No test process was ledgered.");
  expect(running(only.pid)).toBe(false);
}

export function expectNoLeftovers(root: string, temporary: string): void {
  expect(worktrees(root)).toEqual([root]);
  expect(readdirSync(temporary)).toEqual([]);
}

export function createPlantedFaultFixture() {
  const folders: string[] = [];
  const pidLedgers: string[] = [];

  async function dispose(): Promise<void> {
    for (const ledger of pidLedgers) await release(ledger);
    pidLedgers.length = 0;
    for (const folder of folders)
      rmSync(folder, { recursive: true, force: true });
    folders.length = 0;
  }

  afterEach(dispose);
  afterAll(dispose);

  function folder(prefix: string): string {
    const path = testFolder(prefix);
    folders.push(path);
    return path;
  }

  function pidLedger(): string {
    const path = join(folder("fault-replay-pids-"), "pids");
    pidLedgers.push(path);
    return path;
  }

  async function faultReplay(
    root: string,
    args: readonly string[] = [],
    {
      signalAt,
      env = {},
      launcher = [],
      boundMilliseconds = bound,
      pids = pidLedger(),
    }: {
      signalAt?: SignalAt;
      env?: Readonly<Record<string, string>>;
      launcher?: readonly string[];
      boundMilliseconds?: number;
      pids?: string;
    } = {},
  ) {
    const temporary = folder("fault-replay-tmp-");
    try {
      const run = await spawnBounded(
        [
          ...launcher,
          process.execPath,
          "run",
          "--silent",
          "fault-replay",
          ...args,
        ],
        {
          cwd: root,
          env: {
            ...fixtureEnv(),
            TMPDIR: temporary,
            FAULTS_PIDS: pids,
            ...env,
          },
          boundMilliseconds,
          processGroup: true,
          signalAt,
        },
      );
      return { ...run, temporary, pids, lines: run.stdout.split("\n") };
    } catch (error) {
      await release(pids);
      releaseWorktrees(root);
      throw error;
    }
  }

  async function repositoryWithFault(
    siblingTitlesById: Readonly<{ [id: string]: string }>,
  ) {
    const root = join(folder("fault-replay-repo-"), "repo");
    initRepository(root);
    commit(root, "base", {
      "package.json": JSON.stringify({
        name: "fixture",
        private: true,
        scripts: {
          "fault-replay": production["fault-replay"],
          "planted-fault:add": production["planted-fault:add"],
        },
      }),
      ".gitignore": "node_modules/\n",
      "scripts/planted-faults.ts": readFileSync(
        join(repository, "scripts/planted-faults.ts"),
        "utf8",
      ),
      "scripts/planted-fault-patch.ts": readFileSync(
        join(repository, "scripts/planted-fault-patch.ts"),
        "utf8",
      ),
      "scripts/planted-fault-verdict.ts": readFileSync(
        join(repository, "scripts/planted-fault-verdict.ts"),
        "utf8",
      ),
      "scripts/process-runner.ts": readFileSync(
        join(repository, "scripts/process-runner.ts"),
        "utf8",
      ),
      "src/limit.ts": unguarded,
    });
    const fix = commit(root, "fix: refuse a NaN limit", {
      "src/limit.ts": guarded,
      "tests/limit.test.ts": tests(refusalTest),
    });
    const added = await addFault(root, fix, "src/limit.ts");
    expect(added.stdout).toBe(
      `Added ${fix}-limit. Replay it: bun run fault-replay ${fix}-limit\n`,
    );
    const [killed] = records(root);
    if (killed === undefined)
      throw new Error("planted-fault:add wrote no record.");
    const siblings = Object.entries(siblingTitlesById).map(([id, title]) => ({
      ...killed,
      id,
      title,
    }));
    write(
      root,
      "tests/planted-faults/fault-records.json",
      `${JSON.stringify([killed, ...siblings], null, 2)}\n`,
    );
    gitOutput(root, "add", "--", "tests/planted-faults");
    gitOutput(root, "commit", "--quiet", "-m", "record the faults");
    return { root, fix, id: `${fix}-limit`, killed };
  }

  function hangLedger() {
    const ledger = join(folder("fault-replay-hang-"), "ledger");
    appendFileSync(ledger, "");
    return { ledger, lines: () => readFileSync(ledger, "utf8").split("\n") };
  }

  return { faultReplay, folder, hangLedger, pidLedger, repositoryWithFault };
}
