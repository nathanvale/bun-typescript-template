import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import {
  type Invocation,
  ROOT,
  bootstrapCliFixture,
  invoke,
  parsePackage,
  requireSuccess,
  runCommand,
} from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const temporaryRoot = bootstrapCliFixture();

function admitCli(root: string): Promise<Invocation> {
  return runCommand(ROOT, [
    process.execPath,
    "run",
    "src/cli-inventory.ts",
    root,
  ]);
}

const inventoryRegressions = [
  {
    name: "environment-prefixed application script",
    scripts: {
      start: "bun src/cli.ts",
      extra: "MODE=one bun run src/second.ts",
    },
    files: {
      "src/cli.ts": "export const main = true;",
      "src/second.ts": "export const second = true;",
    },
    entries: ["src/cli.ts", "src/second.ts"],
  },
  {
    name: "quoted environment prefixes and tooling script",
    scripts: {
      start: "MODE='one two' EMPTY= bun src/cli.ts",
      "build:custom": 'MODE="build mode" bun scripts/build.ts',
    },
    files: {
      "src/cli.ts": "export const main = true;",
      "scripts/build.ts": "void process.argv;",
    },
    entries: ["src/cli.ts"],
  },
  ...[
    ["js", "ts"],
    ["mjs", "mts"],
    ["cjs", "cts"],
  ].map(([emitted, source]) => ({
    name: `emitted .${emitted} import resolves .${source} helper`,
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts": `import "./args.${emitted}";`,
      [`src/args.${source}`]: "export const args = process.argv;",
    },
    entries: ["src/cli.ts"],
  })),
  {
    name: "TypeScript generic arrow and TSX source",
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts":
        'import "./view.tsx"; const identity = <T>(value: T) => value; void identity(1);',
      "src/view.tsx": "export const view = <div />;",
    },
    entries: ["src/cli.ts"],
  },
  {
    name: "tooling argument helper stays in import graph",
    scripts: {
      start: "bun src/cli.ts",
      "build:custom": "bun scripts/build.ts",
    },
    files: {
      "src/cli.ts": "export const main = true;",
      "scripts/build.ts": 'import "./options.ts";',
      "scripts/options.ts": "export const args = process.argv;",
    },
    entries: ["src/cli.ts"],
  },
  {
    name: "comments and strings are not executable evidence",
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts": 'import "./domain.ts";',
      "src/domain.ts":
        '// import.meta.main belongs in the front door\nexport const text = "import.meta.main";',
      "src/note.ts": '/* process.argv */ export const note = "process.argv";',
    },
    entries: ["src/cli.ts"],
  },
  {
    name: "regex and template text are not executable evidence",
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts": "export const main = true;",
      "src/notes.ts":
        "export const pattern = /import.meta.main|process.argv/; export const note = `import.meta.main process.argv`;",
    },
    entries: ["src/cli.ts"],
  },
  {
    name: "references inside template interpolation count",
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts": "export const main = true;",
      "src/second.ts": "export const args = `${process.argv}`;",
    },
    entries: ["src/cli.ts", "src/second.ts"],
  },
  {
    name: "reference markers in literal text do not count",
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts": "export const main = true;",
      "src/notes.ts":
        'export const note = "__cliInventoryMain __cliInventoryArgv"; export const escaped = "\\u005f_cliInventoryMain";',
    },
    entries: ["src/cli.ts"],
  },
  {
    name: "imported executable source still counts",
    scripts: { start: "bun src/cli.ts" },
    files: {
      "src/cli.ts": 'import "./second.ts";',
      "src/second.ts": 'if (import.meta.main) process.stdout.write("second");',
    },
    entries: ["src/cli.ts", "src/second.ts"],
  },
];

for (const specimen of inventoryRegressions) {
  test(
    `one-CLI inventory regression: ${specimen.name}`,
    async () => {
      const root = temporaryRoot();
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: specimen.scripts }),
      );
      for (const [name, source] of Object.entries(specimen.files)) {
        const path = join(root, name);
        await mkdir(resolve(path, ".."), { recursive: true });
        await writeFile(path, source);
      }
      const observed = await admitCli(root);
      expect(observed.stderr).toBe("");
      expect(JSON.parse(observed.stdout)).toEqual({
        entries: specimen.entries,
        status: specimen.entries.length === 1 ? "admitted" : "refused",
      });
      expect(observed.exitCode).toBe(specimen.entries.length === 1 ? 0 : 1);
    },
    processWatchdog(1),
  );
}

async function admitExtractedCli(root: string): Promise<Invocation> {
  const source = await readFile(join(ROOT, "src/cli-inventory.ts"), "utf8");
  const javascript = new Bun.Transpiler({
    loader: "ts",
    target: "bun",
  }).transformSync(source);
  const moduleUrl = `data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`;
  const script = `const { inventoryApplicationClis } = await import(${JSON.stringify(moduleUrl)}); process.stdout.write(JSON.stringify(await inventoryApplicationClis(process.cwd())));`;
  return runCommand(root, [process.execPath, "--eval", script]);
}

test(
  "one-CLI inventory runs as an extracted module without host dependencies",
  async () => {
    const root = temporaryRoot();
    await mkdir(join(root, "src"));
    await writeFile(
      join(root, "src/cli.ts"),
      "if (import.meta.main) void process.argv;\n",
    );
    await writeFile(
      join(root, "src/domain.ts"),
      'export const note = "import.meta.main";\n',
    );
    const observed = await admitExtractedCli(root);
    expect(observed.stderr).toBe("");
    expect(observed.exitCode).toBe(0);
    expect(JSON.parse(observed.stdout)).toEqual(["src/cli.ts"]);
  },
  processWatchdog(1),
);

for (const extracted of [false, true]) {
  test(
    `one-CLI inventory never executes macros: ${extracted ? "extracted" : "standalone"}`,
    async () => {
      const root = temporaryRoot();
      const effectsRoot = temporaryRoot();
      const marker = join(effectsRoot, "executed.txt");
      const macro = join(effectsRoot, "effect.ts");
      await writeFile(
        macro,
        `import { appendFileSync } from "node:fs"; export function effect() { appendFileSync(${JSON.stringify(marker)}, "executed\\n"); return 1; }`,
      );
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { start: "bun src/cli.ts" } }),
      );
      await writeFile(
        join(root, "src/cli.ts"),
        `import { effect } from ${JSON.stringify(macro)} with { type: "macro" }; export const value = effect();`,
      );
      const observed = extracted
        ? await admitExtractedCli(root)
        : await admitCli(root);
      expect(existsSync(marker)).toBe(false);
      expect(observed.exitCode).toBe(1);
      if (extracted) expect(observed.stderr).toContain("Macros are disabled");
      else
        expect(JSON.parse(observed.stdout)).toMatchObject({
          status: "refused",
          reason: "Macros are disabled",
        });
    },
    processWatchdog(1),
  );
}

for (const [name, source, entries] of [
  [
    "default process",
    'import process from "node:process"; console.log(process.argv);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "namespace process",
    'import * as process from "node:process"; console.log(process.argv);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "default alias",
    'import proc from "process"; console.log(proc.argv);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "namespace alias interpolation",
    'import * as proc from "node:process"; console.log(`${proc.argv}`);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "named argv",
    'import { argv } from "node:process"; console.log(argv);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "multiline named argv alias",
    "import {\n  env,\n  argv as args,\n} from 'process';\nconsole.log(env, args);",
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "default as named with argv",
    'import proc, { default as other } from "node:process"; console.log(proc, other.argv);',
    ["src/cli.ts", "src/second.ts"],
  ],
  ["Bun argv", "console.log(Bun.argv);", ["src/cli.ts", "src/second.ts"]],
  [
    "non-ASCII process binding",
    'import ñ from "process"; import { argv as \\u00e9 } from "process"; console.log(ñ.argv, \\u00e9);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "argv bound to an inherited property name",
    'import { argv as __proto__ } from "node:process"; console.log(__proto__);',
    ["src/cli.ts", "src/second.ts"],
  ],
  [
    "renamed non-argv import shadows globals",
    'import { env as process, exit as Bun } from "node:process"; console.log(process.argv, Bun.argv);',
    ["src/cli.ts"],
  ],
  [
    "named process import without argv",
    'import { env } from "node:process"; console.log(env, "Bun.argv");',
    ["src/cli.ts"],
  ],
  [
    "imported process literal",
    'import process from "node:process"; void process; export const note = "process.argv";',
    ["src/cli.ts"],
  ],
  [
    "fake import in template",
    'import proc from "node:process"; void proc; export const note = `\nimport fake from "node:process";\n`; console.log(fake.argv);',
    ["src/cli.ts"],
  ],
] as const) {
  test(
    `one-CLI inventory imported process: ${name}`,
    async () => {
      const root = temporaryRoot();
      await mkdir(join(root, "src"));
      await writeFile(
        join(root, "package.json"),
        JSON.stringify({ scripts: { start: "bun src/cli.ts" } }),
      );
      await writeFile(join(root, "src/cli.ts"), "export const main = true;");
      await writeFile(join(root, "src/second.ts"), source);
      const observed = await admitCli(root);
      expect(observed.stderr).toBe("");
      expect(JSON.parse(observed.stdout)).toMatchObject({ entries });
      expect(observed.exitCode).toBe(entries.length === 1 ? 0 : 1);
      const extracted = await admitExtractedCli(root);
      expect(extracted.stderr).toBe("");
      expect(extracted.exitCode).toBe(0);
      expect(JSON.parse(extracted.stdout)).toEqual(entries);
    },
    processWatchdog(2),
  );
}

test(
  "one-CLI admission covers a generated repository's entry points",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "repository");
    requireSuccess(
      await invoke(
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        "--json",
      ),
      "generate repository",
    );
    await writeFile(
      join(destination, "src/args.ts"),
      "export function cliArgs() { return process.argv.slice(2); }\n",
    );
    const entryPath = join(destination, "src/cli.ts");
    await writeFile(
      entryPath,
      'import { cliArgs } from "./args.ts";\nvoid cliArgs;\n' +
        (await readFile(entryPath, "utf8")),
    );
    const initial = await admitCli(destination);
    expect(initial.exitCode).toBe(0);
    expect(JSON.parse(initial.stdout)).toMatchObject({
      entries: ["src/cli.ts"],
      status: "admitted",
    });
    const manifestPath = join(destination, "package.json");
    const manifest = parsePackage(await readFile(manifestPath, "utf8"));
    manifest.scripts["cli-alias"] = "bun run ./src/cli.ts --help";
    manifest.scripts["build:sample"] =
      "bun build src/cli.ts --outfile dist/cli.js";
    manifest.scripts["build:custom"] = "bun run scripts/build.ts";
    await mkdir(join(destination, "scripts"));
    await writeFile(
      join(destination, "scripts/build.ts"),
      'const minify = process.argv.includes("--minify");\nvoid Bun.build({entrypoints: ["src/cli.ts"], outdir: "dist", minify});\n',
    );
    await writeFile(
      join(destination, "BUILD.md"),
      "Build with `bun run scripts/build.ts --minify`.\n",
    );
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    expect((await admitCli(destination)).exitCode).toBe(0);
    await writeFile(
      join(destination, "src/second.ts"),
      'if (import.meta.main) process.stdout.write("second CLI\\n");\n',
    );
    const refused = await admitCli(destination);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      entries: ["src/cli.ts", "src/second.ts"],
      status: "refused",
    });
  },
  processWatchdog(4),
);

test(
  "one-CLI admission finds a documented executable and a package's bin",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "repository");
    requireSuccess(
      await invoke(
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        "--json",
      ),
      "generate repository",
    );
    await writeFile(
      join(destination, "src/documented.ts"),
      'process.stdout.write("documented CLI\\n");\n',
    );
    const readme = join(destination, "README.md");
    await writeFile(
      readme,
      (await readFile(readme, "utf8")) +
        "\nAdditional application: `bun run src/documented.ts`.\n",
    );
    const documentedRefusal = await admitCli(destination);
    expect(documentedRefusal.exitCode).toBe(1);
    expect(documentedRefusal.stderr).toBe("");
    expect(JSON.parse(documentedRefusal.stdout)).toMatchObject({
      entries: ["src/cli.ts", "src/documented.ts"],
      status: "refused",
    });
    await writeFile(
      join(destination, "src/documented.ts"),
      "export const libraryValue = 1;\n",
    );
    await writeFile(readme, "# Repository\nRun: `bun run src/cli.ts`.\n");
    const member = join(destination, "packages/example-lib");
    await mkdir(join(member, "src"), { recursive: true });
    await writeFile(
      join(member, "src/index.ts"),
      "export const libraryValue = 1;\n",
    );
    await writeFile(
      join(member, "package.json"),
      JSON.stringify({ name: "example-lib", bin: { extra: "src/index.ts" } }) +
        "\n",
    );
    const refused = await admitCli(destination);
    expect(refused.exitCode).toBe(1);
    expect(JSON.parse(refused.stdout)).toMatchObject({
      entries: ["packages/example-lib/src/index.ts", "src/cli.ts"],
    });
  },
  processWatchdog(3),
);
