import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const changesetBinary = join(ROOT, "node_modules/.bin/changeset");
const folder = ownedFolders();

const earlierChangesSection = [
  "## Earlier changes",
  "",
  "- feat: initial bootstrap ([#1](https://example.test/pull/1))",
  "- fix: keep trailing history intact ([#2](https://example.test/pull/2))",
  "",
].join("\n");

const initialChangelog = `# demo-app\n\n${earlierChangesSection}`;

function createGeneratedChangesetFixture(
  extraFiles: Record<string, string> = {},
): string {
  const repo = folder("changeset-version-");
  initRepository(repo);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  commitIn(repo, "base", {
    ".gitignore": "node_modules\n",
    ".changeset/config.json": readFileSync(
      join(ROOT, "generated-repository/changeset/config.json"),
      "utf8",
    ),
    ".changeset/README.md": readFileSync(
      join(ROOT, "generated-repository/changeset/README.md"),
      "utf8",
    ),
    "package.json": `${JSON.stringify({ name: "demo-app", version: "0.1.0", private: true }, null, 2)}\n`,
    "CHANGELOG.md": initialChangelog,
    ...extraFiles,
  });
  return repo;
}

function runChangesetVersion(repo: string) {
  return runChangeset(repo, ["version"]);
}

function runChangeset(repo: string, args: readonly string[]) {
  return spawnBounded([process.execPath, changesetBinary, ...args], {
    cwd: repo,
    env: { ...inherited(), ...gitEnv, NO_COLOR: "1", FORCE_COLOR: "0" },
    processGroup: true,
  });
}

describe("generated-repository/changeset/config.json with changeset version", () => {
  test(
    "bumps package.json, writes the minor version above an unchanged Earlier changes section, and deletes the consumed changeset",
    async () => {
      const changesetPath = ".changeset/2026-11-25-add-widget.md";
      const repo = createGeneratedChangesetFixture({
        [changesetPath]:
          '---\n"demo-app": minor\n---\n\nAdded widget command.\n',
      });

      const run = await runChangesetVersion(repo);

      expect(run.exit).toBe(0);
      const packageRecord = JSON.parse(
        readFileSync(join(repo, "package.json"), "utf8"),
      ) as { version?: string };
      expect(packageRecord.version).toBe("0.2.0");
      expect(existsSync(join(repo, changesetPath))).toBe(false);

      const changelog = readFileSync(join(repo, "CHANGELOG.md"), "utf8");
      const versionHeadingIndex = changelog.indexOf("## 0.2.0");
      const earlierHeadingIndex = changelog.indexOf("## Earlier changes");
      expect(versionHeadingIndex).toBeGreaterThan(-1);
      expect(earlierHeadingIndex).toBeGreaterThan(versionHeadingIndex);
      expect(changelog).toContain("Added widget command.");
      expect(changelog.slice(earlierHeadingIndex)).toBe(earlierChangesSection);
    },
    processWatchdog(1),
  );

  test(
    "exits 1 and changes no file when no changeset is pending",
    async () => {
      const repo = createGeneratedChangesetFixture();

      const run = await runChangesetVersion(repo);

      expect(run.exit).toBe(1);
      expect(run.stdout).toContain("No unreleased changesets found.");
      expect(git(repo, "status", "--porcelain")).toBe("");
    },
    processWatchdog(1),
  );
  test(
    "the documented release steps leave changeset status green on the version branch only once an empty changeset is added",
    async () => {
      const repo = createGeneratedChangesetFixture({
        ".changeset/2026-11-25-add-widget.md":
          '---\n"demo-app": minor\n---\n\nAdded widget command.\n',
      });
      git(repo, "switch", "--quiet", "-c", "release");
      expect((await runChangesetVersion(repo)).exit).toBe(0);
      git(
        repo,
        "add",
        "--all",
        "--",
        "package.json",
        "CHANGELOG.md",
        ".changeset",
      );
      git(repo, "commit", "--quiet", "-m", "version");

      expect(
        (await runChangeset(repo, ["status", "--since", "main"])).exit,
      ).toBe(1);

      expect((await runChangeset(repo, ["add", "--empty"])).exit).toBe(0);
      git(repo, "add", "--", ".changeset");
      git(repo, "commit", "--quiet", "-m", "empty changeset");

      expect(
        (await runChangeset(repo, ["status", "--since", "main"])).exit,
      ).toBe(0);
    },
    processWatchdog(1),
  );
});
