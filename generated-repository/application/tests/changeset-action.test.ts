import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { readChangesets } from "@changesets/read";
import { testFolder } from "./support/test-folder.ts";

const repoRoot = resolve(import.meta.dir, "..");
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

const packageName = "__REPOSITORY_NAME__";
const major = `---\n"${packageName}": major\n---\n\n`;
const minor = `---\n"${packageName}": minor\n---\n\n`;

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
    `${major}Removed x.\n\nAction: use y.\n`,
  ],
  ["a minor with no Action line", `${minor}Added x.\n`],
  ["an empty changeset", "---\n---\n\n"],
])("admits %s", async (_case, content) => {
  const root = plantedRoot(".changeset/x.md", content);
  expect(await majorChangesetsLackingAction(root)).toEqual([]);
});

test("every major changeset in this repository names the reader's action", async () => {
  expect(await majorChangesetsLackingAction(repoRoot)).toEqual([]);
});
