import { afterEach } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { gitEnv, inherited } from "./git-fixture.ts";
import { spawnBounded } from "./process.ts";
import { copyRuleFiles } from "./static-admission-in-process-fixture.ts";

export const ROOT = resolve(import.meta.dir, "../..");

const TOOL_WORKTREE = resolve(ROOT, "../bun-typescript-template-integration");

const STATIC_PACKET = resolve(ROOT, "profiles/static-admission");

const nativeCommandMilliseconds = 60_000;
const gitMilliseconds = 4_000;

export type Profile = "simple" | "complex";

export interface Invocation {
  exitCode: number;
  stderr: string;
  stdout: string;
}

export function nativeEnvironment(): Record<string, string | undefined> {
  return {
    ...inherited(),
    ...gitEnv,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
}

export async function runNative(
  cwd: string,
  command: string,
  args: string[],
  environment: Record<string, string> = {},
): Promise<Invocation> {
  const { exit, stdout, stderr } = await spawnBounded([command, ...args], {
    cwd,
    env: { ...nativeEnvironment(), ...environment },
    boundMilliseconds: nativeCommandMilliseconds,
    processGroup: true,
  });
  return { exitCode: exit, stderr, stdout };
}

export async function gitAsync(
  cwd: string,
  ...args: string[]
): Promise<string> {
  const { exit, stdout, stderr } = await spawnBounded(["git", ...args], {
    cwd,
    env: {
      ...nativeEnvironment(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_NAME: undefined,
      GIT_AUTHOR_EMAIL: undefined,
      GIT_COMMITTER_NAME: undefined,
      GIT_COMMITTER_EMAIL: undefined,
    },
    boundMilliseconds: gitMilliseconds,
    processGroup: true,
  });
  if (exit !== 0) {
    throw new Error("git " + args.join(" ") + " failed:\n" + stderr);
  }
  return stdout;
}

export function toolPath(name: string): string {
  const local = join(ROOT, "node_modules/.bin", name);
  if (existsSync(local)) return local;
  const configuredRoot = process.env.STATIC_ADMISSION_TOOL_ROOT;
  if (configuredRoot) {
    const configured = join(configuredRoot, "node_modules/.bin", name);
    if (existsSync(configured)) return configured;
  }
  const sibling = join(TOOL_WORKTREE, "node_modules/.bin", name);
  if (existsSync(sibling)) return sibling;
  return name;
}

export async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

export async function readJson(path: string): Promise<Record<string, unknown>> {
  return (await Bun.file(path).json()) as Record<string, unknown>;
}

async function copyTree(source: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const sourcePath = join(source, entry.name);
    const destinationPath = join(destination, entry.name);
    if (entry.isDirectory()) {
      await copyTree(sourcePath, destinationPath);
    } else {
      await copyFile(sourcePath, destinationPath);
    }
  }
}

async function linkPackage(
  nodeModules: string,
  packageName: string,
  source: string,
): Promise<void> {
  const destination = join(nodeModules, packageName);
  if (existsSync(destination)) return;
  await mkdir(dirname(destination), { recursive: true });
  await symlink(source, destination);
}

async function installRuntimeDependencies(root: string): Promise<void> {
  const args = ["install", "--production", "--frozen-lockfile"];
  const invocation = await runNative(root, process.execPath, args);
  if (invocation.exitCode === 0) return;
  throw new Error(
    "bun " +
      args.join(" ") +
      " failed in " +
      root +
      " (exit " +
      invocation.exitCode +
      "); the pinned runtime dependencies must resolve from the profile lock." +
      "\nstdout:\n" +
      invocation.stdout +
      "\nstderr:\n" +
      invocation.stderr,
  );
}

async function linkDependencies(root: string, profile: Profile): Promise<void> {
  const source =
    process.env.STATIC_ADMISSION_NODE_MODULES ??
    (existsSync(join(ROOT, "node_modules"))
      ? join(ROOT, "node_modules")
      : join(TOOL_WORKTREE, "node_modules"));
  const nodeModules = join(root, "node_modules");
  await mkdir(nodeModules, { recursive: true });

  if (profile === "complex") await installRuntimeDependencies(root);

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    await linkPackage(nodeModules, entry.name, join(source, entry.name));
  }
  if (existsSync(join(source, ".bin"))) {
    await linkPackage(nodeModules, ".bin", join(source, ".bin"));
  }
}

export const SIMPLE_SOURCE = {
  "src/cli.ts": [
    "export function main(): string {",
    '  return "ok";',
    "}",
    "",
  ].join("\n"),
  "tests/cli.test.ts": [
    'import { expect, test } from "bun:test";',
    'import { main } from "../src/cli.ts";',
    "",
    'test("returns the stable greeting", () => {',
    '  expect(main()).toBe("ok");',
    "});",
    "",
  ].join("\n"),
};

export const COMPLEX_SOURCE = {
  "src/command-contract.ts": [
    'import { z } from "zod";',
    "",
    'export const commandSchema = z.object({ kind: z.literal("help") });',
    'export type Command = { kind: "help" };',
    "",
  ].join("\n"),
  "src/model.ts": [
    'import type { Command } from "./command-contract.ts";',
    "",
    "type Model = { command: Command };",
    "",
    "export function makeModel(command: Command): Model {",
    "  return { command };",
    "}",
    "",
  ].join("\n"),
  "src/engine.ts": [
    'import { makeModel } from "./model.ts";',
    'import type { Command } from "./command-contract.ts";',
    "",
    "export function execute(command: Command): string {",
    "  return makeModel(command).command.kind;",
    "}",
    "",
  ].join("\n"),
  "src/journal.ts": [
    'import type { Command } from "./command-contract.ts";',
    "",
    "export function journalCommand(command: Command): Command {",
    "  return command;",
    "}",
    "",
  ].join("\n"),
  "src/process-lifecycle.ts": [
    'import type { Command } from "./command-contract.ts";',
    'import { journalCommand } from "./journal.ts";',
    "",
    "export function lifecycleCommand(command: Command): Command {",
    "  return journalCommand(command);",
    "}",
    "",
  ].join("\n"),
  "src/runtime.ts": [
    'import { spawn } from "node:child_process";',
    'import type { Command } from "./command-contract.ts";',
    'import { lifecycleCommand } from "./process-lifecycle.ts";',
    "",
    "export function runtimeName(command: Command): string {",
    "  void spawn;",
    "  return lifecycleCommand(command).kind;",
    "}",
    "",
  ].join("\n"),
  "src/branch-station-catalog.ts": [
    'import type { Command } from "./command-contract.ts";',
    "",
    'const stations = ["central"] as const;',
    "",
    "export function catalogFor(command: Command): string {",
    '  return command.kind + ":" + stations[0];',
    "}",
    "",
  ].join("\n"),
  "src/diagnostics.ts": [
    'import { getLogger } from "@logtape/logtape";',
    'import { redactByPattern } from "@logtape/redaction";',
    "",
    "export function diagnosticsReady(): boolean {",
    "  return (",
    '    typeof getLogger === "function" && typeof redactByPattern === "function"',
    "  );",
    "}",
    "",
  ].join("\n"),
  "src/cli.ts": [
    'import { catalogFor } from "./branch-station-catalog.ts";',
    'import { commandSchema, type Command } from "./command-contract.ts";',
    'import { diagnosticsReady } from "./diagnostics.ts";',
    'import { execute } from "./engine.ts";',
    'import { makeModel } from "./model.ts";',
    'import { runtimeName } from "./runtime.ts";',
    "",
    "export function main(): string {",
    '  const command: Command = commandSchema.parse({ kind: "help" });',
    "  const model = makeModel(command);",
    "  const message = [",
    "    execute(command),",
    "    model.command.kind,",
    "    runtimeName(command),",
    "    catalogFor(command),",
    "    String(diagnosticsReady()),",
    '  ].join("|");',
    "  console.log(message);",
    "  return message;",
    "}",
    "",
  ].join("\n"),
  "tests/unit/unit.test.ts": [
    'import { expect, test } from "bun:test";',
    'import { main } from "../../src/cli.ts";',
    "",
    'test("front door composes the complex path", () => {',
    '  expect(main()).toContain("help");',
    "});",
    "",
  ].join("\n"),
  "tests/integration/integration.test.ts": [
    'import { expect, test } from "bun:test";',
    'import { execute } from "../../src/engine.ts";',
    'import { runtimeName } from "../../src/runtime.ts";',
    "",
    'test("engine and runtime share the contract", () => {',
    '  const command = { kind: "help" as const };',
    '  expect(execute(command)).toBe("help");',
    '  expect(runtimeName(command)).toBe("help");',
    "});",
    "",
  ].join("\n"),
  "tests/catalog/catalog.test.ts": [
    'import { expect, test } from "bun:test";',
    'import { catalogFor } from "../../src/branch-station-catalog.ts";',
    'import { diagnosticsReady } from "../../src/diagnostics.ts";',
    "",
    'test("catalog and diagnostics remain available", () => {',
    '  expect(catalogFor({ kind: "help" })).toBe("help:central");',
    "  expect(diagnosticsReady()).toBe(true);",
    "});",
    "",
  ].join("\n"),
};

async function createProject(
  profile: Profile,
  temporaryRoots: string[],
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cds-ts2-static-admission-"));
  temporaryRoots.push(root);
  await copyTree(join(STATIC_PACKET, profile), root);
  copyRuleFiles(root);

  const packagePath = join(root, "package.json");
  const packageJson = await readJson(packagePath);
  packageJson.name = "cds-ts2-" + profile + "-fixture";
  await writeJson(packagePath, packageJson);

  const source = profile === "simple" ? SIMPLE_SOURCE : COMPLEX_SOURCE;
  for (const [relativePath, contents] of Object.entries(source)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents);
  }
  await linkDependencies(root, profile);
  await gitAsync(root, "init", "-q", "-b", "main");
  const files = await gitAsync(
    root,
    "ls-files",
    "--others",
    "--modified",
    "--exclude-standard",
  );
  await gitAsync(
    root,
    "add",
    "--",
    ...files.trim().split("\n").filter(Boolean),
  );
  await gitAsync(
    root,
    "-c",
    "user.name=CDS-TS-2 fixture",
    "-c",
    "user.email=cds-ts2@example.invalid",
    "commit",
    "-qm",
    "baseline",
  );
  return root;
}

export function createProjectFixture(
  retainedRoots: ReadonlySet<string> = new Set<string>(),
): (profile: Profile) => Promise<string> {
  const temporaryRoots: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporaryRoots
        .splice(0)
        .flatMap((root) =>
          retainedRoots.has(root)
            ? []
            : [rm(root, { force: true, recursive: true })],
        ),
    );
  }, 120_000);
  return (profile) => createProject(profile, temporaryRoots);
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export async function hashProjectFiles(
  root: string,
): Promise<Record<string, string>> {
  const hashes: Record<string, string> = {};

  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.name === ".git" || entry.name === "node_modules") continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const relativePath = relative(root, path).split("/").join("/");
        hashes[relativePath] = sha256(await readFile(path));
      }
    }
  }

  await visit(root);
  return Object.fromEntries(
    Object.entries(hashes).sort(([left], [right]) => left.localeCompare(right)),
  );
}

export async function runAdmission(
  root: string,
  profile: Profile,
  environment: Record<string, string> = {},
): Promise<{
  invocation: Invocation;
  result: AdmissionResult;
  evidence: string;
}> {
  const captureRoot =
    process.env.STATIC_ADMISSION_CAPTURE_DIR ??
    join(tmpdir(), "cds-ts2-admission-evidence");
  await mkdir(captureRoot, { recursive: true });
  const evidence = await mkdtemp(join(captureRoot, "admission-"));
  const invocation = await runNative(
    ROOT,
    process.execPath,
    ["run", "src/static-admission.ts", root, profile, evidence],
    environment,
  );
  await writeJson(join(evidence, "process.json"), invocation);
  const result = JSON.parse(invocation.stdout) as AdmissionResult;
  return { invocation, result, evidence };
}

export async function makeTypeOnlyDependency(root: string): Promise<void> {
  await writeFile(
    join(root, "src/command-contract.ts"),
    [
      'import type { ZodType } from "zod";',
      "",
      'export type Command = { kind: "help" };',
      "const schemaType: ZodType<Command> | undefined = undefined;",
      "void schemaType;",
      "export const commandSchema = {",
      "  parse(input: unknown): Command {",
      "    if (",
      '      typeof input === "object" &&',
      "      input !== null &&",
      '      Object.hasOwn(input, "kind") &&',
      '      Reflect.get(input, "kind") === "help"',
      "    )",
      '      return { kind: "help" };',
      '    throw new Error("invalid command");',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

export interface AdmissionResult {
  status: string;
  cause?: string;
  authoredFiles?: string[];
  wholeSemantic?: string;
  productionSemantic?: string;
}
