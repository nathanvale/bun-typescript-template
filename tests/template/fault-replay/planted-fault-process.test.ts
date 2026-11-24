import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync } from "node:fs";
import { delimiter, join } from "node:path";
import { processWatchdog } from "../../support/process.ts";
import {
  createPlantedFaultFixture,
  exited,
  expectNoLeftovers,
  expectOneTestProcessGone,
  guarded,
  ledgered,
  lineOf,
  tests,
  timeout,
  verdicts,
} from "../../support/planted-fault-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { gitOutput, commit, worktrees } from "../../support/git-fixture.ts";

const { faultReplay, folder, hangLedger, pidLedger, repositoryWithFault } =
  createPlantedFaultFixture();

const stepSeconds = 3;
const hangBound = 30_000;
const forcedBound = 10_000;

describe("bun run fault-replay", () => {
  test(
    "FR.f a replay leaves the caller's tree, index, branch and stash as they were, and sees its uncommitted edits",
    async () => {
      const { root, id } = await repositoryWithFault({});
      write(root, "notes.txt", "staged\n");
      gitOutput(root, "add", "--", "notes.txt");
      write(root, "tests/limit.test.ts", tests("expect(true).toBe(true)"));
      write(root, "untracked.txt", "untracked\n");
      const state = () =>
        [
          gitOutput(root, "status", "--porcelain=v1", "--untracked-files=all"),
          gitOutput(root, "diff"),
          gitOutput(root, "diff", "--cached"),
          gitOutput(root, "rev-parse", "HEAD"),
          gitOutput(root, "symbolic-ref", "HEAD"),
          gitOutput(root, "stash", "list"),
        ].join("\n--\n");
      const before = state();
      const run = await faultReplay(root);
      expect(verdicts(run.lines)).toEqual([`SURVIVED ${id}`]);
      expect(state()).toBe(before);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.j a replayed test sees only the tools its own tree installs, not the caller's node_modules/.bin",
    async () => {
      const { root } = await repositoryWithFault({
        tools: "^L\\.(refuses|tools) ",
      });
      write(root, "node_modules/.bin/fault-replay-caller-tool", "#!/bin/sh\n");
      chmodSync(
        join(root, "node_modules/.bin/fault-replay-caller-tool"),
        0o755,
      );
      const run = await faultReplay(root, ["tools"]);
      expect(verdicts(run.lines)).toEqual(["KILLED tools"]);
      expect(run.exit).toBe(0);
    },
    processWatchdog(2),
  );

  test(
    "FR.k a test killed by a signal the run did not receive gives no verdict and exits 2",
    async () => {
      const { root } = await repositoryWithFault({ dies: "^L\\.dies " });
      const run = await faultReplay(root, ["dies"]);
      expect(run.stderr).toContain(
        " was killed by SIGKILL while replaying dies, so it has no verdict.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(2);
      expectNoLeftovers(root, run.temporary);
    },
    processWatchdog(2),
  );

  for (const [signal, exit] of [
    ["SIGHUP", 129],
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const)
    test(
      `FR.g ${signal} stops the replay with exit ${exit}, no verdict, no worktree and no running test`,
      async () => {
        const { root } = await repositoryWithFault({
          blocks: "^L\\.blocks ",
        });
        const hang = hangLedger();
        const run = await faultReplay(root, ["blocks"], {
          signalAt: { ledger: hang.ledger, line: "started", signal },
          env: { FAULTS_LEDGER: hang.ledger },
        });
        expect(run.stderr).toContain(
          `Stopped by ${signal} while replaying blocks, so it has no verdict.\n`,
        );
        expect(verdicts(run.lines)).toEqual([]);
        expect(run.exit).toBe(exit);
        expectOneTestProcessGone(run.pids);
        expectNoLeftovers(root, run.temporary);
      },
      timeout,
    );

  for (const [id, title, trapped] of [
    ["blocks", "^L\\.blocks ", []],
    ["traps", "^L\\.traps ", ["trapped"]],
  ] as const)
    test(
      `FR.o a replayed test that ${id === "traps" ? "traps SIGTERM and " : ""}hangs past the step limit is TIMEOUT by id, exits 1, and leaves no process or worktree`,
      async () => {
        const { root } = await repositoryWithFault({ [id]: title });
        const hang = hangLedger();
        const run = await faultReplay(root, [id], {
          env: {
            FAULTS_LEDGER: hang.ledger,
            FAULT_REPLAY_STEP_SECONDS: String(stepSeconds),
          },
          boundMilliseconds: hangBound,
        });
        expect(verdicts(run.lines)).toEqual([`TIMEOUT ${id}`]);
        expect(lineOf(run.lines, "TIMEOUT")).toMatch(
          new RegExp(
            `^TIMEOUT ${id} in [\\d.]+ s\\. \\S+ scripts/test-run\\.ts \\./tests/limit\\.test\\.ts -t \\^L\\\\\\.${id}  did not finish within ${stepSeconds} s, so the planted fault has no verdict\\.$`,
          ),
        );
        expect(run.lines).toContain(
          `Repair: run that step by hand to see where it hangs, or raise FAULT_REPLAY_STEP_SECONDS. Done when bun run fault-replay ${id} passes.`,
        );
        expect(run.exit).toBe(1);
        expect(hang.lines().filter((line) => line === "trapped")).toEqual([
          ...trapped,
        ]);
        expectOneTestProcessGone(run.pids);
        expectNoLeftovers(root, run.temporary);
      },
      hangBound + 10_000,
    );

  test(
    "FR.p a SIGINT to a replay whose test traps SIGTERM escalates to SIGKILL, exits 130, and leaves no process or worktree",
    async () => {
      const { root } = await repositoryWithFault({ traps: "^L\\.traps " });
      const hang = hangLedger();
      const run = await faultReplay(root, ["traps"], {
        signalAt: { ledger: hang.ledger, line: "started", signal: "SIGINT" },
        env: { FAULTS_LEDGER: hang.ledger },
        boundMilliseconds: hangBound,
      });
      expect(run.stderr).toContain(
        "Stopped by SIGINT while replaying traps, so it has no verdict.\n",
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(130);
      expect(hang.lines()).toContain("trapped");
      expectOneTestProcessGone(run.pids);
      expectNoLeftovers(root, run.temporary);
    },
    hangBound + 10_000,
  );

  test(
    "FR.r a run that outlives its test bound leaves no replay script, test process or worktree behind",
    async () => {
      const { root } = await repositoryWithFault({ blocks: "^L\\.blocks " });
      const hang = hangLedger();
      const pids = pidLedger();
      const outcome = await faultReplay(root, ["blocks"], {
        env: { FAULTS_LEDGER: hang.ledger },
        boundMilliseconds: forcedBound,
        pids,
      }).then(
        () => "exited",
        (error: unknown) => String(error),
      );
      expect(outcome).toContain(`did not exit within ${forcedBound} ms.\n`);
      expect(hang.lines()).toContain("started");
      const [test, ...more] = ledgered(pids);
      expect(more).toEqual([]);
      if (test === undefined) throw new Error("No test process was ledgered.");
      expect(await exited(test.pid)).toBe(true);
      expect(await exited(test.parent)).toBe(true);
      expect(worktrees(root)).toEqual([root]);
    },
    forcedBound + 15_000,
  );

  test(
    "FR.s a caller's GIT_DIR does not redirect the fixture's git, planted-fault:add or replay to another repository",
    async () => {
      const unrelated = join(folder("fault-replay-caller-"), "repo");
      mkdirSync(unrelated);
      gitOutput(unrelated, "init", "--quiet", "--initial-branch=main");
      commit(unrelated, "caller", { "caller.txt": "caller\n" });
      const state = () =>
        [
          gitOutput(unrelated, "log", "--format=%H %s", "--all"),
          gitOutput(unrelated, "worktree", "list", "--porcelain"),
          gitOutput(
            unrelated,
            "status",
            "--porcelain=v1",
            "--untracked-files=all",
          ),
          gitOutput(unrelated, "config", "--local", "--list"),
        ].join("\n--\n");
      const before = state();
      process.env.GIT_DIR = join(unrelated, ".git");
      try {
        const { root, id } = await repositoryWithFault({});
        const run = await faultReplay(root);
        expect(verdicts(run.lines)).toEqual([`KILLED ${id}`]);
        expect(run.exit).toBe(0);
        expect(gitOutput(root, "log", "--format=%s")).toBe(
          "record the faults\nfix: refuse a NaN limit\nbase\n",
        );
      } finally {
        delete process.env.GIT_DIR;
      }
      expect(state()).toBe(before);
    },
    processWatchdog(3),
  );

  test(
    "FR.l a stop that finds the step's process group holding only zombies still exits 130 (macOS answers EPERM there)",
    async () => {
      const { root, id } = await repositoryWithFault({});
      const tools = folder("fault-replay-zombie-");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = add ]; then
  perl -e '
    my ($replay, $shim) = @ARGV;
    if (!fork) { exit 0 }
    setpgrp(0, 0);
    select(undef, undef, undef, 0.01) while getppid() == $shim;
    kill "INT", $replay;
    select(undef, undef, undef, 2);
  ' "$PPID" "$$" &
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      const run = await faultReplay(root, [], {
        env: { PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}` },
      });
      expect(run.stderr).toContain(
        `Stopped by SIGINT while replaying ${id}, so it has no verdict.\n`,
      );
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(130);
      expectNoLeftovers(root, run.temporary);
    },
    processWatchdog(2),
  );

  test(
    "FR.n a SIGINT while git removes a record's worktree stops on that record, before the next one starts",
    async () => {
      const { root, id } = await repositoryWithFault({ next: "^L\\.refuses " });
      const tools = folder("fault-replay-remove-");
      const once = join(tools, "signalled");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ] && [ ! -e '${once}' ]; then
  : > '${once}'
  kill -INT "$PPID"
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      const run = await faultReplay(root, [], {
        env: { PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}` },
      });
      expect(run.stderr).toContain(
        `Stopped by SIGINT while replaying ${id}, so it has no verdict.\n`,
      );
      expect(run.stderr).not.toContain("while replaying next");
      expect(verdicts(run.lines)).toEqual([]);
      expect(run.exit).toBe(130);
      expectNoLeftovers(root, run.temporary);
    },
    processWatchdog(2),
  );

  test(
    "FR.y a worktree removal that hangs is stopped at the step limit, leaves no worktree entry, and the verdict stands",
    async () => {
      const { root, id } = await repositoryWithFault({});
      commit(root, "reword the refusal", {
        "src/limit.ts": guarded.replace("must be", "has to be"),
      });
      const tools = folder("fault-replay-hung-remove-");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ]; then
  exec sleep 20
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      const began = performance.now();

      const run = await faultReplay(root, [], {
        env: {
          PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}`,
          FAULT_REPLAY_STEP_SECONDS: String(stepSeconds),
        },
        boundMilliseconds: forcedBound,
      });

      expect(verdicts(run.lines)).toEqual([`STALE ${id}`]);
      expect(run.exit).toBe(1);
      expect(performance.now() - began).toBeLessThan(
        stepSeconds * 1000 + 4_000,
      );
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );

  test(
    "FR.h a terminal's group SIGINT while git removes the worktree still removes it, and exits 130",
    async () => {
      const { root } = await repositoryWithFault({});
      const tools = folder("fault-replay-group-");
      const realGit = Bun.which("git");
      if (realGit === null) throw new Error("git is not on PATH.");
      write(
        tools,
        "bin/git",
        `#!/bin/sh
if [ "$1" = worktree ] && [ "$2" = remove ]; then
  kill -INT -"$(ps -o pgid= -p "$PPID" | tr -d ' ')"
fi
exec '${realGit}' "$@"
`,
      );
      chmodSync(join(tools, "bin/git"), 0o755);
      write(
        tools,
        "own-group.ts",
        `const child = Bun.spawn(process.argv.slice(2), {
  detached: true,
  stdio: ["inherit", "inherit", "inherit"],
});
process.exit(await child.exited);
`,
      );
      const run = await faultReplay(root, [], {
        launcher: [process.execPath, join(tools, "own-group.ts")],
        env: { PATH: `${join(tools, "bin")}${delimiter}${process.env.PATH}` },
      });
      expect(run.exit).toBe(130);
      expectNoLeftovers(root, run.temporary);
    },
    timeout,
  );
});
