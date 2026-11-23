import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startChild, withoutRepositoryLocation } from "./process-runner.ts";

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

export function readUtf8Strict(filePath: string): string {
  return UTF8.decode(readFileSync(filePath));
}

export async function runProcess(
  argv: readonly string[],
  cwd: string,
  env: EnvMap,
  limitMilliseconds: number,
): Promise<ProcessResult> {
  const child = startChild(argv, {
    cwd,
    env,
    ownGroup: true,
    limitMilliseconds,
    graceMilliseconds: 0,
  });
  const finished = await child.finished;
  return {
    exitCode: finished.exitCode,
    stdout: finished.stdout,
    stderr: finished.stderr,
    timedOut: finished.timedOut,
  };
}

export function gateEnv(kernelRepository?: string): EnvMap {
  const base = withoutRepositoryLocation(process.env);
  return kernelRepository === undefined
    ? { ...base, ...GIT_ENV }
    : { ...base, ...GIT_ENV, KERNEL_REPOSITORY: kernelRepository };
}

export async function runGit(
  cwd: string,
  args: readonly string[],
  env = gateEnv(),
): Promise<string> {
  const result = await runProcess(["git", ...args], cwd, env, GIT_MS);
  if (result.timedOut) throw new Error(`git ${args.join(" ")} timed out.`);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout.trim();
}

export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
): Promise<boolean> {
  const result = await runProcess(
    ["git", "merge-base", "--is-ancestor", ancestor, descendant],
    root,
    gateEnv(),
    GIT_MS,
  );
  if (result.timedOut) throw new Error("git merge-base timed out.");
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new Error(
    `git merge-base failed (${result.exitCode}): ${result.stderr.trim()}`,
  );
}

export async function revParse(
  root: string,
  revision: string,
): Promise<string | undefined> {
  const result = await runProcess(
    ["git", "rev-parse", "--verify", "--quiet", `${revision}^{commit}`],
    root,
    gateEnv(),
    GIT_MS,
  );
  if (result.timedOut) {
    throw new Error(`git rev-parse timed out for "${revision}".`);
  }
  if (result.exitCode === 0) return result.stdout.trim();
  if (result.exitCode === 1) return undefined;
  throw new Error(
    `git rev-parse failed (${result.exitCode}) for "${revision}": ${result.stderr.trim()}`,
  );
}

export async function firstParentOf(
  root: string,
  commit: string,
): Promise<string | undefined> {
  const line = await runGit(root, ["rev-list", "--parents", "-n", "1", commit]);
  const parts = line.split(" ").filter((entry) => entry !== "");
  if (parts[0] !== commit) {
    throw new Error(`git rev-list returned unexpected parents for ${commit}.`);
  }
  return parts[1];
}

export async function gitFileExists(
  repositoryDir: string,
  revision: string,
  filePath: string,
  env: EnvMap,
): Promise<boolean> {
  const output = await runGit(
    repositoryDir,
    ["ls-tree", "--name-only", "-z", revision, "--", filePath],
    env,
  );
  const entries = output.split("\0").filter((entry) => entry !== "");
  return entries.includes(filePath);
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
    readUtf8Strict(packagePath).replaceAll(oldPin, newPin),
  );
  const skillsDir = join(repositoryDir, ".agents", "skills");
  if (!existsSync(skillsDir)) return;
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const skillPath = join(skillsDir, entry.name, "SKILL.md");
    if (entry.isDirectory() && existsSync(skillPath)) {
      writeFileSync(
        skillPath,
        readUtf8Strict(skillPath).replaceAll(oldPin, newPin),
      );
    }
  }
}

export async function bootstrapAtCommit(
  workDir: string,
  root: string,
  baseCommit: string,
  name: string,
  sourcePacket: string,
  env: EnvMap,
): Promise<string> {
  const checkout = join(workDir, `template-${baseCommit.slice(0, 7)}`);
  await runGit(
    workDir,
    ["clone", "--quiet", "--shared", "--no-checkout", root, checkout],
    env,
  );
  await runGit(checkout, ["checkout", "--quiet", "--detach", baseCommit], env);
  const destination = join(workDir, name);
  const run = await runProcess(
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

export async function commitInitialRepository(
  repositoryDir: string,
  env: EnvMap,
): Promise<void> {
  await runGit(repositoryDir, ["init", "--quiet"], env);
  await runGit(repositoryDir, ["add", "--all"], env);
  await runGit(
    repositoryDir,
    ["commit", "--quiet", "-m", "Initial bootstrap"],
    env,
  );
}
