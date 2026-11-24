import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  copiesOf,
  KERNEL_RECIPE,
  TEMPLATE_JSON_FILE,
} from "../../../src/recipe.ts";
import { listFiles, ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { gitResult, initRepository } from "../../support/git-fixture.ts";
import {
  firstLayout,
  renamedLayout,
} from "../../support/kernel-repository-fixture.ts";
import {
  bootstrapRow,
  generatedJson,
  kernelRowFixture,
} from "../../support/recipe-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const run = kernelRowFixture();
const bootstrapModules = [
  "src/bootstrap.ts",
  "src/bootstrap-arguments.ts",
  "src/recipe.ts",
  "src/token-substitution.ts",
];
const ownFiles = [
  ".agents/skills/agent-cli-kernel/SKILL.md",
  ".agents/skills/verify-cli/SKILL.md",
  ".changeset/README.md",
  ".changeset/config.json",
  ".claude/skills/agent-cli-kernel",
  ".claude/skills/verify-cli",
  ".fallowrc.json",
  ".github/workflows/ci.yml",
  ".gitignore",
  ".template.json",
  "AGENTS.md",
  "README.md",
  "biome.json",
  "bunfig.toml",
  "config/anti-slop-bindings.mjs",
  "config/anti-slop-rules.mjs",
  "config/anti-slop-type-rules.mjs",
  "config/payload-rules.mjs",
  "config/platform-rules.mjs",
  "config/template-rules.mjs",
  "eslint.config.mjs",
  "fallow-dead-code-recorded-hits.json",
  "fallow-duplicates-recorded-hits.json",
  "fallow-health-recorded-hits.json",
  "package.json",
  "scripts/check-gated-paths.ts",
  "scripts/test-run-process.ts",
  "scripts/test-run.ts",
  "src/cli.ts",
  "src/commands.ts",
  "tests/add-on-start-up.test.ts",
  "tests/changeset-action.test.ts",
  "tests/cli.test.ts",
  "tests/git-fixture.test.ts",
  "tests/pointer-skills.test.ts",
  "tests/support/git-fixture.ts",
  "tests/support/test-folder.ts",
  "tests/support/test-run-folder.ts",
  "tsconfig.base.json",
  "tsconfig.json",
];

function sourceOf(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

function importsOf(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"([^"]+)"/g)].map(
    ([, from = ""]) => from,
  );
}

describe("the kernel row", () => {
  test("copies folders that exist, and writes its own Template provenance values, which name no kernel commit", async () => {
    for (const { from, only } of copiesOf(KERNEL_RECIPE)) {
      expect([from, statSync(join(ROOT, from)).isDirectory()]).toEqual([
        from,
        true,
      ]);
      for (const name of only ?? [])
        expect([name, existsSync(join(ROOT, from, name))]).toEqual([
          name,
          true,
        ]);
    }
    const { destination, request } = run();
    await bootstrapRow(request);
    expect(existsSync(join(destination, TEMPLATE_JSON_FILE))).toBe(true);
    expect(existsSync(join(destination, ".cli-design-template.json"))).toBe(
      false,
    );
    const provenance = generatedJson(destination, TEMPLATE_JSON_FILE);
    expect(provenance).toMatchObject({
      name: "demo-app",
      sourcePacket: "/abs/packets/demo",
    });
    expect(Object.keys(provenance as object).toSorted()).toEqual([
      "name",
      "sourcePacket",
      "templateDirty",
      "templateRevision",
    ]);
    expect(JSON.stringify(provenance)).not.toContain(request.kernel.commit);
  });

  test.each([
    { name: "the first layout", layout: firstLayout },
    { name: "other folder names", layout: renamedLayout },
  ])(
    "gives a generated repository its settings and application files and no kernel source, from a kernel in $name, with every token substituted",
    async ({ layout }) => {
      const { destination, request } = run(layout);
      await bootstrapRow(request);
      expect(await listFiles(destination)).toEqual(ownFiles);
      const withToken = ownFiles
        .filter((file) => !file.startsWith(".claude/"))
        .filter((file) =>
          /__REPOSITORY_NAME__|__SOURCE_PACKET__|__KERNEL_PIN__|__KERNEL_COMMIT__/.test(
            readFileSync(join(destination, file), "utf8"),
          ),
        );
      expect(withToken).toEqual([]);
      expect(readFileSync(join(destination, "src/cli.ts"), "utf8")).toContain(
        'cli: "demo-app",',
      );
    },
  );

  test("names the kernel by its Pin: one dependency line, at the commit asked for in full", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const { dependencies } = generatedJson(destination, "package.json") as {
      dependencies: Record<string, string>;
    };
    expect(dependencies).toEqual({
      "agent-cli-kernel": `github:nathanvale/agent-cli-kernel#${request.kernel.commit}`,
    });
  });

  test("imports the kernel by its package name in the application files and the lint settings", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const imports = Object.fromEntries(
      ["src/cli.ts", "src/commands.ts", "eslint.config.mjs"].map((file) => [
        file,
        importsOf(readFileSync(join(destination, file), "utf8")).filter(
          (from) => from.includes("kernel"),
        ),
      ]),
    );
    expect(imports).toEqual({
      "src/cli.ts": ["agent-cli-kernel"],
      "src/commands.ts": ["agent-cli-kernel", "agent-cli-kernel"],
      "eslint.config.mjs": [
        "agent-cli-kernel/lint",
        "agent-cli-kernel/lint-rules",
      ],
    });
  });

  test("turns on no add-on's lint allowances, so a folder under src/addons/ gets the same lint rules as the rest of the application", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const settings = readFileSync(
      join(destination, "eslint.config.mjs"),
      "utf8",
    );
    expect(settings.match(/addons: [^,\n]*,/g)).toEqual(["addons: [],"]);
  });

  test("gives a check command with no stamp check step, combined Fallow quality check with recorded hits, and a recording script", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const { scripts } = generatedJson(destination, "package.json") as {
      scripts: Record<string, string>;
    };
    const { audit, health, rules } = generatedJson(
      destination,
      ".fallowrc.json",
    ) as {
      audit: {
        deadCodeBaseline?: string;
        dupesBaseline?: string;
        healthBaseline?: string;
      };
      health: { maxFileLines?: number };
      rules: Record<string, string>;
    };
    const recordedHits = {
      deadCode: generatedJson(
        destination,
        "fallow-dead-code-recorded-hits.json",
      ),
      duplicates: generatedJson(
        destination,
        "fallow-duplicates-recorded-hits.json",
      ),
      health: generatedJson(destination, "fallow-health-recorded-hits.json"),
    };
    expect({
      check: scripts.check,
      qualityFallow: scripts["quality:fallow"],
      recordHits: scripts["quality:fallow:record-hits"],
      stampScripts: Object.keys(scripts).filter((name) =>
        name.includes("stamp"),
      ),
      fallowSettings: {
        deadCodeBaseline: audit.deadCodeBaseline,
        dupesBaseline: audit.dupesBaseline,
        healthBaseline: audit.healthBaseline,
        typeOnlyDependencies: rules["type-only-dependencies"],
        cyclomatic: rules["complexity-cyclomatic"],
        cognitive: rules["complexity-cognitive"],
        crap: rules["complexity-crap"],
        fileLines: rules["complexity-file-lines"],
        maxFileLines: health.maxFileLines,
      },
      recordedHits,
    }).toEqual({
      check:
        "bun run lint && bun run format:check && bun run typecheck && bun run test && bun run --silent quality:fallow",
      qualityFallow:
        "node_modules/.bin/fallow --format json --quiet --type-aware --type-aware-require complete --fail-on-issues --baseline-mode identity --baseline fallow-dead-code-recorded-hits.json --dupes-baseline fallow-duplicates-recorded-hits.json --health-baseline fallow-health-recorded-hits.json",
      recordHits:
        "node_modules/.bin/fallow --format json --quiet --type-aware --type-aware-require complete --save-baseline fallow-dead-code-recorded-hits.json && node_modules/.bin/fallow dupes --format json --quiet --save-baseline fallow-duplicates-recorded-hits.json && node_modules/.bin/fallow health --report-only --format json --quiet --baseline-mode identity --save-baseline fallow-health-recorded-hits.json && biome format --write fallow-dead-code-recorded-hits.json fallow-duplicates-recorded-hits.json fallow-health-recorded-hits.json",
      stampScripts: [],
      fallowSettings: {
        deadCodeBaseline: "fallow-dead-code-recorded-hits.json",
        dupesBaseline: "fallow-duplicates-recorded-hits.json",
        healthBaseline: "fallow-health-recorded-hits.json",
        typeOnlyDependencies: "off",
        cyclomatic: "error",
        cognitive: "error",
        crap: "off",
        fileLines: "error",
        maxFileLines: 500,
      },
      recordedHits: {
        deadCode: {
          kind: "dead-code",
          analysis_identity: {
            mode: "type-aware",
            semantic_schema_version: 3,
            capabilities: ["symbol-use", "type-coupling"],
            project_config_hash: "deferred:no-semantic-queries",
            backend_family: "typescript-go",
            completeness: "complete",
            node_modules: "present",
          },
          identity: "dc1",
          unused_files: [],
          unused_exports: [],
          unused_types: [],
          unused_dependencies: [],
          unused_dev_dependencies: [],
        },
        duplicates: {
          kind: "dupes",
          clone_groups: [],
          clone_fingerprints: [],
          normalized_clone_fingerprints: [],
        },
        health: {
          kind: "health",
          finding_counts: {},
          identity_finding_counts: {},
          runtime_coverage_findings: [],
          target_keys: [],
        },
      },
    });
  });

  test("leaves the nine zero-finding default Fallow rules at Fallow's default severity", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const { rules } = generatedJson(destination, ".fallowrc.json") as {
      rules: Record<string, string>;
    };
    const defaultEnabledRules = [
      "unused-class-members",
      "unused-enum-members",
      "duplicate-exports",
      "misconfigured-dependency-overrides",
      "unused-dev-dependencies",
      "unused-optional-dependencies",
      "duplicate-export-aliases",
      "unlisted-binaries",
      "unused-dependency-overrides",
    ];
    expect(
      defaultEnabledRules.filter((rule) => Object.hasOwn(rules, rule)),
    ).toEqual([]);
  });

  test("ignores .worktrees in the generated repository without a personal Git ignore file", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    initRepository(destination);
    const worktree = gitResult(
      destination,
      "-c",
      "core.excludesFile=/dev/null",
      "check-ignore",
      ".worktrees/example/src/cli.ts",
    );
    const source = gitResult(
      destination,
      "-c",
      "core.excludesFile=/dev/null",
      "check-ignore",
      "src/cli.ts",
    );
    expect({
      worktree: {
        exitCode: worktree.exitCode,
        stdout: worktree.stdout.toString(),
        stderr: worktree.stderr.toString(),
      },
      source: {
        exitCode: source.exitCode,
        stdout: source.stdout.toString(),
        stderr: source.stderr.toString(),
      },
    }).toEqual({
      worktree: {
        exitCode: 0,
        stdout: ".worktrees/example/src/cli.ts\n",
        stderr: "",
      },
      source: {
        exitCode: 1,
        stdout: "",
        stderr: "",
      },
    });
  });

  test(
    "leaves Markdown with front matter and plain Markdown byte-identical when formatting a generated repository, while still checking TypeScript",
    async () => {
      const { destination, request } = run();
      await bootstrapRow(request);
      initRepository(destination);
      const biome = join(ROOT, "node_modules/.bin/biome");
      const frontmatterNote = [
        "---",
        "name: example-note",
        "title: 'Single quoted'",
        "placeholder: {{title}}",
        "tags:",
        "  - template",
        "  - markdown",
        "---",
        "",
        "# Example Note",
        "",
        "* Keep approved template formatting",
        "",
        "| Key | Value |",
        "| --- | --- |",
        "| a | 1 |",
        "",
      ].join("\n");
      const plainNote = [
        "# Plain Markdown",
        "",
        "* bullet one",
        "* bullet two",
        "",
        "Paragraph with   preserved spacing.",
        "",
      ].join("\n");
      mkdirSync(join(destination, "notes"), { recursive: true });
      writeFileSync(join(destination, "notes/frontmatter.md"), frontmatterNote);
      writeFileSync(join(destination, "notes/plain.md"), plainNote);

      const markdownPaths = [
        ".agents/skills/agent-cli-kernel/SKILL.md",
        ".agents/skills/verify-cli/SKILL.md",
        "notes/frontmatter.md",
        "notes/plain.md",
      ];
      const before = Object.fromEntries(
        markdownPaths.map((file) => [
          file,
          readFileSync(join(destination, file), "utf8"),
        ]),
      );
      expect(before[".agents/skills/agent-cli-kernel/SKILL.md"]).toMatch(
        /^---\nname: agent-cli-kernel\n/,
      );
      expect(before[".agents/skills/verify-cli/SKILL.md"]).toMatch(
        /^---\nname: verify-cli\n/,
      );

      const check = await spawnBounded([biome, "format", "."], {
        cwd: destination,
        processGroup: true,
      });
      const write = await spawnBounded([biome, "format", "--write", "."], {
        cwd: destination,
        processGroup: true,
      });
      const after = Object.fromEntries(
        markdownPaths.map((file) => [
          file,
          readFileSync(join(destination, file), "utf8"),
        ]),
      );
      expect({
        checkExit: check.exit,
        writeExit: write.exit,
        after,
      }).toEqual({
        checkExit: 0,
        writeExit: 0,
        after: before,
      });

      writeFileSync(
        join(destination, "src/unformatted.ts"),
        "export const answer=42\n",
      );
      const control = await spawnBounded([biome, "format", "."], {
        cwd: destination,
        processGroup: true,
      });
      expect({
        exit: control.exit,
        namesFile: control.stderr.includes("src/unformatted.ts"),
        reportsFormat: control.stderr.includes("Formatter would have printed"),
      }).toEqual({
        exit: 1,
        namesFile: true,
        reportsFormat: true,
      });
    },
    processWatchdog(3),
  );
});

function kernelFoldersNamedIn(paths: readonly string[]): string[] {
  const kernelFolders = [
    "src/kernel",
    "config/kernel",
    "src/addons",
    "kernel/",
    "addons/",
    readKernelPin(ROOT).repository,
  ];
  return paths.flatMap((path) =>
    kernelFolders
      .filter((folder) => sourceOf(path).includes(folder))
      .map((folder) => `${path} names ${folder}`),
  );
}

describe("Bootstrap holds no kernel path", () => {
  test("no module of Bootstrap names a folder the kernel repository uses today, from a list kept here by hand", () => {
    expect(kernelFoldersNamedIn(bootstrapModules)).toEqual([]);
  });

  test("the control: the same scan finds the kernel paths the kernel reader holds", () => {
    expect(kernelFoldersNamedIn(["src/kernel-reader.ts"])).toEqual([
      "src/kernel-reader.ts names config/kernel",
      "src/kernel-reader.ts names kernel/",
    ]);
  });
});

describe("the kernel row starts no program of its own", () => {
  test("no module of Bootstrap but bootstrap.ts starts a process, and bootstrap.ts starts only git, for Template provenance", () => {
    const starts = /\bBun\s*\.\s*(?:spawnSync|spawn|\$)|child_process/g;
    const started = Object.fromEntries(
      bootstrapModules.map((path) => [
        path,
        sourceOf(path).match(starts) ?? [],
      ]),
    );
    expect(started).toEqual({
      "src/bootstrap.ts": ["Bun.spawnSync"],
      "src/bootstrap-arguments.ts": [],
      "src/recipe.ts": [],
      "src/token-substitution.ts": [],
    });
    expect(sourceOf("src/bootstrap.ts")).toContain(
      'Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, ...args], {',
    );
  });
});

describe("the template's own test command", () => {
  test(
    "runs no test file from the files a generated repository gets, which cannot run before Bootstrap places them",
    async () => {
      const { scripts } = JSON.parse(sourceOf("package.json")) as {
        scripts: { test: string };
      };
      const ignored = [
        ...scripts.test.matchAll(/--path-ignore-patterns '([^']+)'/g),
      ].flatMap(([, pattern = ""]) => ["--path-ignore-patterns", pattern]);
      const run = await spawnBounded(
        [process.execPath, "test", ...ignored, "./generated-repository"],
        { cwd: ROOT, processGroup: true },
      );
      expect({
        exit: run.exit,
        noFile: run.stderr.includes("did not match any test files"),
      }).toEqual({ exit: 1, noFile: true });
    },
    processWatchdog(1),
  );
});
