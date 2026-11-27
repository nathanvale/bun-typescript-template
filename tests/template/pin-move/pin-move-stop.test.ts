import { describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { startChild } from "../../../scripts/process-runner.ts";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  failedAttempt,
  RepositoryPinRefusal,
} from "../../../src/pin-move-branch.ts";
import { pinMoveIdentity } from "../../../src/pin-refusals.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { gitReadingRemoteAs } from "../../support/hung-git.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import { pinnedTemplate } from "../../support/kernel-trial-fixture.ts";
import {
  cloneSpecifier,
  installedKernelCommit,
  pinMoveRepositoryFixture,
} from "../../support/pin-move-repository-fixture.ts";
import { spawnBounded, watchLedger } from "../../support/process.ts";
import { templateCopy } from "../../support/template-copy.ts";

const pin = readKernelPin(ROOT);
const folder = ownedFolders();
const fixture = pinMoveRepositoryFixture();

function remotePathEnv(kernelRepo: string): Record<string, string | undefined> {
  const remoteBin = folder("pin-move-stop-bin-");
  gitReadingRemoteAs(remoteBin, pin.remote, kernelRepo);
  return {
    PATH: `${remoteBin}${delimiter}${process.env.PATH ?? ""}`,
  };
}

async function runPinMove(
  cwd: string,
  args: readonly string[],
  stateHome: string,
  extraEnv: Record<string, string | undefined> = {},
  boundMilliseconds = 120_000,
) {
  const run = await spawnBounded(
    [process.execPath, join(cwd, "src/cli.ts"), "pin", "move", ...args],
    {
      cwd,
      env: {
        ...inherited(),
        ...gitEnv,
        ...extraEnv,
        XDG_STATE_HOME: stateHome,
      },
      boundMilliseconds,
    },
  );
  return { exitCode: run.exit, stdout: run.stdout, stderr: run.stderr };
}

function keptAttemptBranch(repo: string, prefix: string): string {
  const branches = gitOutput(repo, "branch", "--format=%(refname:short)")
    .split("\n")
    .filter((branch) => branch.startsWith(`${prefix}-failed-`));
  expect(branches).toHaveLength(1);
  const kept = branches[0];
  if (kept === undefined) throw new Error(`Missing kept branch for ${prefix}`);
  return kept;
}

describe("pin move stop settlement", () => {
  test("in process: failedAttempt skips restoreInstalledKernel when stopped by a signal, marks git restored without packages restored, and keeps the frozen-install repair", async () => {
    const repo = folder("pin-move-stop-in-process-");
    initRepository(repo);
    commitIn(repo, "initial", { "package.json": "{}\n" });
    const branch = "pin-move/1234567";
    git(repo, "checkout", "--quiet", "-b", branch);
    writeFileSync(join(repo, "package.json"), '{"changed":true}\n');

    const original = new RepositoryPinRefusal(
      "trial_stopped",
      `Pin move in ${repo} was stopped by SIGTERM during check command on branch ${branch}.`,
      "Run bun run pin:move again when it can run to its end.",
    );
    const result = await failedAttempt(
      {
        repository: repo,
        startingRef: "main",
        branch,
        subject: "chore(kernel): failed Pin move from 0000000 to 1234567",
        edited: ["package.json"],
        kernelPackage: "agent-cli-kernel",
        startingPin: "0".repeat(40),
        regenerate: false,
        active: { stoppedBy: "SIGTERM" },
      },
      original,
      true,
    );

    expect(result).toBeInstanceOf(RepositoryPinRefusal);
    if (!(result instanceof RepositoryPinRefusal)) {
      throw new Error("Expected RepositoryPinRefusal");
    }
    expect(result.code).toBe("trial_stopped");
    expect(result.restored).toBe(false);
    expect(Reflect.get(result, "gitRestoredOnStop")).toBe(true);
    expect(result.reason).toContain(
      "its installed packages may still hold the failed attempt's kernel",
    );
    expect(result.repair).toContain(
      `Run bun install --frozen-lockfile in ${repo} before running bun run pin:move again.`,
    );
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(
      gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
    ).toBe("");
    keptAttemptBranch(repo, branch);
  });

  test("SIGTERM during repository check settles inside 450 ms even when restore frozen install is slow, keeps the attempt, and lets the next pin move run", async () => {
    const copy = templateCopy(folder("pin-move-stop-copy-"), []);
    pinnedTemplate(copy, pin.commit, pin.carryOutIdentity);
    if (!existsSync(join(copy, "node_modules"))) {
      symlinkSync(join(ROOT, "node_modules"), join(copy, "node_modules"));
    }

    const barrier = folder("pin-move-stop-barrier-");
    const ledger = join(barrier, "check-started");
    const release = join(barrier, "release");

    const trialPath = join(copy, "scripts/kernel-trial.ts");
    const trialSource = readFileSync(trialPath, "utf8");
    const marker = "  if (active.stoppedBy !== undefined)";
    expect(trialSource).toContain(marker);
    writeFileSync(
      trialPath,
      trialSource.replace(
        marker,
        `  if (name === "frozen install" && existsSync(${JSON.stringify(ledger)})) { await Bun.sleep(600); }\n${marker}`,
      ),
    );

    const repo = folder("pin-move-stop-repo-");
    initRepository(repo);
    const pinSpec = cloneSpecifier(fixture.kernelRepo, trialBase);
    const baseManifest = {
      name: "pin-move-stop-fixture",
      dependencies: { "agent-cli-kernel": pinSpec },
    };
    commitIn(repo, "initial repository with blocking check", {
      ".gitignore": "node_modules/\n",
      "package.json": `${JSON.stringify(
        {
          ...baseManifest,
          scripts: { check: "bun run check-wait.ts" },
        },
        null,
        2,
      )}\n`,
      "check-wait.ts": `import { appendFileSync, existsSync } from "node:fs";
appendFileSync(${JSON.stringify(ledger)}, "check-started\\n");
await new Promise<void>((resolve) => {
  const poll = setInterval(() => {
    if (existsSync(${JSON.stringify(release)})) {
      clearInterval(poll);
      resolve();
    }
  }, 10);
});
`,
    });

    const stateHome = folder("pin-move-stop-state-");
    const env = {
      ...inherited(),
      ...gitEnv,
      ...remotePathEnv(fixture.kernelRepo),
      XDG_STATE_HOME: stateHome,
    };
    const installed = await spawnBounded([process.execPath, "install"], {
      cwd: repo,
      env,
      boundMilliseconds: 120_000,
    });
    expect({ exit: installed.exit, stderr: installed.stderr }).toMatchObject({
      exit: 0,
    });
    commitIn(repo, "commit starting lockfile", {
      "bun.lock": readFileSync(join(repo, "bun.lock"), "utf8"),
    });
    expect(trialBase).toStartWith(installedKernelCommit(repo));

    const child = startChild(
      [
        process.execPath,
        join(copy, "src/cli.ts"),
        "pin",
        "move",
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
        "--json",
      ],
      { cwd: copy, env, limitMilliseconds: 120_000 },
    );
    const started = watchLedger(ledger, "check-started", 90_000);
    let elapsedMilliseconds: number;
    try {
      const reached = await Promise.race([
        started.reached.then(() => "started"),
        child.finished.then(
          (run) => `exited ${run.exitCode}: ${run.stdout}${run.stderr}`,
        ),
      ]);
      expect(reached).toBe("started");
      const signaledAt = performance.now();
      child.signal("SIGTERM");
      const stopped = await child.finished;
      elapsedMilliseconds = performance.now() - signaledAt;
      expect(stopped.exitCode).toBe(143);
    } finally {
      started.stop();
      appendFileSync(release, "go\n");
      child.stop();
      await child.finished;
    }

    expect(elapsedMilliseconds).toBeLessThan(450);
    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(
      gitOutput(repo, "status", "--porcelain", "--untracked-files=all"),
    ).toBe("");
    const expectedPrefix = `pin-move/${fixture.targetCommit.slice(0, 7)}`;
    const kept = keptAttemptBranch(repo, expectedPrefix);
    expect(git(repo, "show", `${kept}:package.json`)).toContain(
      cloneSpecifier(fixture.kernelRepo, fixture.targetCommit),
    );
    expect(fixture.targetCommit).toStartWith(installedKernelCommit(repo));

    commitIn(repo, "restore passing check script", {
      "package.json": `${JSON.stringify(
        {
          ...baseManifest,
          scripts: { check: "bun -e ''" },
        },
        null,
        2,
      )}\n`,
    });
    const nextRun = await runPinMove(
      copy,
      [
        fixture.targetCommit,
        "--kernel",
        fixture.kernelRepo,
        "--repository",
        repo,
        "--json",
      ],
      stateHome,
      env,
      120_000,
    );
    expect(nextRun.exitCode).toBe(0);
    expect(nextRun.stderr).toBe("");
    const nextEnvelope = JSON.parse(nextRun.stdout) as {
      readonly result: {
        readonly commandIdentity: string;
        readonly causeCode: string;
      };
      readonly data?: { readonly repository?: string };
    };
    expect(nextEnvelope.result.commandIdentity).toBe(pinMoveIdentity);
    expect(nextEnvelope.result.causeCode).toBe("SUCCESS_COMPLETED");
    expect(nextEnvelope.data?.repository).toBe(realpathSync(repo));
  }, 180_000);
});
