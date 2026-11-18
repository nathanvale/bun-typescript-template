import { expect } from "bun:test";
import { join, relative } from "node:path";
import { type Profile, readJson } from "./static-admission-project.ts";

export const EXPECTED_COMPILER_OPTIONS: Record<string, unknown> = {
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

export const EXPECTED_FILES: Record<Profile, string[]> = {
  simple: ["src/cli.ts", "tests/cli.test.ts"],
  complex: [
    "src/branch-station-catalog.ts",
    "src/cli.ts",
    "src/command-contract.ts",
    "src/diagnostics.ts",
    "src/engine.ts",
    "src/journal.ts",
    "src/model.ts",
    "src/process-lifecycle.ts",
    "src/runtime.ts",
    "tests/catalog/catalog.test.ts",
    "tests/integration/integration.test.ts",
    "tests/unit/unit.test.ts",
  ],
};

export const EXPECTED_SCRIPTS = {
  start: "bun run src/cli.ts",
  biome: "bun run format:check",
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

export const EXPECTED_DEPENDENCY_PINS: Record<
  Profile,
  {
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
  }
> = {
  simple: {
    dependencies: {},
    devDependencies: {
      "@biomejs/biome": "2.6.7",
      "@types/bun": "1.4.4",
      fallow: "3.43.2",
      "@typescript/native": "npm:typescript@7.0.2",
      typescript: "npm:@typescript/typescript6@6.0.2",
      eslint: "10.15.0",
      "@eslint/js": "10.0.1",
      "typescript-eslint": "8.72.2",
      "fallow-type-aware": "3.43.2",
    },
  },
  complex: {
    dependencies: {
      "@logtape/logtape": "2.4.2",
      "@logtape/redaction": "2.4.2",
      zod: "4.4.3",
    },
    devDependencies: {
      "@biomejs/biome": "2.6.7",
      "@types/bun": "1.4.4",
      fallow: "3.43.2",
      "@typescript/native": "npm:typescript@7.0.2",
      typescript: "npm:@typescript/typescript6@6.0.2",
      eslint: "10.15.0",
      "@eslint/js": "10.0.1",
      "typescript-eslint": "8.72.2",
      "fallow-type-aware": "3.43.2",
    },
  },
};

export const SELECTED_FALLOW_RULES = [
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
      { name: "tooling", patterns: ["eslint.config.mjs", "eslint-rules.mjs"] },
      { name: "front-door", patterns: ["src/cli.ts"] },
      { name: "tests", patterns: ["tests/**/*.ts"] },
      {
        name: "domains",
        patterns: [
          "src/domains/**/*.ts",
          "src/commands.ts",
          "src/commands-contract.ts",
        ],
      },
    ],
    rules: [
      { from: "tooling", allow: ["tooling"] },
      { from: "front-door", allow: ["domains"] },
      { from: "tests", allow: ["front-door", "domains"] },
      { from: "domains", allow: ["domains"] },
    ],
    coverage: { requireAllFiles: true },
  },
  complex: {
    zones: [
      { name: "tooling", patterns: ["eslint.config.mjs", "eslint-rules.mjs"] },
      { name: "front-door", patterns: ["src/cli.ts"] },
      {
        name: "contract",
        patterns: [
          "src/command-contract.ts",
          "src/model.ts",
          "src/commands-contract.ts",
        ],
      },
      { name: "engine", patterns: ["src/engine.ts"] },
      {
        name: "runtime",
        patterns: [
          "src/runtime.ts",
          "src/journal.ts",
          "src/process-lifecycle.ts",
        ],
      },
      { name: "catalog", patterns: ["src/branch-station-catalog.ts"] },
      {
        name: "diagnostics",
        patterns: ["src/diagnostics.ts", "src/diagnostics-custody.ts"],
      },
      { name: "unit-tests", patterns: ["tests/unit/**/*.ts"] },
      { name: "integration-tests", patterns: ["tests/integration/**/*.ts"] },
      { name: "catalog-tests", patterns: ["tests/catalog/**/*.ts"] },
      { name: "dispatch", patterns: ["src/commands.ts"] },
      { name: "domains", patterns: ["src/domains/state.ts"] },
    ],
    rules: [
      { from: "tooling", allow: ["tooling"] },
      {
        from: "front-door",
        allow: [
          "contract",
          "engine",
          "runtime",
          "catalog",
          "diagnostics",
          "dispatch",
          "domains",
        ],
      },
      { from: "contract", allow: [] },
      { from: "engine", allow: ["contract"] },
      { from: "runtime", allow: ["contract", "runtime", "diagnostics"] },
      { from: "catalog", allow: ["contract"] },
      { from: "diagnostics", allow: ["contract"] },
      {
        from: "unit-tests",
        allow: ["front-door", "contract", "engine", "runtime", "catalog"],
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
      {
        from: "dispatch",
        allow: [
          "contract",
          "engine",
          "runtime",
          "catalog",
          "diagnostics",
          "domains",
        ],
      },
      {
        from: "domains",
        allow: [
          "contract",
          "engine",
          "runtime",
          "catalog",
          "diagnostics",
          "domains",
        ],
      },
    ],
    coverage: { requireAllFiles: true },
  },
};

async function assertLockPolicy(
  root: string,
  expectedPins: (typeof EXPECTED_DEPENDENCY_PINS)[Profile],
): Promise<void> {
  const lock = Bun.JSONC.parse(
    await Bun.file(join(root, "bun.lock")).text(),
  ) as Record<string, unknown>;
  expect(lock.lockfileVersion).toBe(3);
  expect(lock.overrides).toEqual({
    "@typescript/old@npm:typescript@^6": { ".": "npm:typescript@6.0.2" },
  });
  const workspaces = lock.workspaces as Record<string, unknown>;
  const workspace = workspaces[""] as Record<string, unknown> | undefined;
  if (workspace === undefined) {
    throw new Error("bun.lock is missing the root workspace record");
  }
  expect(workspace.dependencies ?? {}).toEqual(expectedPins.dependencies);
  expect(workspace.devDependencies).toEqual(expectedPins.devDependencies);

  const packages = lock.packages as Record<string, unknown>;
  expect(packages["@typescript/old"]).toBeArray();
  expect((packages["@typescript/old"] as unknown[])[0]).toBe(
    "typescript@6.0.2",
  );
  for (const [packageName, version] of Object.entries({
    ...expectedPins.dependencies,
    ...expectedPins.devDependencies,
  })) {
    const resolved = packages[packageName];
    if (!Array.isArray(resolved)) {
      throw new Error(`bun.lock is missing ${packageName}'s resolved record`);
    }
    expect(resolved[0]).toBe(
      version.startsWith("npm:")
        ? version.slice(4)
        : `${packageName}@${version}`,
    );
  }
}

export function assertCompilerDocument(
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

export async function assertPacketPolicy(
  root: string,
  profile: Profile,
): Promise<void> {
  const packageJson = await readJson(join(root, "package.json"));
  const expectedPins = EXPECTED_DEPENDENCY_PINS[profile];
  expect(packageJson.packageManager).toBe("bun@1.4.4");
  expect(packageJson.scripts).toEqual({
    start: EXPECTED_SCRIPTS.start,
    "biome:check": EXPECTED_SCRIPTS.biome,
    lint: "eslint . --max-warnings 0",
    "format:check": "biome format .",
    format: "biome format --write .",
    "check:write": "bun run format",
    "check:config": EXPECTED_SCRIPTS.config,
    typecheck: EXPECTED_SCRIPTS.typecheck,
    test: EXPECTED_SCRIPTS.test,
    "quality:fallow": EXPECTED_SCRIPTS.quality,
    "quality:fallow:changed": EXPECTED_SCRIPTS.changed,
    "quality:fallow:dependencies": EXPECTED_SCRIPTS.dependencies,
    check:
      "bun run lint && bun run format:check && bun run typecheck && bun run test && bun run --silent quality:fallow && bun run --silent quality:fallow:dependencies",
  });
  expect(packageJson.dependencies ?? {}).toEqual(expectedPins.dependencies);
  expect(packageJson.devDependencies).toEqual(expectedPins.devDependencies);
  expect(packageJson.overrides).toEqual({
    "@typescript/old@npm:typescript@^6": "npm:typescript@6.0.2",
  });
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
  expect(biomeFiles).toEqual([
    "**",
    "!**/node_modules",
    "!**/dist",
    "!**/coverage",
    "!**/.fallow",
    "!**/bun.lock",
  ]);
  expect(biome.linter).toEqual({ enabled: false });
  expect(biome.assist).toEqual({ enabled: false });
  expect((biome.formatter as Record<string, unknown>).enabled).toBe(true);

  const fallow = await readJson(join(root, ".fallowrc.json"));
  expect(fallow.entry).toEqual(
    profile === "simple"
      ? ["tests/cli.test.ts", "eslint-rules.mjs"]
      : [
          "tests/unit/**/*.test.ts",
          "tests/integration/**/*.test.ts",
          "tests/catalog/**/*.test.ts",
          "eslint-rules.mjs",
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
  const boundaries = fallow.boundaries as {
    zones: { name: string }[];
    rules: { from: string }[];
    coverage: unknown;
  };
  const expectedBoundaries = EXPECTED_BOUNDARIES[profile] as typeof boundaries;
  expect({
    ...boundaries,
    zones: [...boundaries.zones].sort((a, b) => a.name.localeCompare(b.name)),
    rules: [...boundaries.rules].sort((a, b) => a.from.localeCompare(b.from)),
  }).toEqual({
    ...expectedBoundaries,
    zones: [...expectedBoundaries.zones].sort((a, b) =>
      a.name.localeCompare(b.name),
    ),
    rules: [...expectedBoundaries.rules].sort((a, b) =>
      a.from.localeCompare(b.from),
    ),
  });

  const rules = fallow.rules as Record<string, unknown>;
  for (const key of [...SELECTED_FALLOW_RULES, ...OFF_FALLOW_RULES])
    expect(Object.hasOwn(rules, key)).toBe(true);
  for (const [key, level] of Object.entries(rules))
    if (!(SELECTED_FALLOW_RULES as readonly string[]).includes(key))
      expect(level).toBe("off");
  for (const rule of SELECTED_FALLOW_RULES) {
    expect(rules[rule]).toBe("error");
  }
  for (const rule of OFF_FALLOW_RULES) {
    expect(rules[rule]).toBe("off");
  }
}
