import { mkdirSync } from "node:fs";
import { withoutRepositoryLocation } from "../../scripts/process-runner.ts";
import { write } from "./fixture-files.ts";

const gitMilliseconds = 4_000;

export const gitEnv = {
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_COUNT: "2",
  GIT_CONFIG_KEY_0: "maintenance.auto",
  GIT_CONFIG_VALUE_0: "false",
  GIT_CONFIG_KEY_1: "gc.auto",
  GIT_CONFIG_VALUE_1: "0",
  GIT_CONFIG_PARAMETERS: "",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

export function inherited(): Record<string, string | undefined> {
  return withoutRepositoryLocation(process.env);
}

export function gitResult(root: string, ...args: string[]) {
  const result = Bun.spawnSync(["git", ...args], {
    cwd: root,
    env: { ...inherited(), ...gitEnv },
    stdout: "pipe",
    stderr: "pipe",
    timeout: gitMilliseconds,
    killSignal: "SIGKILL",
  });
  if (result.exitedDueToTimeout)
    throw new Error(
      `git ${args.join(" ")} did not exit within ${gitMilliseconds} ms.`,
    );
  return result;
}

export function gitOutput(root: string, ...args: string[]): string {
  const result = gitResult(root, ...args);
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString();
}

export function git(root: string, ...args: string[]): string {
  return gitOutput(root, ...args).trim();
}

export function initRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, "init", "--quiet", "--initial-branch=main");
}

export function commitIn(
  root: string,
  subject: string,
  changes: Record<string, string | null>,
) {
  for (const [path, content] of Object.entries(changes))
    if (content === null) git(root, "rm", "--quiet", "--", path);
    else {
      write(root, path, content);
      git(root, "add", "--", path);
    }
  git(root, "commit", "--quiet", "--allow-empty", "-m", subject);
  return {
    sha: git(root, "rev-parse", "HEAD"),
    short: git(root, "rev-parse", "--short", "HEAD"),
  };
}

export function commit(
  root: string,
  subject: string,
  changes: Record<string, string | null>,
): string {
  return commitIn(root, subject, changes).short;
}

export function worktreeLines(root: string): string[] {
  return git(root, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((line) => line.startsWith("worktree "));
}

export function worktrees(root: string): string[] {
  return worktreeLines(root).map((line) => line.slice("worktree ".length));
}
