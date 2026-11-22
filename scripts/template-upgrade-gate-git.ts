import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const GIT_MS = 30_000;
const BOOTSTRAP_MS = 60_000;
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type EnvMap = Readonly<Record<string, string | undefined>>;

export type ProcessResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
};

const GIT_ENV = {
  GIT_AUTHOR_NAME: "Template Upgrade Gate",
  GIT_AUTHOR_EMAIL: "template-upgrade-gate@example.com",
  GIT_COMMITTER_NAME: "Template Upgrade Gate",
  GIT_COMMITTER_EMAIL: "template-upgrade-gate@example.com",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_TERMINAL_PROMPT: "0",
} as const;

export function runProcess(
  argv: readonly string[],
  cwd: string,
  env: EnvMap,
  timeout: number,
): ProcessResult {
  const result = Bun.spawnSync([...argv], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout,
    killSignal: "SIGKILL",
  });
  return {
    exitCode: result.exitCode,
    stdout: UTF8.decode(result.stdout),
    stderr: UTF8.decode(result.stderr),
    timedOut: result.exitedDueToTimeout ?? false,
  };
}

export function gateEnv(kernelRepository?: string): EnvMap {
  return kernelRepository === undefined
    ? { ...process.env, ...GIT_ENV }
    : { ...process.env, ...GIT_ENV, KERNEL_REPOSITORY: kernelRepository };
}

export function runGit(
  cwd: string,
  args: readonly string[],
  env = gateEnv(),
): string {
  const result = runProcess(["git", ...args], cwd, env, GIT_MS);
  if (result.timedOut) throw new Error(`git ${args.join(" ")} timed out.`);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

export function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): boolean {
  const result = runProcess(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    root,
    gateEnv(),
    GIT_MS,
  );
  if (result.timedOut) throw new Error("git merge-base timed out.");
  return result.exitCode === 0;
}

export function revParse(root: string, revision: string): string | undefined {
  const result = runProcess(
    ["git", "rev-parse", "--verify", `${revision}^{commit}`],
    root,
    gateEnv(),
    GIT_MS,
  );
  return !result.timedOut && result.exitCode === 0
    ? result.stdout.trim()
    : undefined;
}

export function gitFileExists(
  repositoryDir: string,
  refPath: string,
  env: EnvMap,
): boolean {
  const result = runProcess(
    ["git", "cat-file", "-e", refPath],
    repositoryDir,
    env,
    GIT_MS,
  );
  return !result.timedOut && result.exitCode === 0;
}

export function readPackageKernelPin(packageJsonText: string): string {
  const parsed: unknown = JSON.parse(packageJsonText);
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("package.json is not an object.");
  }
  const dependencies: unknown = new Map(Object.entries(parsed)).get(
    "dependencies",
  );
  if (typeof dependencies !== "object" || dependencies === null) {
    throw new Error("package.json has no dependencies object.");
  }
  const rawPin: unknown = new Map(Object.entries(dependencies)).get(
    "agent-cli-kernel",
  );
  const match =
    typeof rawPin === "string" ? /#([0-9a-f]{40})$/.exec(rawPin) : null;
  if (match?.[1] === undefined) {
    throw new Error(
      `package.json has no 40-character kernel Pin: ${String(rawPin)}`,
    );
  }
  return match[1];
}

export function alignRepositoryKernelPin(
  repositoryDir: string,
  oldPin: string,
  newPin: string,
): void {
  const packagePath = join(repositoryDir, "package.json");
  writeFileSync(
    packagePath,
    readFileSync(packagePath, "utf8").replaceAll(oldPin, newPin),
  );
  const skillsDir = join(repositoryDir, ".agents", "skills");
  if (!existsSync(skillsDir)) return;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (entry.isDirectory() && existsSync(skillPath)) {
      writeFileSync(
        skillPath,
        readFileSync(skillPath, "utf8").replaceAll(oldPin, newPin),
      );
    }
  }
}

export function bootstrapAtCommit(
  workDir: string,
  root: string,
  baseCommit: string,
  name: string,
  sourcePacket: string,
  env: EnvMap,
): string {
  const checkout = join(workDir, `template-${baseCommit.slice(0, 7)}`);
  runGit(
    workDir,
    ["clone", "--quiet", "--shared", "--no-checkout", root, checkout],
    env,
  );
  runGit(checkout, ["checkout", "--quiet", "--detach", baseCommit], env);
  const destination = join(workDir, name);
  const run = runProcess(
    [
      process.execPath,
      "run",
      join(checkout, "src/bootstrap.ts"),
      "--destination",
      destination,
      "--source-packet",
      sourcePacket,
      "--name",
      name,
      "--json",
    ],
    checkout,
    env,
    BOOTSTRAP_MS,
  );
  if (run.timedOut || run.exitCode !== 0) {
    throw new Error(
      `Bootstrap failed at ${baseCommit.slice(0, 7)}: ${run.stderr.trim() || run.stdout.trim()}`,
    );
  }
  return destination;
}

export function commitInitialRepository(
  repositoryDir: string,
  env: EnvMap,
): void {
  runGit(repositoryDir, ["init", "--quiet"], env);
  runGit(repositoryDir, ["add", "--all"], env);
  runGit(repositoryDir, ["commit", "--quiet", "-m", "Initial bootstrap"], env);
}
