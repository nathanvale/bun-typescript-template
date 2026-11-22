import { afterAll, expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { processWatchdog } from "../../support/process.ts";
import {
  fixtureRepository,
  runFixtureGit,
  gitOutcome,
  removeFixtureTrees,
  repository,
  writeRecordedHits,
} from "./fixture-tree.ts";
import { write } from "../../support/fixture-files.ts";

afterAll(removeFixtureTrees);

async function installCommitHook(tree: string): Promise<string> {
  symlinkSync(join(repository, "node_modules"), join(tree, "node_modules"));
  await runFixtureGit(tree, "config", "core.hooksPath", ".githooks");
  return tree;
}

async function treeWithCommitHook(): Promise<string> {
  return installCommitHook(await fixtureRepository());
}

async function commitCount(tree: string): Promise<string> {
  const { stdout } = await gitOutcome(tree, "rev-list", "--count", "HEAD");
  return stdout.trim();
}

async function commitNew(tree: string, path: string) {
  write(tree, path, "notes\n");
  await runFixtureGit(tree, "add", "--", path);
  const commit = await gitOutcome(tree, "commit", "--quiet", "-m", "notes");
  return {
    exit: commit.exit,
    stderr: commit.stderr,
    committed: (await commitCount(tree)) === "2",
  };
}

test(
  "PC.a a staged new file whose name is refused stops the commit, naming the cause and the repair",
  async () => {
    const tree = await treeWithCommitHook();
    expect(await commitNew(tree, "docs/mutation-notes.md")).toEqual({
      exit: 1,
      stderr: [
        'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: Look in the glossary first; rename it with "Planted fault".',
        "pre-commit: the names check failed on the staged names (above). Repair: rename each name it lists as its line says, using git mv so the old name leaves the commit too, and commit again. Done when bun run check:names --staged passes.",
        "",
      ].join("\n"),
      committed: false,
    });
  },
  processWatchdog(7),
);

test(
  "PC.b a staged new file whose recorded hit is only an unstaged edit stops the commit",
  async () => {
    const tree = await treeWithCommitHook();
    writeRecordedHits(tree, [
      { path: "docs/host.md", word: "host", reason: "fixture" },
    ]);
    expect(await commitNew(tree, "docs/host.md")).toEqual({
      exit: 1,
      stderr: [
        'docs/host.md uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.',
        "pre-commit: the names check failed on the staged names (above). Repair: rename each name it lists as its line says, using git mv so the old name leaves the commit too, and commit again. Done when bun run check:names --staged passes.",
        "",
      ].join("\n"),
      committed: false,
    });
  },
  processWatchdog(7),
);

test(
  "a staged new file with a clean name is committed",
  async () => {
    const tree = await treeWithCommitHook();
    expect(await commitNew(tree, "docs/planted-fault-notes.md")).toMatchObject({
      exit: 0,
      committed: true,
    });
  },
  processWatchdog(7),
);

const sourcePath = "src/index.ts";
const initialSource = "export const value: number = 1;\n";
const configPath = "tsconfig.base.json";
const initialConfig = '{\n\t"compilerOptions": { "types": [] }\n}\n';

async function treeWithStagedTypeCheck(): Promise<string> {
  const tree = await fixtureRepository();
  write(
    tree,
    "eslint.config.mjs",
    'import { parser } from "typescript-eslint";\n\nexport default [{ files: ["**/*.ts"], languageOptions: { parser } }];\n',
  );
  write(
    tree,
    "tsconfig.json",
    '{\n\t"extends": "./tsconfig.base.json",\n\t"files": ["src/index.ts"]\n}\n',
  );
  write(tree, configPath, initialConfig);
  write(tree, sourcePath, initialSource);
  await runFixtureGit(
    tree,
    "add",
    "--",
    "eslint.config.mjs",
    "tsconfig.json",
    configPath,
    sourcePath,
  );
  await runFixtureGit(tree, "commit", "--quiet", "-m", "types");
  return installCommitHook(tree);
}

async function expectTypeRefusal(tree: string, diagnostic: string | RegExp) {
  const refused = await gitOutcome(tree, "commit", "--quiet", "-m", "value");
  expect(refused.exit).toBe(1);
  expect(refused.stderr).toContain(
    "pre-commit: TypeScript rejected the staged tree (above). Repair: fix the type errors and stage the repaired files. Done when git commit passes the staged type check.",
  );
  expect(stripVTControlCharacters(refused.stderr)).toMatch(diagnostic);
  expect(await commitCount(tree)).toBe("2");
}

test(
  "PC.c the pre-commit type check uses the staged contents of a partially staged file",
  async () => {
    const tree = await treeWithStagedTypeCheck();
    const valid = "export const value: number = 2;\n";
    const invalid = 'export const value: number = "one";\n';
    write(tree, sourcePath, invalid);
    await runFixtureGit(tree, "add", "--", sourcePath);
    write(tree, sourcePath, valid);

    await expectTypeRefusal(
      tree,
      "error TS2322: Type 'string' is not assignable to type 'number'.",
    );
    expect(await gitOutcome(tree, "show", `:${sourcePath}`)).toMatchObject({
      exit: 0,
      stdout: invalid,
    });

    await runFixtureGit(tree, "add", "--", sourcePath);
    write(tree, sourcePath, invalid);
    await runFixtureGit(tree, "commit", "--quiet", "-m", "value");
    expect(await gitOutcome(tree, "show", `HEAD:${sourcePath}`)).toMatchObject({
      exit: 0,
      stdout: valid,
    });
    expect(await Bun.file(join(tree, sourcePath)).text()).toBe(invalid);
  },
  processWatchdog(13),
);

test(
  "PC.d a staged compiler config change triggers the staged type check",
  async () => {
    const tree = await treeWithStagedTypeCheck();
    const invalid =
      '{\n\t"compilerOptions": { "types": ["staged-config-probe"] }\n}\n';
    write(tree, configPath, invalid);
    await runFixtureGit(tree, "add", "--", configPath);
    write(tree, configPath, initialConfig);

    await expectTypeRefusal(
      tree,
      "error TS2688: Cannot find type definition file for 'staged-config-probe'.",
    );
    expect(await gitOutcome(tree, "show", `:${configPath}`)).toMatchObject({
      exit: 0,
      stdout: invalid,
    });
  },
  processWatchdog(10),
);

test(
  "PC.e a staged source removal triggers the staged type check",
  async () => {
    const tree = await treeWithStagedTypeCheck();
    await runFixtureGit(tree, "rm", "--", sourcePath);
    write(tree, sourcePath, initialSource);

    await expectTypeRefusal(
      tree,
      /error TS6053: File '.*\/src\/index\.ts' not found\./,
    );
    expect(
      await gitOutcome(tree, "diff", "--cached", "--name-status"),
    ).toMatchObject({
      exit: 0,
      stdout: `D\t${sourcePath}\n`,
    });
  },
  processWatchdog(10),
);
