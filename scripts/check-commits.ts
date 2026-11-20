import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { constants, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { runWithOwnTools } from "./process-runner.ts";
import { doctor } from "./doctor.ts";
import { readRepository } from "./repository.ts";

const steps = [
  ["install", "--frozen-lockfile"],
  ["run", "typecheck"],
  ["run", "lint"],
] as const;

export type Step = (typeof steps)[number];
export type Commit = { sha: string; short: string; subject: string };
export type Result =
  | { status: "green" }
  | { status: "red"; failed: Step; output: string };
export type Checked = Commit & { result: Result };

const signals = ["SIGHUP", "SIGINT", "SIGTERM"] as const;
export type StopSignal = (typeof signals)[number];
export type Active = { stop?: () => void; stoppedBy?: StopSignal };
export type Run = {
  readonly root: string;
  readonly fixedPoint: string;
  readonly active: Active;
};

function isStopSignal(
  signal: NodeJS.Signals | number | undefined,
): signal is StopSignal {
  return signals.some((each) => each === signal);
}

function git({ root, active }: Run, args: readonly string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (isStopSignal(result.signalCode)) active.stoppedBy ??= result.signalCode;
  return {
    ok: result.exitCode === 0,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function shown(step: Step): string {
  return `bun ${step.join(" ")}`;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function adminFolderOf(run: Run, dir: string): string | undefined {
  if (!existsSync(join(dir, ".git"))) return undefined;
  const found = git(run, [
    "-C",
    dir,
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
  ]);
  return found.ok ? found.stdout.trim() : undefined;
}

function pointsBackTo(admin: string, dir: string): boolean {
  const gitdir = join(admin, "gitdir");
  return (
    existsSync(gitdir) &&
    resolve(readFileSync(gitdir, "utf8").trim()) === join(dir, ".git")
  );
}

export function release(
  run: Run,
  dir: string,
  admin: string | undefined,
): void {
  const owned = admin !== undefined && pointsBackTo(admin, dir);
  const removed = git(run, ["worktree", "remove", "--force", dir]).ok;
  rmSync(dir, { recursive: true, force: true });
  if (removed || admin === undefined || !existsSync(admin)) return;
  if (owned) rmSync(admin, { recursive: true, force: true });
  else
    process.stderr.write(
      `git worktree remove failed for ${dir}, and ${admin} no longer names it, so that registration stays. Repair: git worktree prune\n`,
    );
}

function haltIfStopped({ active }: Run, commit: Commit): void {
  if (active.stoppedBy !== undefined)
    throw new Error(
      `Stopped by ${active.stoppedBy} while checking ${commit.short}, so it has no verdict.`,
    );
}

export async function check(run: Run, commit: Commit): Promise<Checked> {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "check-commits-")));
  let admin: string | undefined;
  try {
    const added = git(run, [
      "worktree",
      "add",
      "--detach",
      "--quiet",
      dir,
      commit.sha,
    ]);
    admin = adminFolderOf(run, dir);
    haltIfStopped(run, commit);
    if (!added.ok) throw new Error(added.stderr.trim());
    for (const step of steps) {
      const { exitCode, signalCode, output } = await runWithOwnTools(
        [process.execPath, ...step],
        dir,
        run.active,
      );
      haltIfStopped(run, commit);
      if (signalCode !== null)
        throw new Error(
          `${shown(step)} was killed by ${signalCode} while checking ${commit.short}, so it has no verdict.`,
        );
      if (exitCode !== 0)
        return { ...commit, result: { status: "red", failed: step, output } };
    }
    return { ...commit, result: { status: "green" } };
  } finally {
    release(run, dir, admin);
  }
}

function report(
  { fixedPoint }: Run,
  { sha, short, subject, result }: Checked,
): void {
  if (result.status === "green") {
    print(`GREEN ${short} ${subject}`);
    return;
  }
  print(`RED ${short} ${subject}`);
  print(`Failed: ${shown(result.failed)}`);
  print(
    `Repair: change ${short} itself so that ${shown(result.failed)} passes at that commit.`,
  );
  print(
    `Rerun locally: CHECK_COMMITS_SINCE='${fixedPoint}' bun run check:commits '${sha}^@' ${sha}`,
  );
  process.stdout.write(result.output.replace(/\n?$/, "\n"));
}

function commitsToCheck(run: Run, base: string, head: string): Commit[] {
  const { fixedPoint } = run;
  const present = git(run, ["cat-file", "-e", `${fixedPoint}^{commit}`]).ok;
  if (!present)
    print(
      `since ${fixedPoint} is not in this clone, so every commit in ${base}..${head} is checked.`,
    );
  const listed = git(run, [
    "rev-list",
    "--reverse",
    "--no-commit-header",
    "--format=%H %h %s",
    head,
    ...(present ? [`^${fixedPoint}`] : []),
    "--not",
    base,
  ]);
  if (!listed.ok) throw new Error(listed.stderr.trim());
  return listed.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => {
      const [sha = "", short = "", ...subject] = line.split(" ");
      return { sha, short, subject: subject.join(" ") };
    });
}

export async function main(argv: readonly string[], run: Run): Promise<number> {
  const [base, head = "HEAD"] = argv;
  if (base === undefined) {
    process.stderr.write("Usage: bun run check:commits <base> [head]\n");
    return 2;
  }
  if (!(await doctor(run.root))) {
    print("Refused: repair the doctor's FAIL lines, then rerun.");
    return 1;
  }
  const commits = commitsToCheck(run, base, head);
  if (commits.length === 0) {
    print(
      `No commits in ${base}..${head} to check, so this gate checks nothing. Repair: name a base that ${head} is ahead of.`,
    );
    return 1;
  }
  const started = performance.now();
  let red = 0;
  for (const commit of commits) {
    const checked = await check(run, commit);
    haltIfStopped(run, commit);
    report(run, checked);
    if (checked.result.status === "red") red += 1;
  }
  const seconds = (performance.now() - started) / 1000;
  const pace = ` in ${seconds.toFixed(1)} s, ${(seconds / commits.length).toFixed(1)} s per commit`;
  if (red > 0) {
    print(`${red} of ${commits.length} commits are red${pace}.`);
    return 1;
  }
  print(`Checked ${commits.length} commits: all green${pace}.`);
  return 0;
}

if (import.meta.main) {
  const root = join(import.meta.dir, "..");
  const active: Active = {};
  const run: Run = {
    root,
    fixedPoint:
      process.env.CHECK_COMMITS_SINCE || readRepository(root).checkCommitsSince,
    active,
  };
  for (const signal of signals)
    process.on(signal, () => {
      active.stoppedBy ??= signal;
      active.stop?.();
    });

  try {
    process.exitCode = await main(process.argv.slice(2), run);
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 2;
  }
  if (active.stoppedBy !== undefined)
    process.exitCode = 128 + constants.signals[active.stoppedBy];
}
