import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  delimiter,
  dirname,
  join,
  relative,
  resolve,
} from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const TOOL_WORKTREE = resolve(ROOT, "../bun-typescript-template-integration");
const STATIC_PACKET = resolve(ROOT, "profiles/static-admission");
const TEMPORARY_ROOTS: string[] = [];
const RETAINED_ROOTS = new Set<string>();

const CAPTURE_ENVIRONMENT_NAMES = [
  "FORCE_COLOR",
  "NO_COLOR",
  "TMPDIR",
  "PWD",
  "INIT_CWD",
  "STATIC_ADMISSION_CAPTURE_DIR",
  "STATIC_ADMISSION_FOCUS",
  "STATIC_ADMISSION_TOOL_ROOT",
  "STATIC_ADMISSION_NODE_MODULES",
  "BUN_INSTALL_CACHE_DIR",
  "FALLOW_CHANGED_SINCE",
  "FALLOW_DIFF_FILE",
  "FALLOW_EXTRA_ARGS",
  "FALLOW_PRODUCTION",
  "FALLOW_PRODUCTION_DEAD_CODE",
  "FALLOW_PRODUCTION_HEALTH",
  "FALLOW_PRODUCTION_DUPES",
  "FALLOW_MAX_FILE_SIZE",
  "FALLOW_TYPE_AWARE",
  "FALLOW_FORMAT",
  "FALLOW_QUIET",
  "FALLOW_ROOT",
  "FALLOW_CACHE_DIR",
  "FALLOW_CACHE_MAX_SIZE",
  "FALLOW_TYPE_AWARE_BIN",
  "FALLOW_SUGGESTIONS",
  "FALLOW_UPDATE_CHECK",
  "FALLOW_COMMAND",
  "FALLOW_FAIL_ON_ISSUES",
] as const;

type Profile = "simple" | "complex";

interface Invocation {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function nativeEnvironment(): Record<string, string | undefined> {
  return {
    ...process.env,
    FORCE_COLOR: "0",
    NO_COLOR: "1",
  };
}

const EXPECTED_COMPILER_OPTIONS: Record<string, unknown> = {
  target: "esnext",
  lib: ["esnext", "dom"],
  module: "preserve",
  moduleDetection: "force",
  moduleResolution: "bundler",
  allowImportingTsExtensions: true,
  verbatimModuleSyntax: true,
  noEmit: true,
  strict: true,
  exactOptionalPropertyTypes: true,
  noImplicitReturns: true,
  skipLibCheck: true,
  noFallthroughCasesInSwitch: true,
  noUncheckedIndexedAccess: true,
  noUncheckedSideEffectImports: true,
  noImplicitOverride: true,
  resolveJsonModule: true,
  types: ["bun"],
};

const EXPECTED_FILES: Record<Profile, string[]> = {
  simple: ["src/cli.ts", "tests/cli.test.ts"],
  complex: [
    "src/branch-station-catalog.ts",
    "src/cli.ts",
    "src/command-contract.ts",
    "src/diagnostics.ts",
    "src/engine.ts",
    "src/model.ts",
    "src/runtime.ts",
    "tests/catalog/catalog.test.ts",
    "tests/integration/integration.test.ts",
    "tests/unit/unit.test.ts",
  ],
};

const EXPECTED_SCRIPTS = {
  start: "bun run src/cli.ts",
  biome: "biome check --diagnostic-level=error .",
  config: "tsc --showConfig -p tsconfig.json",
  typecheck: "tsc --noEmit -p tsconfig.json",
  test: "bun test",
  quality:
    "node_modules/.bin/fallow dead-code --format json --quiet --type-aware --type-aware-require complete --fail-on-issues",
  dependencies:
    "node_modules/.bin/fallow dead-code --production --format json --quiet --type-aware --type-aware-require complete --fail-on-issues",
  changed:
    "node_modules/.bin/fallow audit --format json --quiet --gate all --type-aware --type-aware-require complete",
};

const EXPECTED_DEPENDENCY_PINS: Record<
  Profile,
  {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }
> = {
  simple: {
    dependencies: {},
    devDependencies: {
      "@biomejs/biome": "2.4.15",
      "@types/bun": "1.4.0",
      fallow: "3.19.0",
      typescript: "7.0.2",
    },
  },
  complex: {
    dependencies: {
      "@logtape/logtape": "2.3.1",
      "@logtape/redaction": "2.3.1",
      zod: "4.4.3",
    },
    devDependencies: {
      "@biomejs/biome": "2.4.15",
      "@types/bun": "1.4.0",
      fallow: "3.19.0",
      typescript: "7.0.2",
    },
  },
};

const SELECTED_FALLOW_RULES = [
  "unused-files",
  "unused-exports",
  "unused-types",
  "unused-dependencies",
  "unlisted-dependencies",
  "unresolved-imports",
  "dev-dependencies-in-production",
  "type-only-dependencies",
  "test-only-dependencies",
  "circular-dependencies",
  "re-export-cycle",
  "boundary-violation",
  "require-suppression-reason",
  "stale-suppressions",
] as const;

const OFF_FALLOW_RULES = [
  "private-type-leaks",
  "unused-dev-dependencies",
  "unused-optional-dependencies",
  "unused-enum-members",
  "unused-class-members",
  "unused-store-members",
  "unprovided-injects",
  "unrendered-components",
  "unused-component-props",
  "unused-component-emits",
  "unused-component-inputs",
  "unused-component-outputs",
  "unused-svelte-events",
  "unused-server-actions",
  "unused-load-data-keys",
  "prop-drilling",
  "thin-wrapper",
  "duplicate-prop-shape",
  "css-token-drift",
  "css-duplicate-block",
  "css-selector-complexity",
  "css-dead-surface",
  "css-broken-reference",
  "duplicate-exports",
  "coverage-gaps",
  "feature-flags",
  "unused-catalog-entries",
  "empty-catalog-groups",
  "unresolved-catalog-references",
  "unused-dependency-overrides",
  "misconfigured-dependency-overrides",
  "security-client-server-leak",
  "security-sink",
  "policy-violation",
  "invalid-client-export",
  "mixed-client-server-barrel",
  "misplaced-directive",
  "route-collision",
  "dynamic-segment-name-conflict",
] as const;

const EXPECTED_BOUNDARIES: Record<Profile, Record<string, unknown>> = {
  simple: {
    zones: [
      { name: "front-door", patterns: ["src/cli.ts"] },
      { name: "tests", patterns: ["tests/**/*.ts"] },
    ],
    rules: [
      { from: "front-door", allow: [] },
      { from: "tests", allow: ["front-door"] },
    ],
    coverage: { requireAllFiles: true },
  },
  complex: {
    zones: [
      { name: "front-door", patterns: ["src/cli.ts"] },
      {
        name: "contract",
        patterns: ["src/command-contract.ts", "src/model.ts"],
      },
      { name: "engine", patterns: ["src/engine.ts"] },
      { name: "runtime", patterns: ["src/runtime.ts"] },
      { name: "catalog", patterns: ["src/branch-station-catalog.ts"] },
      { name: "diagnostics", patterns: ["src/diagnostics.ts"] },
      { name: "unit-tests", patterns: ["tests/unit/**/*.ts"] },
      { name: "integration-tests", patterns: ["tests/integration/**/*.ts"] },
      { name: "catalog-tests", patterns: ["tests/catalog/**/*.ts"] },
    ],
    rules: [
      {
        from: "front-door",
        allow: ["contract", "engine", "runtime", "catalog", "diagnostics"],
      },
      { from: "contract", allow: [] },
      { from: "engine", allow: ["contract"] },
      { from: "runtime", allow: ["contract"] },
      { from: "catalog", allow: ["contract"] },
      { from: "diagnostics", allow: ["contract"] },
      {
        from: "unit-tests",
        allow: ["front-door", "contract", "engine", "catalog"],
      },
      {
        from: "integration-tests",
        allow: [
          "front-door",
          "contract",
          "engine",
          "runtime",
          "catalog",
          "diagnostics",
        ],
      },
      {
        from: "catalog-tests",
        allow: [
          "front-door",
          "contract",
          "engine",
          "runtime",
          "catalog",
          "diagnostics",
        ],
      },
    ],
    coverage: { requireAllFiles: true },
  },
};

function runNative(
  cwd: string,
  command: string,
  args: string[],
  environment: Record<string, string> = {},
): Invocation {
  const result = Bun.spawnSync([command, ...args], {
    cwd,
    env: { ...nativeEnvironment(), ...environment },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function git(cwd: string, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], {
    cwd,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
    stderr: "pipe",
    stdin: "ignore",
    stdout: "pipe",
  });
  if (result.exitCode !== 0) {
    throw new Error(
      "git " + args.join(" ") + " failed:\n" + result.stderr.toString(),
    );
  }
  return result.stdout.toString();
}

function toolPath(name: string): string {
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

const BIOME = toolPath("biome");

type FallowPass = "whole-project" | "production-dependencies";

function fallowDeadCodeArgs(pass: FallowPass = "whole-project"): string[] {
  return [
    "dead-code",
    ...(pass === "production-dependencies" ? ["--production"] : []),
    "--format",
    "json",
    "--quiet",
    "--type-aware",
    "--type-aware-require",
    "complete",
    "--fail-on-issues",
  ];
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value, null, 2) + "\n");
}

async function readJson(path: string): Promise<Record<string, unknown>> {
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

function installRuntimeDependencies(root: string): void {
  const args = ["install", "--production", "--frozen-lockfile"];
  const invocation = runNative(root, process.execPath, args);
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

  if (profile === "complex") installRuntimeDependencies(root);

  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === ".bin") continue;
    await linkPackage(nodeModules, entry.name, join(source, entry.name));
  }
  if (existsSync(join(source, ".bin"))) {
    await linkPackage(nodeModules, ".bin", join(source, ".bin"));
  }
}

const SIMPLE_SOURCE = {
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

const COMPLEX_SOURCE = {
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
  "src/runtime.ts": [
    'import { spawn } from "node:child_process";',
    'import type { Command } from "./command-contract.ts";',
    "",
    "export function runtimeName(command: Command): string {",
    "  void spawn;",
    "  return command.kind;",
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
    '  return typeof getLogger === "function" && typeof redactByPattern === "function";',
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

async function createProject(profile: Profile): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cds-ts2-static-admission-"));
  TEMPORARY_ROOTS.push(root);
  await copyTree(join(STATIC_PACKET, profile), root);

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
  git(root, "init", "-q", "-b", "main");
  git(root, "add", ".");
  git(
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

function assertCompilerDocument(
  root: string,
  profile: Profile,
  document: Record<string, unknown>,
): void {
  const compilerOptions = document.compilerOptions as Record<string, unknown>;
  for (const [option, expected] of Object.entries(EXPECTED_COMPILER_OPTIONS)) {
    expect(compilerOptions[option]).toEqual(expected);
  }

  const files = (document.files as string[])
    .map((path) =>
      (path.startsWith("/") ? relative(root, path) : path)
        .replace(/^\.\//, "")
        .split("/")
        .join("/"),
    )
    .sort();
  expect(files).toEqual([...EXPECTED_FILES[profile]].sort());
}

function requiredBiomeOverride(
  overrides: Array<Record<string, unknown>>,
  index: number,
): Record<string, unknown> {
  const override = overrides[index];
  if (override === undefined) {
    throw new Error(`Biome override ${index} is missing`);
  }
  return override;
}

async function assertLockPolicy(
  root: string,
  expectedPins: (typeof EXPECTED_DEPENDENCY_PINS)[Profile],
): Promise<void> {
  const lock = Bun.JSONC.parse(
    await Bun.file(join(root, "bun.lock")).text(),
  ) as Record<string, unknown>;
  expect(lock.lockfileVersion).toBe(2);
  const workspaces = lock.workspaces as Record<string, unknown>;
  const workspace = workspaces[""] as Record<string, unknown> | undefined;
  if (workspace === undefined) {
    throw new Error("bun.lock is missing the root workspace record");
  }
  expect(workspace.dependencies ?? {}).toEqual(expectedPins.dependencies);
  expect(workspace.devDependencies).toEqual(expectedPins.devDependencies);

  const packages = lock.packages as Record<string, unknown>;
  for (const [packageName, version] of Object.entries({
    ...expectedPins.dependencies,
    ...expectedPins.devDependencies,
  })) {
    const resolved = packages[packageName];
    if (!Array.isArray(resolved)) {
      throw new Error(`bun.lock is missing ${packageName}'s resolved record`);
    }
    expect(resolved[0]).toBe(`${packageName}@${version}`);
  }
}

async function assertPacketPolicy(
  root: string,
  profile: Profile,
): Promise<void> {
  const packageJson = await readJson(join(root, "package.json"));
  const expectedPins = EXPECTED_DEPENDENCY_PINS[profile];
  expect(packageJson.packageManager).toBe("bun@1.4.0");
  expect(packageJson.scripts).toEqual({
    start: EXPECTED_SCRIPTS.start,
    "biome:check": EXPECTED_SCRIPTS.biome,
    "check:config": EXPECTED_SCRIPTS.config,
    typecheck: EXPECTED_SCRIPTS.typecheck,
    test: EXPECTED_SCRIPTS.test,
    "quality:fallow": EXPECTED_SCRIPTS.quality,
    "quality:fallow:changed": EXPECTED_SCRIPTS.changed,
    "quality:fallow:dependencies": EXPECTED_SCRIPTS.dependencies,
    check:
      "bun run biome:check && bun run typecheck && bun run test && bun run --silent quality:fallow && bun run --silent quality:fallow:dependencies",
  });
  expect(packageJson.dependencies ?? {}).toEqual(expectedPins.dependencies);
  expect(packageJson.devDependencies).toEqual(expectedPins.devDependencies);
  await assertLockPolicy(root, expectedPins);

  const tsconfig = await readJson(join(root, "tsconfig.json"));
  expect(tsconfig.include).toEqual(["src/**/*.ts", "tests/**/*.ts"]);
  const base = await readJson(join(root, "tsconfig.base.json"));
  expect(base.compilerOptions).toEqual({
    target: "ESNext",
    lib: ["ESNext", "DOM"],
    module: "Preserve",
    moduleDetection: "force",
    moduleResolution: "bundler",
    allowImportingTsExtensions: true,
    verbatimModuleSyntax: true,
    noEmit: true,
    strict: true,
    exactOptionalPropertyTypes: true,
    noImplicitReturns: true,
    skipLibCheck: true,
    noFallthroughCasesInSwitch: true,
    noUncheckedIndexedAccess: true,
    noUncheckedSideEffectImports: true,
    noImplicitOverride: true,
    resolveJsonModule: true,
    types: ["bun"],
  });

  const biome = await readJson(join(root, "biome.json"));
  const biomeFiles = (biome.files as Record<string, unknown>).includes;
  expect(biomeFiles).toEqual(["src/**/*.ts", "tests/**/*.ts"]);
  const linter = biome.linter as Record<string, unknown>;
  const lintRules = linter.rules as Record<string, unknown>;
  expect(lintRules.recommended).toBe(true);
  expect(
    (lintRules.correctness as Record<string, unknown>).noUndeclaredDependencies,
  ).toBe("error");
  expect((lintRules.suspicious as Record<string, unknown>).noConsole).toBe(
    "error",
  );
  expect((lintRules.suspicious as Record<string, unknown>).noExplicitAny).toBe(
    "error",
  );
  expect((lintRules.style as Record<string, unknown>).noNonNullAssertion).toBe(
    "error",
  );
  const overrides = biome.overrides as Array<Record<string, unknown>>;
  const frontDoorOverride = requiredBiomeOverride(overrides, 0);
  expect(frontDoorOverride.includes).toEqual(["src/cli.ts"]);
  const outputRules = (
    (frontDoorOverride.linter as Record<string, unknown>).rules as Record<
      string,
      unknown
    >
  ).suspicious as Record<string, unknown>;
  expect(outputRules.noConsole).toEqual({
    level: "error",
    options: { allow: ["log"] },
  });

  if (profile === "simple") {
    const restricted = (lintRules.style as Record<string, unknown>)
      .noRestrictedImports as Record<string, unknown>;
    expect(restricted.level).toBe("error");
    expect(restricted.options).toEqual({
      paths: {
        "node:child_process": {
          message: "Simple commands may not spawn subprocesses.",
        },
      },
      patterns: [
        {
          group: ["@logtape/*"],
          message: "Simple commands may not depend on LogTape.",
        },
      ],
    });
    expect(overrides).toHaveLength(1);
  } else {
    expect(overrides).toHaveLength(4);
    expect(requiredBiomeOverride(overrides, 1).includes).toEqual([
      "src/**/*.ts",
      "tests/**/*.ts",
      "!src/runtime.ts",
      "!src/diagnostics.ts",
    ]);
    expect(requiredBiomeOverride(overrides, 2).includes).toEqual([
      "src/runtime.ts",
    ]);
    expect(requiredBiomeOverride(overrides, 3).includes).toEqual([
      "src/diagnostics.ts",
    ]);
  }

  const fallow = await readJson(join(root, ".fallowrc.json"));
  expect(fallow.entry).toEqual(
    profile === "simple"
      ? ["src/cli.ts", "tests/cli.test.ts"]
      : [
          "src/cli.ts",
          "tests/unit/**/*.test.ts",
          "tests/integration/**/*.test.ts",
          "tests/catalog/**/*.test.ts",
        ],
  );
  expect(fallow.typeAware).toEqual({
    enabled: true,
    projects: ["tsconfig.json"],
    require: "complete",
  });
  expect(fallow.audit).toEqual({
    gate: "all",
    css: false,
    cssDeep: false,
  });
  expect(fallow.boundaries).toEqual(EXPECTED_BOUNDARIES[profile]);

  const rules = fallow.rules as Record<string, unknown>;
  expect(Object.keys(rules).sort()).toEqual(
    [...SELECTED_FALLOW_RULES, ...OFF_FALLOW_RULES].sort(),
  );
  for (const rule of SELECTED_FALLOW_RULES) {
    expect(rules[rule]).toBe("error");
  }
  for (const rule of OFF_FALLOW_RULES) {
    expect(rules[rule]).toBe("off");
  }
}

async function runBiome(root: string): Promise<Invocation> {
  const args = ["check", "--diagnostic-level=error", "."];
  const fileHashes = await hashProjectFiles(root);
  const invocation = runNative(root, BIOME, args);
  const captureDirectory = process.env.STATIC_ADMISSION_CAPTURE_DIR;
  if (captureDirectory) {
    await mkdir(captureDirectory, { recursive: true });
    await writeJson(join(captureDirectory, `biome-${basename(root)}.json`), {
      argv: [BIOME, ...args],
      cwd: root,
      fileHashes,
      ...invocation,
    });
  }
  return invocation;
}

function parseFallowDocument(invocation: Invocation): Record<string, unknown> {
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(invocation.stdout) as Record<string, unknown>;
  } catch (cause) {
    throw new Error(
      "Fallow produced non-JSON stdout.\nstdout:\n" +
        invocation.stdout +
        "\nstderr:\n" +
        invocation.stderr,
      { cause },
    );
  }
  return document;
}

interface FallowCapture {
  postManifestPath: string;
  preManifest: Record<string, unknown>;
  preManifestPath: string;
  stderrPath: string;
  stdoutPath: string;
}

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function realpathOrOriginal(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

async function hashProjectFiles(root: string): Promise<Record<string, string>> {
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

async function describeNodeModules(
  root: string,
): Promise<Record<string, string>> {
  const directory = join(root, "node_modules");
  if (!existsSync(directory)) return {};
  const entries: Record<string, string> = {};
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    entries[entry.name] = entry.isSymbolicLink()
      ? await realpathOrOriginal(path)
      : entry.isDirectory()
        ? "directory"
        : "file";
  }
  return Object.fromEntries(
    Object.entries(entries).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

function captureNativeEnvironment(): Record<string, string> {
  const environment = nativeEnvironment();
  return Object.fromEntries(
    CAPTURE_ENVIRONMENT_NAMES.map((name) => [
      name,
      environment[name] ?? "<unset>",
    ]),
  );
}

async function prepareFallowCapture(
  root: string,
  args: string[],
  expectedRules: Record<string, number | FallowRuleExpectation>,
): Promise<FallowCapture | null> {
  const configuredDirectory = process.env.STATIC_ADMISSION_CAPTURE_DIR;
  if (!configuredDirectory) return null;

  const captureDirectory = resolve(configuredDirectory);
  await mkdir(captureDirectory, { recursive: true });
  const label = `fallow-${basename(root)}`;
  const preManifestPath = join(captureDirectory, `${label}.pre-native.json`);
  const postManifestPath = join(captureDirectory, `${label}.post-native.json`);
  const stdoutPath = join(captureDirectory, `${label}.native.stdout`);
  const stderrPath = join(captureDirectory, `${label}.native.stderr`);
  const fileHashes = await hashProjectFiles(root);
  const configNames = new Set([
    ".fallowrc.json",
    ".gitignore",
    "biome.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "tsconfig.base.json",
    "tsconfig.json",
  ]);
  const configHashes = Object.fromEntries(
    Object.entries(fileHashes).filter(([path]) => configNames.has(path)),
  );
  const preManifest = {
    captureKind:
      "focused-native-fallow-preflight-summary-not-byte-exact-envelope",
    capturePhase: "before-native-invocation",
    fixture: {
      root,
      rootRealpath: await realpathOrOriginal(root),
      processCwd: process.cwd(),
      osTmpdir: tmpdir(),
      envTmpdir: process.env.TMPDIR ?? "<unset>",
      projectFilesBeforeNative: Object.keys(fileHashes),
      fileHashes,
      configHashes,
      nodeModules: await describeNodeModules(root),
      gitHead: git(root, "rev-parse", "HEAD").trim(),
      gitStatus: git(root, "status", "--porcelain=v1").trim(),
    },
    expectedRuleCounts: Object.fromEntries(
      Object.entries(expectedRules).map(([rule, expectation]) => [
        rule,
        typeof expectation === "number" ? expectation : expectation.count,
      ]),
    ),
    native: {
      executable: "node_modules/.bin/fallow",
      executableRealpath: await realpathOrOriginal(
        join(root, "node_modules/.bin/fallow"),
      ),
      argv: args,
      cwd: root,
      environment: captureNativeEnvironment(),
      rawStdoutPath: stdoutPath,
      rawStderrPath: stderrPath,
    },
  } satisfies Record<string, unknown>;
  await writeJson(preManifestPath, preManifest);
  RETAINED_ROOTS.add(root);
  return {
    postManifestPath,
    preManifest,
    preManifestPath,
    stderrPath,
    stdoutPath,
  };
}

interface NativeCaptureResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
}

function nativeCaptureResult(
  invocation: Invocation | null,
): NativeCaptureResult {
  if (invocation === null) {
    return { exitCode: null, stderr: "", stdout: "" };
  }
  return {
    exitCode: invocation.exitCode,
    stderr: invocation.stderr,
    stdout: invocation.stdout,
  };
}

function describeCaptureFailure(
  failure: unknown,
): null | Record<string, string> | string {
  if (failure instanceof Error) {
    return { name: failure.name, message: failure.message };
  }
  if (failure === undefined) return null;
  return String(failure);
}

async function finishFallowCapture(
  capture: FallowCapture | null,
  invocation: Invocation | null,
  failure?: unknown,
): Promise<void> {
  if (!capture) return;
  const result = nativeCaptureResult(invocation);
  await writeFile(capture.stdoutPath, result.stdout);
  await writeFile(capture.stderrPath, result.stderr);
  await writeJson(capture.postManifestPath, {
    ...capture.preManifest,
    capturePhase: "after-native-invocation",
    nativeResult: {
      exitCode: result.exitCode,
      stdoutSha256: sha256(result.stdout),
      stderrSha256: sha256(result.stderr),
    },
    failure: describeCaptureFailure(failure),
  });
}

function assertRequiredSemanticEvidence(
  document: Record<string, unknown>,
): void {
  const meta = document._meta as Record<string, unknown> | undefined;
  const typeAware = meta?.type_aware as Record<string, unknown> | undefined;
  if (!typeAware) {
    throw new Error(
      "Native Fallow semantic evidence missing: _meta.type_aware",
    );
  }
  expect(typeAware.required_completeness).toBe("complete");
  const identity = typeAware.identity as Record<string, unknown> | undefined;
  expect(identity?.completeness).toBe("complete");
  if (typeAware.executed === false) {
    assertUnnecessarySemanticEvidence(typeAware, identity);
  } else {
    assertExecutedSemanticEvidence(typeAware);
  }
}

function assertUnnecessarySemanticEvidence(
  typeAware: Record<string, unknown>,
  identity: Record<string, unknown> | undefined,
): void {
  expect(identity?.project_config_hash).toBe("deferred:no-semantic-queries");
  expect(typeAware.candidate_count).toBe(0);
  expect(typeAware.queries ?? []).toEqual([]);
}

function assertExecutedSemanticEvidence(
  typeAware: Record<string, unknown>,
): void {
  expect(typeAware.executed).toBe(true);
  expect(typeAware.selected_tsconfigs).not.toEqual([]);
  const queries = typeAware.queries as
    | Array<Record<string, unknown>>
    | undefined;
  if (!queries?.length) throw new Error("Native Fallow query results missing");
  for (const query of queries) expect(query.status).toBe("complete");
}

function assertExpectedFallowRuleCounts(
  document: Record<string, unknown>,
  expectedRules: Record<string, number | FallowRuleExpectation>,
): void {
  const summary = document.summary as Record<string, unknown> | undefined;
  for (const [rule, expectation] of Object.entries(expectedRules)) {
    const expectedCount =
      typeof expectation === "number" ? expectation : expectation.count;
    if (expectedCount <= 0) {
      throw new Error(`Expected a positive native count for ${rule}`);
    }
    const actualCount = summary?.[rule];
    expect(actualCount).toBe(expectedCount);
    const findings = document[rule];
    expect(Array.isArray(findings)).toBe(true);
    const findingList = findings as unknown[] | undefined;
    expect(findingList?.length).toBe(expectedCount);
    if (typeof expectation !== "number" && expectation.matches) {
      expect(
        findingList?.some(
          (finding) =>
            typeof finding === "object" &&
            finding !== null &&
            !Array.isArray(finding) &&
            expectation.matches?.(finding as Record<string, unknown>),
        ),
      ).toBe(true);
    }
  }
}

interface FallowRuleExpectation {
  count: number;
  matches?: (finding: Record<string, unknown>) => boolean;
}

test("Fallow remaining canary: oracle rejects an unrelated finding for a zero rule", () => {
  const unrelatedFinding = {
    summary: { unused_exports: 0, boundary_violations: 1 },
    unused_exports: [],
    boundary_violations: [{ from_path: "src/engine.ts" }],
  };
  expect(() =>
    assertExpectedFallowRuleCounts(unrelatedFinding, { unused_exports: 0 }),
  ).toThrow();
});

async function assertFallowRefusal(
  root: string,
  expectedRules: Record<string, number | FallowRuleExpectation>,
  pass: FallowPass = "whole-project",
): Promise<void> {
  git(root, "add", ".");
  git(
    root,
    "-c",
    "user.name=CDS-TS-2 fixture",
    "-c",
    "user.email=cds-ts2@example.invalid",
    "commit",
    "-qm",
    "canary",
  );
  const args = fallowDeadCodeArgs(pass);
  const capture = await prepareFallowCapture(root, args, expectedRules);
  let invocation: Invocation | null = null;
  try {
    invocation = runNative(root, "node_modules/.bin/fallow", args);
    await finishFallowCapture(capture, invocation);
    const document = parseFallowDocument(invocation);
    if (invocation.exitCode === 0) {
      throw new Error(
        "Fallow canary unexpectedly passed:\n" +
          JSON.stringify(document, null, 2),
      );
    }
    expect(invocation.exitCode).not.toBe(0);
    assertExpectedFallowRuleCounts(document, expectedRules);
    assertRequiredSemanticEvidence(document);
    RETAINED_ROOTS.delete(root);
  } catch (cause) {
    if (capture && invocation === null) {
      await finishFallowCapture(capture, null, cause);
    }
    throw cause;
  }
}

interface AdmissionResult {
  status: string;
  cause?: string;
  authoredFiles?: string[];
  wholeSemantic?: string;
  productionSemantic?: string;
}

async function runAdmission(
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
  const invocation = runNative(
    ROOT,
    process.execPath,
    ["run", "src/static-admission.ts", root, profile, evidence],
    environment,
  );
  await writeJson(join(evidence, "process.json"), invocation);
  const result = JSON.parse(invocation.stdout) as AdmissionResult;
  return { invocation, result, evidence };
}

async function expectAdmissionRefusal(
  root: string,
  profile: Profile,
  cause: string,
): Promise<void> {
  const observed = await runAdmission(root, profile);
  expect(observed.invocation.stderr).toBe("");
  expect(observed.invocation.exitCode).toBe(1);
  expect(observed.result.status).toBe("refused");
  expect(observed.result.cause).toBe(cause);
}

test("admits simple and threshold-met complex projects through native gates", async () => {
  for (const profile of ["simple", "complex"] as const) {
    const root = await createProject(profile);
    await assertPacketPolicy(root, profile);
    const observed = await runAdmission(root, profile);
    expect(observed.result).toMatchObject({ status: "admitted" });
    expect(observed.invocation.exitCode).toBe(0);
    expect(observed.invocation.stderr).toBe("");
    expect(observed.result.authoredFiles).toEqual(EXPECTED_FILES[profile]);
    expect(observed.result.wholeSemantic).toBe("unnecessary");
    expect(observed.result.productionSemantic).toBe("unnecessary");
    const showConfig = await readJson(
      join(observed.evidence, "compiler-config.json"),
    );
    assertCompilerDocument(
      root,
      profile,
      JSON.parse(String(showConfig.stdout)) as Record<string, unknown>,
    );
  }
}, 120_000);

interface PolicyMutation {
  file: string;
  path: string[];
  cause: string;
  replacement?: unknown;
}

function compilerMutations(): PolicyMutation[] {
  // Independent Spec-owned option names, never read from the packet under test.
  return Object.keys(EXPECTED_COMPILER_OPTIONS).map((option) => ({
    file: "tsconfig.base.json",
    path: ["compilerOptions", option],
    cause: `policy:tsconfig.base.json.compilerOptions.${option}`,
  }));
}

function packageMutations(profile: Profile): PolicyMutation[] {
  const mutations: PolicyMutation[] = [
    {
      file: "package.json",
      path: ["packageManager"],
      cause: "policy:package.json.packageManager",
    },
    {
      file: "package.json",
      path: ["private"],
      replacement: false,
      cause: "policy:package.json.private",
    },
    {
      file: "package.json",
      path: ["type"],
      replacement: "commonjs",
      cause: "policy:package.json.type",
    },
  ];
  for (const group of ["dependencies", "devDependencies"] as const) {
    for (const name of Object.keys(EXPECTED_DEPENDENCY_PINS[profile][group])) {
      mutations.push(
        {
          file: "package.json",
          path: [group, name],
          cause: `policy:package.json.${group}.${name}`,
        },
        {
          file: "bun.lock",
          path: ["workspaces", "", group, name],
          cause: `policy:bun.lock.workspaces.root.${group}.${name}`,
        },
        {
          file: "bun.lock",
          path: ["packages", name],
          cause: `policy:bun.lock.packages.${name}`,
        },
      );
    }
  }
  return mutations;
}

function biomeMutations(profile: Profile): PolicyMutation[] {
  const mutations: PolicyMutation[] = [];
  for (const [group, rule] of [
    ["suspicious", "noConsole"],
    ["suspicious", "noExplicitAny"],
    ["style", "noNonNullAssertion"],
    ["correctness", "noUndeclaredDependencies"],
  ]) {
    if (!group || !rule) throw new Error("Independent Biome oracle incomplete");
    for (const replacement of [undefined, "warn"]) {
      mutations.push({
        file: "biome.json",
        path: ["linter", "rules", group, rule],
        replacement,
        cause: `policy:biome.json.linter.rules.${group}.${rule}`,
      });
    }
  }
  if (profile === "simple") {
    for (const replacement of [undefined, "warn"]) {
      mutations.push({
        file: "biome.json",
        path: ["linter", "rules", "style", "noRestrictedImports", "level"],
        replacement,
        cause: "policy:biome.json.linter.rules.style.noRestrictedImports.level",
      });
    }
  } else {
    // Overrides are an ordered native Biome resolution surface.
    for (const index of [1, 2, 3]) {
      for (const replacement of [undefined, "warn"])
        mutations.push({
          file: "biome.json",
          path: [
            "overrides",
            String(index),
            "linter",
            "rules",
            "style",
            "noRestrictedImports",
            "level",
          ],
          replacement,
          cause: "policy:biome.json.overrides",
        });
    }
  }
  mutations.push(
    {
      file: "biome.json",
      path: ["overrides", "0", "includes"],
      replacement: ["src/**/*.ts"],
      cause: "policy:biome.json.overrides",
    },
    {
      file: "biome.json",
      path: ["overrides", "0", "includes"],
      replacement: ["src/engine.ts"],
      cause: "policy:biome.json.overrides",
    },
    {
      file: "biome.json",
      path: ["files", "includes"],
      replacement: ["src/**/*.ts"],
      cause: "policy:biome.json.files.includes",
    },
  );
  return mutations;
}

function fallowMutations(): PolicyMutation[] {
  const mutations: PolicyMutation[] = [];
  for (const rule of SELECTED_FALLOW_RULES) {
    for (const replacement of [undefined, "off"])
      mutations.push({
        file: ".fallowrc.json",
        path: ["rules", rule],
        replacement,
        cause: `policy:.fallowrc.json.rules.${rule}`,
      });
  }
  mutations.push(
    {
      file: ".fallowrc.json",
      path: ["entry"],
      replacement: ["src/cli.ts"],
      cause: "policy:.fallowrc.json.entry",
    },
    {
      file: ".fallowrc.json",
      path: ["ignorePatterns"],
      replacement: ["src/**/*.ts"],
      cause: "policy:.fallowrc.json.ignorePatterns",
    },
    {
      file: ".fallowrc.json",
      path: ["boundaries", "coverage", "requireAllFiles"],
      replacement: false,
      cause: "policy:.fallowrc.json.boundaries.coverage.requireAllFiles",
    },
    {
      file: ".fallowrc.json",
      path: ["typeAware", "require"],
      replacement: "best-effort",
      cause: "policy:.fallowrc.json.typeAware.require",
    },
    {
      file: "package.json",
      path: ["scripts", "quality:fallow"],
      replacement:
        "node_modules/.bin/fallow audit --format json --quiet --gate new-only --type-aware --type-aware-require complete",
      cause: "policy:package.json.scripts.quality:fallow",
    },
    {
      file: "package.json",
      path: ["scripts", "quality:fallow"],
      replacement: EXPECTED_SCRIPTS.quality.replace(
        "require complete",
        "require best-effort",
      ),
      cause: "policy:package.json.scripts.quality:fallow",
    },
    {
      file: "package.json",
      path: ["scripts", "quality:fallow:dependencies"],
      replacement: EXPECTED_SCRIPTS.dependencies.replace(
        "require complete",
        "require best-effort",
      ),
      cause: "policy:package.json.scripts.quality:fallow:dependencies",
    },
  );
  return mutations;
}

async function mutatePolicy(
  root: string,
  mutation: PolicyMutation,
): Promise<void> {
  const path = join(root, mutation.file);
  const data = Bun.JSONC.parse(await Bun.file(path).text()) as Record<
    string,
    unknown
  >;
  let owner = data;
  const keys = [...mutation.path];
  const last = keys.pop();
  if (!last) throw new Error("Mutation missing final key");
  for (const key of keys) owner = owner[key] as Record<string, unknown>;
  if (mutation.replacement === undefined) delete owner[last];
  else owner[last] = mutation.replacement;
  await writeJson(path, data);
}

for (const profile of ["simple", "complex"] as const) {
  const groups = {
    compiler: compilerMutations(),
    packages: packageMutations(profile),
    biome: biomeMutations(profile),
    fallow: fallowMutations(),
    includes: [
      {
        file: "tsconfig.json",
        path: ["include"],
        replacement: ["src/**/*.ts"],
        cause: "policy:tsconfig.json.include",
      },
      {
        file: "tsconfig.json",
        path: ["include"],
        replacement: ["tests/**/*.ts"],
        cause: "policy:tsconfig.json.include",
      },
    ],
  };
  for (const [group, mutations] of Object.entries(groups)) {
    for (const [index, mutation] of mutations.entries()) {
      test(`admission weakening matrix: ${profile} ${group} ${index + 1} ${mutation.cause}`, async () => {
        const root = await createProject(profile);
        await mutatePolicy(root, mutation);
        await expectAdmissionRefusal(root, profile, mutation.cause);
      }, 120_000);
    }
  }
}

for (const profile of ["simple", "complex"] as const) {
  for (const excluded of EXPECTED_FILES[profile]) {
    test(`admission excludes no authored file: ${profile} ${excluded}`, async () => {
      const root = await createProject(profile);
      const config = await readJson(join(root, "tsconfig.json"));
      config.exclude = [excluded];
      await writeJson(join(root, "tsconfig.json"), config);
      await expectAdmissionRefusal(
        root,
        profile,
        "policy:tsconfig.json.exclude",
      );
    }, 120_000);
  }
  for (const contract of ["tsconfig.json", "tsconfig.base.json"]) {
    test(`admission requires type contract: ${profile} ${contract}`, async () => {
      const root = await createProject(profile);
      await rm(join(root, contract));
      await expectAdmissionRefusal(root, profile, `file:missing:${contract}`);
    }, 120_000);
  }
}

test("admission rejects an authored file outside the include owners", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "outside.ts"),
    "export type ContractLock = string;\n",
  );
  await expectAdmissionRefusal(
    root,
    "complex",
    "scope:outside-includes:outside.ts",
  );
}, 120_000);

test("aggregate admission refuses W alone and P alone", async () => {
  const wholeRoot = await createProject("complex");
  await writeFile(
    join(wholeRoot, "tests/unit/orphan.ts"),
    "export const orphan = true;\n",
  );
  const whole = await runAdmission(wholeRoot, "complex");
  expect(whole.result.cause).toBe("whole-project:findings");
  expect(whole.invocation.exitCode).toBe(1);
  const wholePasses = await readJson(join(whole.evidence, "passes.json"));
  expect((wholePasses.whole as Record<string, unknown>).exitCode).toBe(1);
  expect((wholePasses.production as Record<string, unknown>).exitCode).toBe(0);
  await rm(join(wholeRoot, "tests/unit/orphan.ts"));
  expect((await runAdmission(wholeRoot, "complex")).result.status).toBe(
    "admitted",
  );

  const productionRoot = await createProject("complex");
  await makeTypeOnlyDependency(productionRoot);
  const production = await runAdmission(productionRoot, "complex");
  expect(production.result.cause).toBe("production-dependencies:findings");
  expect(production.invocation.exitCode).toBe(1);
  const productionPasses = await readJson(
    join(production.evidence, "passes.json"),
  );
  expect((productionPasses.whole as Record<string, unknown>).exitCode).toBe(0);
  expect(
    (productionPasses.production as Record<string, unknown>).exitCode,
  ).toBe(1);
  await writeFile(
    join(productionRoot, "src/command-contract.ts"),
    COMPLEX_SOURCE["src/command-contract.ts"],
  );
  expect((await runAdmission(productionRoot, "complex")).result.status).toBe(
    "admitted",
  );
}, 120_000);

test("admission native semantic process refuses unavailable companion", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/model.ts"),
    COMPLEX_SOURCE["src/model.ts"] +
      "\nexport const semanticCandidate = true;\n",
  );
  const observed = await runAdmission(root, "complex", {
    FALLOW_TYPE_AWARE_BIN: join(root, "missing-semantic-companion"),
  });
  expect(observed.invocation.exitCode).toBe(1);
  expect(observed.result.cause).toBe("whole-project:native-error");
  const raw = await readJson(join(observed.evidence, "whole-project.json"));
  const report = JSON.parse(String(raw.stdout)) as Record<string, unknown>;
  expect(raw.exitCode).toBe(2);
  expect(report.error).toBe(true);
  expect(String(report.message)).toContain("FALLOW_TYPE_AWARE_BIN");
  expect(String(report.message)).toContain("no file exists there");
}, 120_000);

for (const completeness of ["unavailable", "partial"] as const) {
  test(`admission native semantic process refuses ${completeness} project evidence`, async () => {
    const root = await createProject("complex");
    await writeFile(
      join(root, "src/model.ts"),
      COMPLEX_SOURCE["src/model.ts"] +
        "\nexport const semanticCandidate = true;\n",
    );
    await writeJson(join(root, "tsconfig.semantic-canary.json"), {
      extends: "./tsconfig.json",
      compilerOptions: { module: "NodeNext", moduleResolution: "bundler" },
    });
    const observed = await runAdmission(root, "complex", {
      FALLOW_TYPE_AWARE_PROJECTS: (completeness === "partial"
        ? ["tsconfig.json", "tsconfig.semantic-canary.json"]
        : ["tsconfig.semantic-canary.json"]
      ).join(delimiter),
    });
    expect(observed.invocation.exitCode).toBe(1);
    expect(observed.result.cause).toBe("whole-project:semantic-incomplete");
    const raw = await readJson(join(observed.evidence, "whole-project.json"));
    const report = JSON.parse(String(raw.stdout)) as Record<string, unknown>;
    const semantic = (report._meta as Record<string, unknown>)
      .type_aware as Record<string, unknown>;
    expect((semantic.identity as Record<string, unknown>).completeness).toBe(
      completeness,
    );
  }, 120_000);
}

test("proves native Biome ownership canaries and complex exceptions", async () => {
  const allowed = await createProject("simple");
  await writeFile(
    join(allowed, "src/cli.ts"),
    [
      "export function main(): string {",
      '  console.log("human output");',
      '  return "ok";',
      "}",
      "",
    ].join("\n"),
  );
  const allowedResult = await runBiome(allowed);
  if (allowedResult.exitCode !== 0) {
    throw new Error(
      "Allowed output owner failed Biome.\nstdout:\n" +
        allowedResult.stdout +
        "\nstderr:\n" +
        allowedResult.stderr,
    );
  }

  const forbiddenConsole = await createProject("simple");
  await writeFile(
    join(forbiddenConsole, "src/other.ts"),
    'console.log("not the output owner");\n',
  );
  const forbiddenConsoleResult = await runBiome(forbiddenConsole);
  expect(forbiddenConsoleResult.exitCode).not.toBe(0);
  expect(
    forbiddenConsoleResult.stdout + forbiddenConsoleResult.stderr,
  ).toContain("noConsole");

  const explicitAny = await createProject("simple");
  await writeFile(
    join(explicitAny, "src/other.ts"),
    "export const unsafe: any = 1;\n",
  );
  const explicitAnyResult = await runBiome(explicitAny);
  expect(explicitAnyResult.exitCode).not.toBe(0);
  expect(explicitAnyResult.stdout + explicitAnyResult.stderr).toContain(
    "noExplicitAny",
  );

  const nonNull = await createProject("simple");
  await writeFile(
    join(nonNull, "src/other.ts"),
    [
      "const optional: string | undefined = undefined;",
      "export const unsafe = optional!;",
      "",
    ].join("\n"),
  );
  const nonNullResult = await runBiome(nonNull);
  expect(nonNullResult.exitCode).not.toBe(0);
  expect(nonNullResult.stdout + nonNullResult.stderr).toContain(
    "noNonNullAssertion",
  );

  const restricted = await createProject("simple");
  await writeFile(
    join(restricted, "src/other.ts"),
    [
      'import { spawn } from "node:child_process";',
      "export const unsafe = spawn;",
      "",
    ].join("\n"),
  );
  const restrictedResult = await runBiome(restricted);
  expect(restrictedResult.exitCode).not.toBe(0);
  expect(restrictedResult.stdout + restrictedResult.stderr).toContain(
    "noRestrictedImports",
  );

  const undeclared = await createProject("simple");
  await writeFile(
    join(undeclared, "src/other.ts"),
    [
      'import missing from "not-declared";',
      "export const unsafe = missing;",
      "",
    ].join("\n"),
  );
  const undeclaredResult = await runBiome(undeclared);
  expect(undeclaredResult.exitCode).not.toBe(0);
  expect(undeclaredResult.stdout + undeclaredResult.stderr).toContain(
    "noUndeclaredDependencies",
  );

  const complex = await createProject("complex");
  const complexResult = await runBiome(complex);
  expect(complexResult.exitCode).toBe(0);
}, 120_000);

for (const method of ["error", "warn"] as const) {
  test(`native Biome forbids owner console.${method}`, async () => {
    const root = await createProject("simple");
    await writeFile(
      join(root, "src/cli.ts"),
      SIMPLE_SOURCE["src/cli.ts"] +
        `\nconsole.${method}("forbidden output");\n`,
    );
    const result = await runBiome(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("noConsole");
  }, 120_000);
}

for (const specimen of [
  {
    file: "src/engine.ts",
    source: COMPLEX_SOURCE["src/engine.ts"],
    statement: 'import { spawn } from "node:child_process";\nvoid spawn;\n',
  },
  {
    file: "src/cli.ts",
    source: COMPLEX_SOURCE["src/cli.ts"],
    statement:
      'import { getLogger } from "@logtape/logtape";\nvoid getLogger;\n',
  },
]) {
  test(`native Biome forbids complex restricted import: ${specimen.file}`, async () => {
    const root = await createProject("complex");
    await writeFile(
      join(root, specimen.file),
      specimen.source + specimen.statement,
    );
    const result = await runBiome(root);
    expect(result.exitCode).toBe(1);
    expect(result.stdout + result.stderr).toContain("noRestrictedImports");
  }, 120_000);
}

test("native Fallow accepts a matching suppression with exact reason suffix", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    COMPLEX_SOURCE["src/engine.ts"] +
      '// fallow-ignore-next-line boundary-violation -- runtime edge is an intentional suppression specimen\nimport { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  const observed = await runAdmission(root, "complex");
  expect(observed.result.status).toBe("admitted");
  expect(observed.invocation.exitCode).toBe(0);
  for (const pass of ["whole-project", "production-dependencies"]) {
    const raw = await readJson(join(observed.evidence, `${pass}.json`));
    const report = JSON.parse(String(raw.stdout)) as Record<string, unknown>;
    expect((report.summary as Record<string, unknown>).stale_suppressions).toBe(
      0,
    );
    expect(
      (report.summary as Record<string, unknown>).boundary_violations,
    ).toBe(0);
    assertRequiredSemanticEvidence(report);
  }
}, 120_000);

test("runs isolated native Fallow reachability, dependency, graph and suppression canaries", async () => {
  const unusedFile = await createProject("simple");
  await writeFile(
    join(unusedFile, "src/orphan.ts"),
    "export const orphan = true;\n",
  );
  await assertFallowRefusal(unusedFile, { unused_files: 1 });
  if (process.env.STATIC_ADMISSION_FOCUS === "unused-file") return;
}, 120_000);

test("Fallow remaining canary: unused-exports", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/model.ts"),
    (await Bun.file(join(root, "src/model.ts")).text()) +
      "\nexport const unusedExport = true;\n",
  );
  await assertFallowRefusal(root, { unused_exports: 1 });
}, 120_000);

test("Fallow remaining canary: unused-types", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/model.ts"),
    (await Bun.file(join(root, "src/model.ts")).text()) +
      "\nexport type UnusedType = { value: string };\n",
  );
  await assertFallowRefusal(root, { unused_types: 1 });
}, 120_000);

test("Fallow remaining canary: unused-dependencies", async () => {
  const root = await createProject("complex");
  const packageJson = await readJson(join(root, "package.json"));
  const dependencies = packageJson.dependencies as Record<string, unknown>;
  dependencies["unused-package"] = "1.0.0";
  await writeJson(join(root, "package.json"), packageJson);
  await writeJson(join(root, "node_modules/unused-package/package.json"), {
    name: "unused-package",
    version: "1.0.0",
    type: "module",
  });
  await assertFallowRefusal(root, { unused_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: unlisted-dependencies", async () => {
  const root = await createProject("complex");
  await writeJson(join(root, "node_modules/not-listed/package.json"), {
    name: "not-listed",
    version: "1.0.0",
    type: "module",
    types: "index.d.ts",
  });
  await writeFile(
    join(root, "node_modules/not-listed/index.d.ts"),
    "export const marker: string;\n",
  );
  await writeFile(
    join(root, "node_modules/not-listed/index.js"),
    'export const marker = "marker";\n',
  );
  await writeFile(
    join(root, "src/diagnostics.ts"),
    (await Bun.file(join(root, "src/diagnostics.ts")).text())
      .replace(
        'import { redactByPattern } from "@logtape/redaction";\n',
        'import { redactByPattern } from "@logtape/redaction";\nimport { marker } from "not-listed";\n',
      )
      .replace(
        'return typeof getLogger === "function" && typeof redactByPattern === "function";',
        'return typeof getLogger === "function" && typeof redactByPattern === "function" && marker === "marker";',
      ),
  );
  await assertFallowRefusal(root, { unlisted_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: unresolved-imports", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/diagnostics.ts"),
    (await Bun.file(join(root, "src/diagnostics.ts")).text()) +
      '\nimport missing from "./missing-module.ts";\nvoid missing;\n',
  );
  await assertFallowRefusal(root, { unresolved_imports: 1 });
}, 120_000);

test("Fallow remaining canary: dev-dependencies-in-production", async () => {
  const root = await createProject("simple");
  const packageJson = await readJson(join(root, "package.json"));
  const devDependencies = packageJson.devDependencies as Record<
    string,
    unknown
  >;
  devDependencies["runtime-helper"] = "1.0.0";
  await writeJson(join(root, "package.json"), packageJson);
  await writeJson(join(root, "node_modules/runtime-helper/package.json"), {
    name: "runtime-helper",
    version: "1.0.0",
    type: "module",
    types: "index.d.ts",
  });
  await writeFile(
    join(root, "node_modules/runtime-helper/index.d.ts"),
    "export const marker: string;\n",
  );
  await writeFile(
    join(root, "node_modules/runtime-helper/index.js"),
    'export const marker = "runtime-helper";\n',
  );
  await writeFile(
    join(root, "src/cli.ts"),
    [
      'import { marker } from "runtime-helper";',
      "",
      "export function main(): string {",
      "  return marker;",
      "}",
      "",
    ].join("\n"),
  );
  await assertFallowRefusal(root, { dev_dependencies_in_production: 1 });
}, 120_000);

async function makeTypeOnlyDependency(root: string): Promise<void> {
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
      '    if (typeof input === "object" && input !== null && "kind" in input && input.kind === "help") return { kind: "help" };',
      '    throw new Error("invalid command");',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
}

test("Fallow remaining canary: type-only-dependencies", async () => {
  const root = await createProject("complex");
  await makeTypeOnlyDependency(root);
  await assertFallowRefusal(
    root,
    { type_only_dependencies: 1 },
    "production-dependencies",
  );
}, 120_000);

test("Fallow remaining canary: test-only-dependencies", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/command-contract.ts"),
    [
      'export type Command = { kind: "help" };',
      "",
      "export const commandSchema = {",
      "  parse(input: unknown): Command {",
      '    if (typeof input === "object" && input !== null && "kind" in input && input.kind === "help") return { kind: "help" };',
      '    throw new Error("invalid command");',
      "  },",
      "};",
      "",
    ].join("\n"),
  );
  await writeFile(
    join(root, "tests/unit/unit.test.ts"),
    (await Bun.file(join(root, "tests/unit/unit.test.ts")).text())
      .replace(
        'import { expect, test } from "bun:test";\n',
        'import { expect, test } from "bun:test";\nimport { z } from "zod";\n',
      )
      .replace(
        'expect(main()).toContain("help");',
        'expect(main()).toContain(z.string().parse("help"));',
      ),
  );
  await assertFallowRefusal(root, { test_only_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: circular-dependencies", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      'import { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  await writeFile(
    join(root, "src/runtime.ts"),
    (await Bun.file(join(root, "src/runtime.ts")).text()) +
      'import { execute } from "./engine.ts";\nvoid execute;\n',
  );
  await assertFallowRefusal(root, { circular_dependencies: 1 });
}, 120_000);

test("Fallow remaining canary: re-export-cycle", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/command-contract.ts"),
    (await Bun.file(join(root, "src/command-contract.ts")).text()) +
      'export { makeModel } from "./model.ts";\n',
  );
  await writeFile(
    join(root, "src/model.ts"),
    (await Bun.file(join(root, "src/model.ts")).text()) +
      'export { commandSchema } from "./command-contract.ts";\n',
  );
  await assertFallowRefusal(root, { re_export_cycles: 1 });
}, 120_000);

test("Fallow remaining canary: boundary-violation", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      'import { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  await assertFallowRefusal(root, { boundary_violations: 1 });
}, 120_000);

test("Fallow remaining canary: boundary-coverage-violation", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/unclassified.ts"),
    "export const unclassified = true;\n",
  );
  await writeFile(
    join(root, "src/cli.ts"),
    (await Bun.file(join(root, "src/cli.ts")).text())
      .replace(
        'import { runtimeName } from "./runtime.ts";\n',
        'import { runtimeName } from "./runtime.ts";\nimport { unclassified } from "./unclassified.ts";\n',
      )
      .replace(
        "    String(diagnosticsReady()),",
        "    String(diagnosticsReady()),\n    String(unclassified),",
      ),
  );
  await assertFallowRefusal(root, { boundary_coverage_violations: 1 });
}, 120_000);

test("Fallow remaining canary: require-suppression-reason", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      '// fallow-ignore-next-line boundary-violation\nimport { runtimeName } from "./runtime.ts";\nvoid runtimeName;\n',
  );
  await assertFallowRefusal(root, {
    stale_suppressions: {
      count: 1,
      matches: (finding) => finding.missing_reason === true,
    },
  });
}, 120_000);

test("Fallow remaining canary: stale-suppressions", async () => {
  const root = await createProject("complex");
  await writeFile(
    join(root, "src/engine.ts"),
    (await Bun.file(join(root, "src/engine.ts")).text()) +
      '// fallow-ignore-next-line boundary-violation -- stale control\nimport type { Command } from "./command-contract.ts";\nvoid (undefined as Command | undefined);\n',
  );
  await assertFallowRefusal(root, { stale_suppressions: 1 });
}, 120_000);

afterAll(async () => {
  await Promise.all(
    TEMPORARY_ROOTS.filter((root) => !RETAINED_ROOTS.has(root)).map((root) =>
      rm(root, { force: true, recursive: true }),
    ),
  );
}, 120_000);
