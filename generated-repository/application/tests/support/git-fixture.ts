import { testFolder } from "./test-folder.ts";

const gitMilliseconds = 4_000;
const repositoryLocation: readonly string[] = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
];

const gitEnv = {
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

function inherited(): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) => !repositoryLocation.includes(name),
    ),
  );
}

export function git(root: string, ...args: string[]): string {
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
  if (result.exitCode !== 0)
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  return result.stdout.toString().trim();
}

export function gitFixture(prefix: string): string {
  const root = testFolder(prefix);
  git(root, "init", "--quiet", "--initial-branch=main");
  return root;
}
