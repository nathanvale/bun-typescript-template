import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { commitIn, git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  createFixture,
  longFileSource,
  nestSource,
  routeSource,
  runScriptDirect,
  SHIPPED_SETTINGS_DIR,
  withFallowSettings,
} from "../../support/recorded-health-sizes-fixture.ts";

type Changes = Record<string, string | null>;

const stubFolders = ownedFolders();
const MARKER = ["fallow", "ignore"].join("-");
const REAL_FALLOW = join(ROOT, "node_modules/.bin/fallow");
const growLong: Changes = { "src/long.ts": longFileSource(520) };

function withHealth(health: Readonly<Record<string, unknown>>): string {
  return withFallowSettings((shipped) => ({
    ...shipped,
    health: { ...shipped.health, ...health },
  }));
}

test(
  "makes only Fallow-reported markers inert, leaving JSX text, CSS URLs, Svelte strings and settings values byte-for-byte unchanged",
  async () => {
    const { repo } = await createFixture();
    const literalLine = `export const marker = "// ${MARKER}-file complexity";`;
    const pathLine = `export const dir = ".${MARKER}/long.ts";`;
    const templateLine = `export const tpl = \`/* ${MARKER}-next-line complexity */\`;`;
    const regexLine = 'if (true) /`/.test("a");';
    const jsxApostrophe = `export const el = () => <div>Don't</div>; // ${MARKER}-next-line complexity`;
    const lineComment = `// ${MARKER}-next-line complexity -- hide it`;
    const blockComment = `/* ${MARKER}-next-line complexity */`;
    const baseSettings = withFallowSettings((shipped) => ({
      ...shipped,
      ignorePatterns: [...shipped.ignorePatterns, `!.${MARKER}/**`],
    }));
    const headSettings = withHealth({ maxFileLines: 1000 });
    const unchangedFiles: Record<string, string> = {
      "src/jsx-text.tsx": `export const label = () => <div>// ${MARKER}-next-line complexity</div>;\n`,
      "src/styles.css": `.icon { background: url(https://example.com/${MARKER}-file.png); }\n`,
      "src/App.svelte": `<script>\nexport const msg = "// ${MARKER}-next-line complexity";\n</script>\n<div>{"<!-- ${MARKER}-file -->"}</div>\n`,
      "src/literals.ts": `${literalLine}\n${pathLine}\n${templateLine}\n${regexLine}\n`,
      "src/view.html": `<div title="<!-- ${MARKER}-file -->">Don't</div>\n`,
    };
    const { sha: baseSha } = commitIn(
      repo,
      "add settings, active markers and non-marker text",
      {
        ".fallowrc.json": baseSettings,
        ...unchangedFiles,
        "src/commands.ts": `${literalLine}\n${pathLine}\n${templateLine}\n${regexLine}\n${lineComment}\n${routeSource(20, 1)}\n${blockComment}\n${nestSource(false)}`,
        "src/view.tsx": `${jsxApostrophe}\n${routeSource(20, 1)}`,
        "src/page.astro": `---\n// ${MARKER}-file complexity\n---\n<!-- ${MARKER}-next-line complexity -->\n<div>ok</div>\n`,
      },
    );
    commitIn(repo, "change head settings", {
      ".fallowrc.json": headSettings,
    });

    const stubDir = stubFolders("fallow-wrapper-");
    const wrapperScript = join(stubDir, "fallow-wrapper.ts");
    const wrapperPath = join(stubDir, "fallow-wrapper.sh");
    write(
      stubDir,
      "fallow-wrapper.ts",
      `import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const cfg = args[args.indexOf("--config") + 1] ?? "";
const root = args[args.indexOf("--root") + 1] ?? "";
const errors: string[] = [];
if (lstatSync(cfg).isSymbolicLink()) errors.push("config is a symlink");
if (cfg.startsWith(\`\${root}/\`)) errors.push("config is inside measured tree");
if (readFileSync(cfg, "utf8") !== ${JSON.stringify(baseSettings)})
  errors.push("base settings bytes changed");
const runReal = () => {
  if (errors.length > 0) {
    process.stderr.write(\`\${errors.join("; ")}\\n\`);
    process.exit(1);
  }
  const res = Bun.spawnSync([${JSON.stringify(REAL_FALLOW)}, ...args], {
    stdout: "inherit",
    stderr: "inherit",
    timeout: 60_000,
    killSignal: "SIGKILL",
  });
  process.exit(res.exitCode);
};
if (args[0] !== "health") runReal();
const treeCfg = readFileSync(join(root, ".fallowrc.json"), "utf8");
if (treeCfg !== ${JSON.stringify(baseSettings)} && treeCfg !== ${JSON.stringify(headSettings)})
  errors.push("tree settings bytes changed");
const unchanged = ${JSON.stringify(unchangedFiles)} as Record<string, string>;
for (const [rel, expected] of Object.entries(unchanged)) {
  const actual = readFileSync(join(root, rel), "utf8");
  if (actual !== expected) errors.push(\`non-marker file changed: \${rel}\`);
}
const commands = readFileSync(join(root, "src/commands.ts"), "utf8");
for (const keep of [${JSON.stringify(literalLine)}, ${JSON.stringify(pathLine)}, ${JSON.stringify(templateLine)}])
  if (!commands.includes(keep)) errors.push(\`non-marker line changed: \${keep}\`);
const commandLines = commands.split("\\n");
if (commandLines.includes(${JSON.stringify(lineComment)}) || commandLines.includes(${JSON.stringify(blockComment)}))
  errors.push("code comment marker stayed active");
const tsx = readFileSync(join(root, "src/view.tsx"), "utf8");
if (!tsx.includes("<div>Don't</div>") || tsx.includes(${JSON.stringify(MARKER)}))
  errors.push("jsx apostrophe comment marker stayed active");
const astro = readFileSync(join(root, "src/page.astro"), "utf8");
if (astro.includes(${JSON.stringify(MARKER)}))
  errors.push("astro marker stayed active");
if (errors.length > 0) {
  process.stderr.write(\`\${errors.join("; ")}\\n\`);
  process.exit(1);
}
runReal();
`,
    );
    write(
      stubDir,
      "fallow-wrapper.sh",
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(wrapperScript)} "$@"\n`,
    );
    chmodSync(wrapperPath, 0o755);

    const result = await runScriptDirect(repo, [
      "--base",
      baseSha,
      "--fallow",
      wrapperPath,
    ]);
    expect(result).toMatchObject({ exit: 0, stderr: "" });
  },
  processWatchdog(5),
);

test(
  "refuses a base settings file that is a symbolic link, whether it points into head or inside base",
  async () => {
    const cases: readonly (readonly [string, Changes, Changes])[] = [
      [
        "../head/settings.json",
        {},
        { ...growLong, "settings.json": withHealth({ maxFileLines: 1000 }) },
      ],
      [
        "base-fallow.json",
        {
          "base-fallow.json": readFileSync(
            join(SHIPPED_SETTINGS_DIR, ".fallowrc.json"),
            "utf8",
          ),
        },
        growLong,
      ],
    ];
    for (const [target, baseExtra, headChanges] of cases) {
      const { repo } = await createFixture();
      if (Object.keys(baseExtra).length > 0)
        commitIn(repo, "add target settings file in base", baseExtra);
      rmSync(join(repo, ".fallowrc.json"), { force: true });
      symlinkSync(target, join(repo, ".fallowrc.json"));
      git(repo, "add", ".fallowrc.json");
      git(repo, "commit", "-m", `link base settings to ${target}`);
      const baseSha = git(repo, "rev-parse", "HEAD");
      commitIn(repo, "head change", headChanges);

      const res = await runScriptDirect(repo, ["--base", baseSha]);
      expect(res.exit).toBe(2);
      expect(res.stderr).toContain(".fallowrc.json");
      expect(res.stderr).toContain("symbolic link");
      expect(res.stderr).toContain("Repair:");
    }
  },
  processWatchdog(5),
);

test(
  "fails closed with exit 2 when fallow suppressions reports malformed JSON, an invalid path, or an unrecognised marker line",
  async () => {
    const { repo, baseSha } = await createFixture();
    const cases: readonly (readonly [string, string])[] = [
      ["not json", "is not valid JSON"],
      ['{"files":"bad"}', 'invalid field "files"'],
      [
        JSON.stringify({
          files: [{ path: "../outside.ts", suppressions: [{ line: 1 }] }],
        }),
        "outside the measured tree",
      ],
      [
        JSON.stringify({
          files: [{ path: "src/commands.ts", suppressions: [{ line: 9999 }] }],
        }),
        "past the end of the file",
      ],
      [
        JSON.stringify({
          files: [{ path: "src/commands.ts", suppressions: [{ line: 1 }] }],
        }),
        "holds no recognised",
      ],
    ];
    for (const [payload, expected] of cases) {
      const stubDir = stubFolders("fallow-bad-suppressions-");
      const stubScript = join(stubDir, "stub.ts");
      const stubPath = join(stubDir, "stub.sh");
      write(
        stubDir,
        "stub.ts",
        `process.stdout.write(${JSON.stringify(payload)});\n`,
      );
      write(
        stubDir,
        "stub.sh",
        `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubScript)} "$@"\n`,
      );
      chmodSync(stubPath, 0o755);

      const res = await runScriptDirect(repo, [
        "--base",
        baseSha,
        "--fallow",
        stubPath,
      ]);
      expect(res.exit).toBe(2);
      expect(res.stderr).toContain(expected);
      expect(res.stderr).toContain("Repair:");
    }
  },
  processWatchdog(6),
);
