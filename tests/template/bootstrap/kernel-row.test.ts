import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { copiesOf, KERNEL_RECIPE } from "../../../src/recipe.ts";
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
  ".claude/skills/agent-cli-kernel",
  ".claude/skills/verify-cli",
  ".cli-design-template.json",
  ".fallowrc.json",
  ".github/workflows/ci.yml",
  ".gitignore",
  "AGENTS.md",
  "README.md",
  "biome.json",
  "bunfig.toml",
  "change-notes/README.md",
  "config/anti-slop-bindings.mjs",
  "config/anti-slop-rules.mjs",
  "config/anti-slop-type-rules.mjs",
  "config/payload-rules.mjs",
  "config/platform-rules.mjs",
  "config/template-rules.mjs",
  "eslint.config.mjs",
  "package.json",
  "src/cli.ts",
  "src/commands.ts",
  "tests/add-on-start-up.test.ts",
  "tests/cli.test.ts",
  "tests/pointer-skills.test.ts",
  "tests/support/test-folder.ts",
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
    const provenance = generatedJson(destination, ".cli-design-template.json");
    expect(provenance).toMatchObject({
      name: "demo-app",
      sourcePacket: "/abs/packets/demo",
      entryPoint: "src/cli.ts",
      commandOwner: "src/commands.ts",
    });
    expect(Object.keys(provenance as object).toSorted()).toEqual([
      "commandOwner",
      "entryPoint",
      "name",
      "registrationVersion",
      "sourcePacket",
      "specRevision",
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

  test("gives a check command with no stamp check step", async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const { scripts } = generatedJson(destination, "package.json") as {
      scripts: Record<string, string>;
    };
    expect({
      check: scripts.check,
      stampScripts: Object.keys(scripts).filter((name) =>
        name.includes("stamp"),
      ),
    }).toEqual({
      check:
        "bun run lint && bun run format:check && bun run typecheck && bun run test && bun run --silent quality:fallow",
      stampScripts: [],
    });
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
