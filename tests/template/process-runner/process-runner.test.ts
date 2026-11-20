import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
  type Child,
  type Finished,
  startChild,
} from "../../../scripts/process-runner.ts";
import { spawnBounded, watchLedger } from "../../support/process.ts";
import { signalGroupIfPresent } from "../../support/signal.ts";
import { testFolder } from "../../support/test-folder.ts";

const testTimeout = 30_000;
const reapBound = 10_000;
const ledgerBound = 10_000;
const finishBound = 10_000;

async function finishedWithin(child: Child): Promise<Finished> {
  let bound: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      child.finished,
      new Promise<never>((_, reject) => {
        bound = setTimeout(
          () =>
            reject(
              new Error(`The child did not finish within ${finishBound} ms.`),
            ),
          finishBound,
        );
      }),
    ]);
  } finally {
    clearTimeout(bound);
  }
}

async function released(
  start: (root: string) => Child,
  check: (child: Child, root: string) => Promise<void>,
): Promise<void> {
  const root = testFolder("process-runner-");
  try {
    const child = start(root);
    try {
      await check(child, root);
    } finally {
      signalGroupIfPresent(child.pid, "SIGKILL");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
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

// Platform: an orphan is reaped by init or launchd, not by this process, so
// it can answer signal 0 for a while after it was killed.
function exited(pid: number): Promise<boolean> {
  return new Promise((resolve) => {
    const started = Date.now();
    const poll = setInterval(() => {
      const gone = !running(pid);
      if (!gone && Date.now() - started < reapBound) return;
      clearInterval(poll);
      resolve(gone);
    }, 5);
  });
}

test(
  "CE.a a child that hangs past its limit is stopped with its whole group and reported timed out",
  async () => {
    const limitMilliseconds = 5_000;
    const graceMilliseconds = 10_000;
    const lateness = 4_000;
    const started = Date.now();
    await released(
      (root) =>
        startChild(
          ["sh", "-c", `sleep 300 & echo $! > '${join(root, "pids")}'; wait`],
          { limitMilliseconds, graceMilliseconds },
        ),
      async (child, root) => {
        const run = await finishedWithin(child);
        const took = Date.now() - started;
        expect(took).toBeGreaterThanOrEqual(limitMilliseconds);
        expect(took).toBeLessThan(limitMilliseconds + lateness);
        expect(run.timedOut).toBe(true);
        expect(run.signalCode).toBe("SIGTERM");
        const grandchild = Number(readFileSync(join(root, "pids"), "utf8"));
        expect(await exited(grandchild)).toBe(true);
      },
    );
  },
  testTimeout,
);

test(
  "CE.b a stop that the child ignores escalates to SIGKILL for the whole group after the grace",
  async () => {
    const graceMilliseconds = 1_000;
    // Platform: a timer counts from the event loop's cached clock, which can
    // trail Date.now() by a few milliseconds, and Date.now() rounds to whole
    // milliseconds. A SIGKILL sent at once ends the run in a few milliseconds.
    const clockSlack = 100;
    await released(
      (root) =>
        startChild(
          [
            "sh",
            "-c",
            `trap '' TERM; sleep 300 & echo $! > '${join(root, "pids")}'; echo started >> '${join(root, "ledger")}'; wait`,
          ],
          { graceMilliseconds },
        ),
      async (child, root) => {
        await watchLedger(join(root, "ledger"), "started", ledgerBound).reached;
        const stopped = Date.now();
        child.stop();
        const run = await finishedWithin(child);
        expect(Date.now() - stopped).toBeGreaterThanOrEqual(
          graceMilliseconds - clockSlack,
        );
        expect(run.timedOut).toBe(false);
        expect(run.signalCode).toBe("SIGKILL");
        const grandchild = Number(readFileSync(join(root, "pids"), "utf8"));
        expect(await exited(grandchild)).toBe(true);
      },
    );
  },
  testTimeout,
);

test(
  "CE.c a child that finishes inside its limit reports both streams and its exit code",
  async () => {
    await released(
      () =>
        startChild(["sh", "-c", "echo out; echo err >&2; exit 3"], {
          limitMilliseconds: 20_000,
        }),
      async (child) => {
        expect(await child.finished).toEqual({
          stdout: "out\n",
          stderr: "err\n",
          exitCode: 3,
          signalCode: null,
          timedOut: false,
        });
      },
    );
  },
  testTimeout,
);

test(
  "CE.e a child started with the default environment finds its repository from its own folder, not from the git location a hook exports",
  async () => {
    const runner = join(import.meta.dir, "../../../scripts/process-runner.ts");
    const hook = {
      GIT_DIR: "caller/.git",
      GIT_WORK_TREE: "caller",
      GIT_INDEX_FILE: "caller/.git/index",
      GIT_OBJECT_DIRECTORY: "caller/.git/objects",
      GIT_ALTERNATE_OBJECT_DIRECTORIES: "caller/.git/alternates",
      GIT_COMMON_DIR: "caller/.git",
    };
    const shown = [...Object.keys(hook), "CE_CALLER"];
    const report = `process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([name]) => ${JSON.stringify(shown)}.includes(name)))))`;
    const caller = `import { startChild } from ${JSON.stringify(runner)};
const child = await startChild([process.execPath, "-e", ${JSON.stringify(report)}], { limitMilliseconds: ${finishBound} }).finished;
process.stdout.write(child.stdout + child.stderr);`;

    const run = await spawnBounded([process.execPath, "-e", caller], {
      env: { ...process.env, ...hook, CE_CALLER: "kept" },
    });

    expect(run).toEqual({
      stdout: JSON.stringify({ CE_CALLER: "kept" }),
      stderr: "",
      exit: 0,
    });
  },
  testTimeout,
);

test(
  "CE.d a stop with a grace of zero sends SIGKILL to the whole group at once, so a child that ignores SIGTERM still dies",
  async () => {
    await released(
      (root) =>
        startChild(
          [
            "sh",
            "-c",
            `trap '' TERM; sleep 300 & echo $! > '${join(root, "pids")}'; echo started >> '${join(root, "ledger")}'; wait`,
          ],
          { graceMilliseconds: 0 },
        ),
      async (child, root) => {
        await watchLedger(join(root, "ledger"), "started", ledgerBound).reached;
        child.stop();
        const grandchild = Number(readFileSync(join(root, "pids"), "utf8"));
        expect(await exited(grandchild)).toBe(true);
        const run = await finishedWithin(child);
        expect(run.timedOut).toBe(false);
        expect(run.signalCode).toBe("SIGKILL");
      },
    );
  },
  testTimeout,
);

test(
  "a child started with the default environment sees a variable the caller set after the runner loaded",
  async () => {
    const name = "PROCESS_RUNNER_LATE_VARIABLE";
    expect(process.env[name]).toBeUndefined();
    process.env[name] = "set late";
    try {
      const child = startChild(
        [
          process.execPath,
          "-e",
          `process.stdout.write(process.env.${name} ?? "unset")`,
        ],
        { limitMilliseconds: finishBound },
      );
      expect(await finishedWithin(child)).toMatchObject({
        exitCode: 0,
        stdout: "set late",
      });
    } finally {
      Reflect.deleteProperty(process.env, name);
    }
  },
  testTimeout,
);

test("the process runner imports only Node's own modules, so a fixture repository can copy it byte for byte", () => {
  const source = readFileSync(
    join(import.meta.dir, "../../../scripts/process-runner.ts"),
    "utf8",
  );
  const imported = [
    ...source.matchAll(/\bfrom\s+"([^"]+)"|\bimport\s*\(\s*"([^"]+)"/g),
  ].map(([, from, dynamic]) => from ?? dynamic ?? "");

  expect(imported.length).toBeGreaterThan(0);
  expect(imported.filter((name) => !name.startsWith("node:"))).toEqual([]);
});
