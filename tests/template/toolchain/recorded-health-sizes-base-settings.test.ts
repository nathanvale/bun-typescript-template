import { expect, test } from "bun:test";
import { chmodSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
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
const INERT = ["fallow", "inert"].join("-");
const growLong: Changes = { "src/long.ts": longFileSource(520) };

function withHealth(health: Readonly<Record<string, unknown>>): string {
  return withFallowSettings((shipped) => ({
    ...shipped,
    health: { ...shipped.health, ...health },
  }));
}

test(
  "makes only comment markers inert, keeping settings values and non-comment file contents intact",
  async () => {
    const { repo } = await createFixture();
    const literalLine = `export const marker = "// ${MARKER}-file complexity";`;
    const pathLine = `export const dir = ".${MARKER}/long.ts";`;
    const templateLine = `export const tpl = \`/* ${MARKER}-next-line complexity */\`;`;
    const regexLine = 'if (true) /`/.test("a");';
    const jsxCloseLine = `export const el = () => <div>ok</div>; // ${MARKER}-next-line complexity`;
    const lineComment = `// ${MARKER}-next-line complexity -- hide it`;
    const blockComment = `/* ${MARKER}-next-line complexity */`;
    const htmlAttr = `title="<!-- ${MARKER}-file -->"`;
    const { sha: baseSha } = commitIn(
      repo,
      "add settings and literal markers",
      {
        ".fallowrc.json": withFallowSettings((shipped) => ({
          ...shipped,
          ignorePatterns: [...shipped.ignorePatterns, `!.${MARKER}/**`],
        })),
        "src/commands.ts": `${literalLine}\n${pathLine}\n${templateLine}\n${regexLine}\n${lineComment}\n${routeSource(20, 1)}\n${blockComment}\n${nestSource(false)}`,
        "src/view.tsx": `${jsxCloseLine}\n`,
        "src/view.html": `<div ${htmlAttr}>Don't</div>\n<!-- ${MARKER}-file complexity -->\n`,
        "src/page.astro": `---\n// ${MARKER}-file complexity\n---\n<!-- ${MARKER}-next-line complexity -->\n`,
      },
    );
    commitIn(repo, "change head settings", {
      ".fallowrc.json": withHealth({ maxFileLines: 1000 }),
    });

    const stubDir = stubFolders("fallow-stub-");
    const stubScript = join(stubDir, "fallow-stub.ts");
    const stubPath = join(stubDir, "fallow-stub.sh");
    write(
      stubDir,
      "fallow-stub.ts",
      `import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const cfg = args[args.indexOf("--config") + 1] ?? "";
const root = args[args.indexOf("--root") + 1] ?? "";
if (lstatSync(cfg).isSymbolicLink()) throw new Error("config is a symlink");
if (cfg.startsWith(\`\${root}/\`)) throw new Error("config is inside measured tree");
if (!readFileSync(cfg, "utf8").includes(${JSON.stringify(`!.${MARKER}/**`)})) throw new Error("settings rewritten");
const treeCfg = readFileSync(join(root, ".fallowrc.json"), "utf8");
if (treeCfg.includes(${JSON.stringify(INERT)})) throw new Error("tree json rewritten");
const commands = readFileSync(join(root, "src/commands.ts"), "utf8");
for (const keep of [${JSON.stringify(literalLine)}, ${JSON.stringify(pathLine)}, ${JSON.stringify(templateLine)}])
  if (!commands.includes(keep)) throw new Error(\`non-comment rewritten: \${keep}\`);
if (!commands.includes(${JSON.stringify(`// ${INERT}-next-line complexity -- hide it`)}) || !commands.includes(${JSON.stringify(`/* ${INERT}-next-line complexity */`)}))
  throw new Error("code comment marker stayed active");
const tsx = readFileSync(join(root, "src/view.tsx"), "utf8");
if (!tsx.includes(${JSON.stringify(`// ${INERT}-next-line complexity`)})) throw new Error("jsx closing tag broke comment marker");
const html = readFileSync(join(root, "src/view.html"), "utf8");
if (!html.includes(${JSON.stringify(htmlAttr)})) throw new Error("html attribute rewritten");
if (!html.includes(${JSON.stringify(`<!-- ${INERT}-file complexity -->`)})) throw new Error("html comment marker stayed active");
const astro = readFileSync(join(root, "src/page.astro"), "utf8");
if (!astro.includes(${JSON.stringify(`// ${INERT}-file complexity`)}) || !astro.includes(${JSON.stringify(`<!-- ${INERT}-next-line complexity -->`)}))
  throw new Error("astro marker stayed active");
process.stdout.write('{"findings":[]}\\n');
`,
    );
    write(
      stubDir,
      "fallow-stub.sh",
      `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(stubScript)} "$@"\n`,
    );
    chmodSync(stubPath, 0o755);

    const result = await runScriptDirect(repo, [
      "--base",
      baseSha,
      "--fallow",
      stubPath,
    ]);
    expect(result).toMatchObject({ exit: 0, stderr: "" });
  },
  processWatchdog(3),
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
