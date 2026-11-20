import { afterEach } from "bun:test";
import { readdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ProjectRecipe } from "../../src/recipe.ts";
import { gitEnv, inherited } from "./git-fixture.ts";
import { spawnBounded } from "./process.ts";
import { testFolder } from "./test-folder.ts";

export const ROOT = resolve(import.meta.dir, "../..");

export function rowKey({ request, cli }: ProjectRecipe): string {
  return [
    request.profile,
    request.layout,
    request.starter,
    cli === "kernel" ? cli : undefined,
  ]
    .filter((word) => word !== undefined)
    .join(" ");
}

export function parsePackage(text: string) {
  const value: unknown = JSON.parse(text);
  return value as {
    name: string;
    packageManager: string;
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    catalog: Record<string, string>;
  };
}

export interface Invocation {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function runIn(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Promise<Invocation> {
  return runCommand(cwd, [process.execPath, ...args], {
    ...process.env,
    ...env,
  });
}

export async function runCommand(
  cwd: string,
  command: string[],
  env: Readonly<Record<string, string | undefined>> = process.env,
): Promise<Invocation> {
  const { exit, stdout, stderr } = await spawnBounded(command, {
    cwd,
    env: { ...env, NO_COLOR: "1" },
    processGroup: true,
  });
  return { exitCode: exit, stderr, stdout };
}

export function invoke(...args: string[]): Promise<Invocation> {
  return runCommand(ROOT, [
    process.execPath,
    "run",
    "src/bootstrap.ts",
    ...args,
  ]);
}

export function runGit(cwd: string, args: string[]): Promise<Invocation> {
  return runCommand(cwd, ["git", ...args], {
    ...inherited(),
    ...gitEnv,
    GIT_AUTHOR_NAME: undefined,
    GIT_AUTHOR_EMAIL: undefined,
    GIT_COMMITTER_NAME: undefined,
    GIT_COMMITTER_EMAIL: undefined,
  });
}

export async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

export function requireSuccess(result: Invocation, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(
      `${operation} failed with exit ${result.exitCode}: ${result.stderr}\n${result.stdout}`,
    );
  }
}

export async function commitGeneratedFiles(
  destination: string,
  files: readonly string[],
): Promise<void> {
  requireSuccess(await runGit(destination, ["init", "--quiet"]), "git init");
  requireSuccess(
    await runGit(destination, ["add", "--", ...files]),
    "git add generated files",
  );
  requireSuccess(
    await runGit(destination, [
      "-c",
      "user.name=CLI template qualification",
      "-c",
      "user.email=cli-template@example.test",
      "commit",
      "--quiet",
      "-m",
      "qualify generated starter",
    ]),
    "git commit generated files",
  );
}

export function bootstrapCliFixture() {
  const scratchRoots: string[] = [];

  function temporaryRoot(): string {
    const root = testFolder("bootstrap-cli-");
    scratchRoots.push(root);
    return root;
  }

  afterEach(async () => {
    await Promise.all(
      scratchRoots
        .splice(0)
        .map((root) => rm(root, { force: true, recursive: true })),
    );
  });

  return temporaryRoot;
}
