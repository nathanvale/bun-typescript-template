import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { REPOSITORY_RECIPE_COPIES } from "../../../src/recipe.ts";
import {
  classifyTemplateUpgradeFileOwner,
  diffTemplateUpgradeCopyChanges,
  isTemplateUpgradeConflict,
  mergeTemplateUpgradeTrees,
} from "../../../src/template-upgrade-merge.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";

const folder = ownedFolders();

function makeSymlink(root: string, path: string, target: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  symlinkSync(target, fullPath);
}

function makeThreeTreeFolders(prefix: string) {
  return {
    oldDir: folder(`${prefix}-old-`),
    newDir: folder(`${prefix}-new-`),
    oursDir: folder(`${prefix}-ours-`),
  };
}

function seedRepositoryStartingCopies() {
  const { oldDir, newDir, oursDir } = makeThreeTreeFolders("repo-copy");
  write(oldDir, "README.md", "# starter v1\n");
  write(newDir, "README.md", "# starter v2\n");
  write(oursDir, "README.md", "# starter v1\n");
  write(oldDir, "src/cli.ts", "export const v = 1;\n");
  write(newDir, "src/cli.ts", "export const v = 2;\n");
  write(oursDir, "src/cli.ts", "export const custom = true;\n");
  write(oldDir, "src/commands.ts", "export const commands = ['a'];\n");
  write(newDir, "src/commands.ts", "export const commands = ['b'];\n");
  write(oursDir, "src/commands.ts", "export const commands = ['b'];\n");
  write(oldDir, "tests/cli.test.ts", "test('same', () => {});\n");
  write(newDir, "tests/cli.test.ts", "test('same', () => {});\n");
  write(oursDir, "tests/cli.test.ts", "test('owner', () => {});\n");
  return { oldDir, newDir, oursDir };
}

test("classifies generated, repository, shared (including root *.toml), and template paths per MAG-108", () => {
  expect(classifyTemplateUpgradeFileOwner(".cli-design-template.json")).toBe(
    "generated",
  );
  expect(classifyTemplateUpgradeFileOwner("bun.lock")).toBe("generated");
  expect(classifyTemplateUpgradeFileOwner(".claude/skills/verify-cli")).toBe(
    "generated",
  );

  expect(REPOSITORY_RECIPE_COPIES).toEqual([
    "README.md",
    "src/cli.ts",
    "src/commands.ts",
    "tests/cli.test.ts",
  ]);
  for (const path of REPOSITORY_RECIPE_COPIES) {
    expect(classifyTemplateUpgradeFileOwner(path)).toBe("repository");
  }

  expect(classifyTemplateUpgradeFileOwner("package.json")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner("tsconfig.json")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner("tsconfig.base.json")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner(".fallowrc.json")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner("biome.json")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner("bunfig.toml")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner("custom.toml")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner(".gitignore")).toBe("shared");
  expect(classifyTemplateUpgradeFileOwner(".github/workflows/ci.yml")).toBe(
    "shared",
  );
  expect(classifyTemplateUpgradeFileOwner("AGENTS.md")).toBe("shared");

  expect(classifyTemplateUpgradeFileOwner("config/template-rules.mjs")).toBe(
    "template",
  );
  expect(
    classifyTemplateUpgradeFileOwner(".agents/skills/verify-cli/SKILL.md"),
  ).toBe("template");
  expect(
    classifyTemplateUpgradeFileOwner("tests/add-on-start-up.test.ts"),
  ).toBe("template");
  expect(classifyTemplateUpgradeFileOwner("nested/settings.json")).toBe(
    "template",
  );
  expect(classifyTemplateUpgradeFileOwner("nested/settings.toml")).toBe(
    "template",
  );
});

test("identifies conflict outcomes accurately", () => {
  expect(isTemplateUpgradeConflict("conflict")).toBe(true);
  expect(isTemplateUpgradeConflict("conflict-add")).toBe(true);
  expect(isTemplateUpgradeConflict("conflict-delete")).toBe(true);
  expect(isTemplateUpgradeConflict("conflict-link")).toBe(true);
  expect(isTemplateUpgradeConflict("merge")).toBe(false);
  expect(isTemplateUpgradeConflict("take")).toBe(false);
  expect(isTemplateUpgradeConflict("delete")).toBe(false);
  expect(isTemplateUpgradeConflict("regenerate")).toBe(false);
  expect(isTemplateUpgradeConflict("untouched")).toBe(false);
  expect(isTemplateUpgradeConflict("already-applied")).toBe(false);
  expect(isTemplateUpgradeConflict("template-copy-changed")).toBe(false);
});

test("merges untouched, already, take, delete, stamp, bun.lock, and repository-only paths", async () => {
  const { oldDir, newDir, oursDir } = makeThreeTreeFolders("merge-basic");
  write(oldDir, "untouched.txt", "same\n");
  write(newDir, "untouched.txt", "same\n");
  write(oursDir, "untouched.txt", "owner-kept\n");
  write(oldDir, ".github/workflows/ci.yml", "old-ci\n");
  write(newDir, ".github/workflows/ci.yml", "new-ci\n");
  write(oursDir, ".github/workflows/ci.yml", "new-ci\n");
  write(oldDir, "AGENTS.md", "old-agents\n");
  write(newDir, "AGENTS.md", "new-agents\n");
  write(oursDir, "AGENTS.md", "old-agents\n");
  write(oldDir, "tests/removed.test.ts", "old-test\n");
  write(oursDir, "tests/removed.test.ts", "old-test\n");
  write(oldDir, ".cli-design-template.json", '{"templateRevision":"old"}\n');
  write(newDir, ".cli-design-template.json", '{"templateRevision":"new"}\n');
  write(
    oursDir,
    ".cli-design-template.json",
    '{"templateRevision":"hand-edited"}\n',
  );
  write(oldDir, "bun.lock", "lock-v1\n");
  write(newDir, "bun.lock", "lock-v2\n");
  write(oursDir, "bun.lock", "lock-owner\n");
  write(oldDir, "package.json", '{"name":"demo","version":"0.0.1"}\n');
  write(newDir, "package.json", '{"name":"demo","version":"0.0.2"}\n');
  write(oursDir, "package.json", '{"name":"demo","version":"0.0.1"}\n');
  write(oursDir, "src/repository-only.ts", "export const owned = true;\n");

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    {
      path: ".cli-design-template.json",
      ownerLabel: "generated",
      outcome: "take",
    },
    {
      path: ".github/workflows/ci.yml",
      ownerLabel: "shared",
      outcome: "already-applied",
    },
    { path: "AGENTS.md", ownerLabel: "shared", outcome: "take" },
    { path: "bun.lock", ownerLabel: "generated", outcome: "regenerate" },
    { path: "package.json", ownerLabel: "shared", outcome: "take" },
    {
      path: "tests/removed.test.ts",
      ownerLabel: "template",
      outcome: "delete",
    },
    { path: "untouched.txt", ownerLabel: "template", outcome: "untouched" },
  ]);
  expect(readFileSync(join(oursDir, "untouched.txt"), "utf8")).toBe(
    "owner-kept\n",
  );
  expect(readFileSync(join(oursDir, "AGENTS.md"), "utf8")).toBe("new-agents\n");
  expect(existsSync(join(oursDir, "tests/removed.test.ts"))).toBe(false);
  expect(readFileSync(join(oursDir, ".cli-design-template.json"), "utf8")).toBe(
    '{"templateRevision":"new"}\n',
  );
  expect(readFileSync(join(oursDir, "bun.lock"), "utf8")).toBe("lock-owner\n");
  expect(readFileSync(join(oursDir, "src/repository-only.ts"), "utf8")).toBe(
    "export const owned = true;\n",
  );
});

test("merges JSON keys and clean text edits, and marks conflicting JSON and text files", async () => {
  const { oldDir, newDir, oursDir } = makeThreeTreeFolders("merge-text");
  write(
    oldDir,
    "package.json",
    `${JSON.stringify({ name: "demo", devDependencies: { biome: "2.6.7" } }, null, 2)}\n`,
  );
  write(
    newDir,
    "package.json",
    `${JSON.stringify({ name: "demo", engines: { bun: ">=1.4.4" }, devDependencies: { biome: "2.6.8" } }, null, 2)}\n`,
  );
  write(
    oursDir,
    "package.json",
    `${JSON.stringify({ name: "demo", bin: { demo: "./src/cli.ts" }, devDependencies: { biome: "2.6.7" } }, null, 2)}\n`,
  );
  write(oldDir, "biome.json", '{\n  "indentWidth": 2\n}\n');
  write(newDir, "biome.json", '{\n  "indentWidth": 4\n}\n');
  write(oursDir, "biome.json", '{\n  "indentWidth": 8\n}\n');
  write(oldDir, "notes.txt", "line 1\nline 2\nline 3\nline 4\n");
  write(newDir, "notes.txt", "line 1\nline 2\nline 3\nline 4 new\n");
  write(oursDir, "notes.txt", "line 1 ours\nline 2\nline 3\nline 4\n");
  write(oldDir, "conflict.txt", "alpha\n");
  write(newDir, "conflict.txt", "beta\n");
  write(oursDir, "conflict.txt", "gamma\n");

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: "biome.json", ownerLabel: "shared", outcome: "conflict" },
    { path: "conflict.txt", ownerLabel: "template", outcome: "conflict" },
    { path: "notes.txt", ownerLabel: "template", outcome: "merge" },
    { path: "package.json", ownerLabel: "shared", outcome: "merge" },
  ]);
  expect(
    JSON.parse(readFileSync(join(oursDir, "package.json"), "utf8")),
  ).toEqual({
    name: "demo",
    engines: { bun: ">=1.4.4" },
    bin: { demo: "./src/cli.ts" },
    devDependencies: { biome: "2.6.8" },
  });
  expect(readFileSync(join(oursDir, "biome.json"), "utf8")).toContain(
    "<<<<<<< ours",
  );
  expect(readFileSync(join(oursDir, "notes.txt"), "utf8")).toBe(
    "line 1 ours\nline 2\nline 3\nline 4 new\n",
  );
  expect(readFileSync(join(oursDir, "conflict.txt"), "utf8")).toContain(
    "<<<<<<< ours",
  );
});

test("records conflict-add and conflict-delete outcomes without dropping owner edits", async () => {
  const { oldDir, newDir, oursDir } = makeThreeTreeFolders("merge-add-del");
  write(newDir, "added.txt", "from template\n");
  write(oursDir, "added.txt", "from owner\n");
  write(oldDir, "deleted-in-new.txt", "base\n");
  write(oursDir, "deleted-in-new.txt", "owner-modified\n");
  write(oldDir, "deleted-in-ours.txt", "base\n");
  write(newDir, "deleted-in-ours.txt", "template-modified\n");

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: "added.txt", ownerLabel: "template", outcome: "conflict-add" },
    {
      path: "deleted-in-new.txt",
      ownerLabel: "template",
      outcome: "conflict-delete",
    },
    {
      path: "deleted-in-ours.txt",
      ownerLabel: "template",
      outcome: "conflict-delete",
    },
  ]);
  expect(readFileSync(join(oursDir, "added.txt"), "utf8")).toContain(
    "<<<<<<< ours",
  );
  expect(readFileSync(join(oursDir, "deleted-in-new.txt"), "utf8")).toBe(
    "<<<<<<< ours\nowner-modified\n=======\n>>>>>>> new (deleted by template)\n",
  );
  expect(readFileSync(join(oursDir, "deleted-in-ours.txt"), "utf8")).toBe(
    "<<<<<<< ours (deleted by owner)\n=======\ntemplate-modified\n>>>>>>> new\n",
  );
});

test("updates unchanged symlinks and reports conflict-link when both sides change a symlink", async () => {
  const { oldDir, newDir, oursDir } = makeThreeTreeFolders("merge-links");
  makeSymlink(oldDir, ".claude/skills/same-skill", "../../.agents/skills/same");
  makeSymlink(newDir, ".claude/skills/same-skill", "../../.agents/skills/same");
  makeSymlink(
    oursDir,
    ".claude/skills/same-skill",
    "../../.agents/skills/same",
  );
  makeSymlink(oldDir, ".claude/skills/moved-skill", "../../.agents/skills/v1");
  makeSymlink(newDir, ".claude/skills/moved-skill", "../../.agents/skills/v2");
  makeSymlink(oursDir, ".claude/skills/moved-skill", "../../.agents/skills/v1");
  makeSymlink(
    oldDir,
    ".claude/skills/conflict-skill",
    "../../.agents/skills/a",
  );
  makeSymlink(
    newDir,
    ".claude/skills/conflict-skill",
    "../../.agents/skills/b",
  );
  makeSymlink(
    oursDir,
    ".claude/skills/conflict-skill",
    "../../.agents/skills/c",
  );

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    {
      path: ".claude/skills/conflict-skill",
      ownerLabel: "generated",
      outcome: "conflict-link",
    },
    {
      path: ".claude/skills/moved-skill",
      ownerLabel: "generated",
      outcome: "take",
    },
    {
      path: ".claude/skills/same-skill",
      ownerLabel: "generated",
      outcome: "untouched",
    },
  ]);
  expect(readlinkSync(join(oursDir, ".claude/skills/moved-skill"))).toBe(
    "../../.agents/skills/v2",
  );
  expect(readlinkSync(join(oursDir, ".claude/skills/conflict-skill"))).toBe(
    "../../.agents/skills/c",
  );
});

test("repository-owned starting copies are never written, whatever the repository holds, and diffTemplateUpgradeCopyChanges produces their diff", async () => {
  const { oldDir, newDir, oursDir } = seedRepositoryStartingCopies();
  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    {
      path: "README.md",
      ownerLabel: "repository",
      outcome: "template-copy-changed",
    },
    {
      path: "src/cli.ts",
      ownerLabel: "repository",
      outcome: "template-copy-changed",
    },
    {
      path: "src/commands.ts",
      ownerLabel: "repository",
      outcome: "template-copy-changed",
    },
    {
      path: "tests/cli.test.ts",
      ownerLabel: "repository",
      outcome: "untouched",
    },
  ]);
  expect(readFileSync(join(oursDir, "README.md"), "utf8")).toBe(
    "# starter v1\n",
  );
  expect(readFileSync(join(oursDir, "src/cli.ts"), "utf8")).toBe(
    "export const custom = true;\n",
  );
  expect(readFileSync(join(oursDir, "src/commands.ts"), "utf8")).toBe(
    "export const commands = ['b'];\n",
  );
  expect(readFileSync(join(oursDir, "tests/cli.test.ts"), "utf8")).toBe(
    "test('owner', () => {});\n",
  );

  const diffs = await diffTemplateUpgradeCopyChanges(oldDir, newDir, rows);
  expect(diffs.map((entry) => entry.path)).toEqual([
    "README.md",
    "src/cli.ts",
    "src/commands.ts",
  ]);
  expect(diffs[0]?.diff).toContain("--- old/README.md");
  expect(diffs[0]?.diff).toContain("+++ new/README.md");
  expect(diffs[0]?.diff).toContain("-# starter v1");
  expect(diffs[0]?.diff).toContain("+# starter v2");
});

test("bun.lock never takes the template lockfile: stays untouched when package.json is unchanged and marks regenerate when package.json changed", async () => {
  const unchanged = makeThreeTreeFolders("lock-unchanged-pkg");
  write(unchanged.oldDir, "bun.lock", "lock-v1\n");
  write(unchanged.newDir, "bun.lock", "lock-v2\n");
  write(unchanged.oursDir, "bun.lock", "lock-v1\n");
  write(unchanged.oldDir, "package.json", '{"name":"demo"}\n');
  write(unchanged.newDir, "package.json", '{"name":"demo"}\n');
  write(unchanged.oursDir, "package.json", '{"name":"demo"}\n');

  const unchangedRows = await mergeTemplateUpgradeTrees(
    unchanged.oldDir,
    unchanged.newDir,
    unchanged.oursDir,
  );
  expect(unchangedRows).toEqual([
    { path: "bun.lock", ownerLabel: "generated", outcome: "untouched" },
    { path: "package.json", ownerLabel: "shared", outcome: "untouched" },
  ]);
  expect(readFileSync(join(unchanged.oursDir, "bun.lock"), "utf8")).toBe(
    "lock-v1\n",
  );

  const changed = makeThreeTreeFolders("lock-changed-pkg");
  write(changed.oldDir, "bun.lock", "lock-v1\n");
  write(changed.newDir, "bun.lock", "lock-v2\n");
  write(changed.oursDir, "bun.lock", "lock-v1\n");
  write(changed.oldDir, "package.json", '{"name":"demo","version":"0.0.1"}\n');
  write(changed.newDir, "package.json", '{"name":"demo","version":"0.0.2"}\n');
  write(changed.oursDir, "package.json", '{"name":"demo","version":"0.0.1"}\n');

  const changedRows = await mergeTemplateUpgradeTrees(
    changed.oldDir,
    changed.newDir,
    changed.oursDir,
  );
  expect(changedRows).toEqual([
    { path: "bun.lock", ownerLabel: "generated", outcome: "regenerate" },
    { path: "package.json", ownerLabel: "shared", outcome: "take" },
  ]);
  expect(readFileSync(join(changed.oursDir, "bun.lock"), "utf8")).toBe(
    "lock-v1\n",
  );
});
