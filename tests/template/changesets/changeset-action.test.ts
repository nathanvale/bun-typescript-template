import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readChangesets } from "@changesets/read";
import { initRepository } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";

const repoRoot = resolve(import.meta.dir, "../../..");
const actionLine = /^Action: \S/;

const created: string[] = [];
afterAll(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

async function majorChangesetsLackingAction(root: string): Promise<string[]> {
  const changesets = await readChangesets(root);
  return changesets
    .filter((changeset) =>
      changeset.releases.some((release) => release.type === "major"),
    )
    .filter(
      (changeset) =>
        !changeset.summary
          .split("\n")
          .slice(1)
          .some((line) => actionLine.test(line)),
    )
    .map((changeset) => changeset.id);
}

function plantedRoot(changesetPath: string, content: string): string {
  const root = testFolder("changeset-action-");
  created.push(root);
  mkdirSync(join(root, ".changeset"));
  writeFileSync(join(root, ".changeset/README.md"), "# Changesets\n");
  mkdirSync(dirname(join(root, changesetPath)), { recursive: true });
  writeFileSync(join(root, changesetPath), content);
  return root;
}

const major = '---\n"bun-typescript-template": major\n---\n\n';

test.each([
  ["a major with no Action line", ".changeset/x.md", `${major}Removed x.\n`],
  [
    "a major whose only Action line is its first line",
    ".changeset/x.md",
    `${major}Action: use y.\n`,
  ],
  [
    "a major with a bold Action label",
    ".changeset/x.md",
    `${major}Removed x.\n\n**Action:** use y.\n`,
  ],
  [
    "a major in pre/ with no Action line",
    ".changeset/pre/x.md",
    `${major}Removed x.\n`,
  ],
])("refuses %s", async (_case, changesetPath, content) => {
  const root = plantedRoot(changesetPath, content);
  expect(await majorChangesetsLackingAction(root)).toEqual([
    changesetPath.replace(/^\.changeset\//, "").replace(/\.md$/, ""),
  ]);
});

test.each([
  [
    "a major with an Action line after its summary",
    ".changeset/x.md",
    `${major}Removed x.\n\nAction: use y.\n`,
  ],
  [
    "a major in pre/ with an Action line after its summary",
    ".changeset/pre/x.md",
    `${major}Removed x.\n\nAction: use y.\n`,
  ],
  [
    "a minor with no Action line",
    ".changeset/x.md",
    '---\n"bun-typescript-template": minor\n---\n\nAdded x.\n',
  ],
  ["an empty changeset", ".changeset/x.md", "---\n---\n\n"],
])("admits %s", async (_case, changesetPath, content) => {
  const root = plantedRoot(changesetPath, content);
  expect(await majorChangesetsLackingAction(root)).toEqual([]);
});

test("every major changeset in this repository names the reader's action", async () => {
  expect(await majorChangesetsLackingAction(repoRoot)).toEqual([]);
});

test(
  "generated changeset-action test stays Biome-formatted after substituting a 42-character repository name",
  async () => {
    const root = testFolder("changeset-action-format-");
    created.push(root);
    initRepository(root);
    writeFileSync(join(root, ".gitignore"), "");
    const source = readFileSync(
      join(
        repoRoot,
        "generated-repository/application/tests/changeset-action.test.ts",
      ),
      "utf8",
    );
    const substituted = source.replaceAll(
      "__REPOSITORY_NAME__",
      "changesets-bootstrap-formatting-review-app",
    );
    const target = join(root, "changeset-action.test.ts");
    writeFileSync(
      join(root, "biome.json"),
      readFileSync(
        join(repoRoot, "generated-repository/settings/biome.json"),
        "utf8",
      ),
    );
    writeFileSync(target, substituted);
    const biome = join(repoRoot, "node_modules/.bin/biome");
    const run = await spawnBounded(
      [biome, "format", "changeset-action.test.ts"],
      { cwd: root, processGroup: true },
    );
    expect(run.exit).toBe(0);
    expect(run.stderr).not.toContain("Formatter would have printed");
  },
  processWatchdog(1),
);
