import { expect, test } from "bun:test";
import { symlinkSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import { parseGitTreeEntries } from "../../../src/git-identities.ts";
import { readTemplateUpgradeChangesets } from "../../../src/template-upgrade-changesets.ts";
import {
  createTemplateUpgradeApplyRun,
  createTemplateUpgradePlanResult,
  skipTemplateUpgradeSteps,
} from "../../../src/template-upgrade-report.ts";
import { templateUpgradeCommitMessage } from "../../../src/template-upgrade-worktree.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  initRepository,
} from "../../support/git-fixture.ts";
import {
  commitObjects,
  stageRawPath,
} from "../../support/git-object-fixture.ts";

const folder = ownedFolders();

function captureCliError(fn: () => unknown): CliError | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof CliError ? error : undefined;
  }
}

test("readTemplateUpgradeChangesets handles empty trees, cross-boundary stem dedup, pre-switchover refusal, major-first ordering, Action extraction, and commit/report builders", () => {
  expect(
    parseGitTreeEntries(Buffer.from("100644 blob abc123\t.changeset/a.md\0")),
  ).toEqual(new Map([[".changeset/a.md", "100644 blob abc123"]]));

  const repo = folder("changeset-unit-");
  initRepository(repo);
  const neither = commitIn(repo, "no notes or changesets", {
    "README.md": "# Template\n",
  }).sha;
  expect(readTemplateUpgradeChangesets(repo, neither, neither, gitEnv)).toEqual(
    [],
  );

  const stillNeither = commitIn(repo, "still neither", {
    "README.md": "# Template v2\n",
  }).sha;
  expect(
    readTemplateUpgradeChangesets(repo, neither, stillNeither, gitEnv),
  ).toEqual([]);

  const preSwitchover = commitIn(repo, "pre-switchover change-notes", {
    "change-notes/README.md": "# Change notes\n",
    "change-notes/2026-11-20-converted.json": JSON.stringify({
      kind: "added",
      breaking: false,
      affects: ["bootstrap"],
      summary: "Converted later.",
      action: null,
    }),
  }).sha;

  const predatedRefusal = captureCliError(() =>
    readTemplateUpgradeChangesets(repo, neither, preSwitchover, gitEnv),
  );
  expect(predatedRefusal?.exitCode).toBe(1);
  expect(predatedRefusal?.message).toContain(
    "predates the Changesets switchover",
  );
  expect(predatedRefusal?.repair).toContain(
    `run upgrade from a template checkout at ${preSwitchover.slice(0, 7)}`,
  );

  git(repo, "rm", "--quiet", "-r", "change-notes");
  const postSwitchover = commitIn(repo, "switchover commit", {
    ".changeset/README.md": "# Changesets\n",
    ".changeset/config.json": "{}\n",
    ".changeset/pre/README.md": "# Pre\n",
    ".changeset/2026-11-20-converted.md":
      '---\n"bun-typescript-template": minor\n---\n\nConverted later.\n',
    ".changeset/2026-11-22-patch-fix.md":
      '---\n"bun-typescript-template": patch\n---\n\nFixed lockfile.\n',
    ".changeset/2026-11-22-minor-feat.md":
      '---\n"bun-typescript-template": minor\n---\n\nAdded report output.\n',
    ".changeset/2026-11-22-empty.md": "---\n\n---\n",
    ".changeset/pre/2026-11-23-major-pre.md":
      '---\n"bun-typescript-template": major\n---\n\nRemoved deprecated stamp.\n\nAction: Delete old stamp file.\n',
  }).sha;

  const deduped = readTemplateUpgradeChangesets(
    repo,
    preSwitchover,
    postSwitchover,
    gitEnv,
  );
  expect(
    deduped.map((entry) => [entry.file, entry.level, entry.action]),
  ).toEqual([
    ["pre/2026-11-23-major-pre.md", "major", "Delete old stamp file."],
    ["2026-11-22-minor-feat.md", "minor", null],
    ["2026-11-22-patch-fix.md", "patch", null],
    ["2026-11-22-empty.md", "none", null],
  ]);

  const fromNeither = readTemplateUpgradeChangesets(
    repo,
    neither,
    postSwitchover,
    gitEnv,
  );
  expect(fromNeither.map((entry) => entry.file)).toContain(
    "2026-11-20-converted.md",
  );

  const message = templateUpgradeCommitMessage(
    preSwitchover,
    postSwitchover,
    deduped,
  );
  expect(message).toContain(
    `Upgrade template ${preSwitchover.slice(0, 7)} to ${postSwitchover.slice(0, 7)}\n\nChangesets (4):`,
  );
  expect(message.indexOf("MAJOR (1):")).toBeLessThan(
    message.indexOf("Minor (1):"),
  );
  expect(message.indexOf("Minor (1):")).toBeLessThan(
    message.indexOf("Patch (1):"),
  );
  expect(message.indexOf("Patch (1):")).toBeLessThan(
    message.indexOf("No consumer effect (1):"),
  );
  expect(message).toContain("Action: Delete old stamp file.");

  const inputs = {
    templateRoot: repo,
    repository: repo,
    repositoryHead: preSwitchover,
    baseCommit: preSwitchover,
    targetCommit: postSwitchover,
    repositoryName: "demo",
    sourcePacket: "/abs/packet",
    repositoryPinnedCommit: "a".repeat(40),
    templatePinnedCommit: "a".repeat(40),
    templateHeadNotice:
      "Warning: template checkout HEAD is 1 commit behind origin/main. Repair: run git pull in the template, or pass --to origin/main.",
  };
  const plan = createTemplateUpgradePlanResult({
    inputs,
    status: "planned",
    rows: [],
    conflicts: [],
    sharedMerges: [".changeset/config.json"],
    dependencyChanges: [],
    templateCopyChanges: [],
    changesets: deduped,
  });
  expect(plan.sharedMerges).toEqual([".changeset/config.json"]);
  expect(plan.changesets).toEqual(deduped);

  const skipped = skipTemplateUpgradeSteps("--no-check");
  const applyRun = createTemplateUpgradeApplyRun({
    exitCode: 0,
    inputs,
    branch: "template-upgrade/1234567-abcdef0",
    status: "applied",
    changesets: deduped,
    steps: skipped,
  });
  expect(applyRun.result.steps).toEqual(skipped);
  expect(applyRun.result.changesets).toEqual(deduped);
});

test("readTemplateUpgradeChangesets refuses malformed frontmatter, invalid UTF-8 filenames and blobs, and non-regular files", () => {
  const repo = folder("changeset-invalid-");
  initRepository(repo);
  const base = commitIn(repo, "base", {
    ".changeset/README.md": "# Changesets\n",
  }).sha;

  const badFrontmatter = commitIn(repo, "malformed frontmatter", {
    ".changeset/broken.md": "no frontmatter delimiters\n",
  }).sha;
  const frontmatterRefusal = captureCliError(() =>
    readTemplateUpgradeChangesets(repo, base, badFrontmatter, gitEnv),
  );
  expect(frontmatterRefusal?.exitCode).toBe(1);
  expect(frontmatterRefusal?.code).toBe("changeset_invalid");
  expect(frontmatterRefusal?.repair).toContain("fix .changeset/broken.md");

  git(repo, "checkout", "--quiet", base);
  symlinkSync("README.md", join(repo, ".changeset/linked.md"));
  git(repo, "add", "--", ".changeset/linked.md");
  git(repo, "commit", "--quiet", "-m", "symlink changeset");
  const linkedSha = git(repo, "rev-parse", "HEAD");
  const linkRefusal = captureCliError(() =>
    readTemplateUpgradeChangesets(repo, base, linkedSha, gitEnv),
  );
  expect(linkRefusal?.exitCode).toBe(1);
  expect(linkRefusal?.code).toBe("changeset_invalid");
  expect(linkRefusal?.message).toContain("not a plain file");

  git(repo, "checkout", "--quiet", base);
  const badBlobSha = commitObjects(repo, "invalid utf8 blob", [
    { path: ".changeset/bad-bytes.md", bytes: new Uint8Array([0xff, 0xfe]) },
  ]);
  const blobRefusal = captureCliError(() =>
    readTemplateUpgradeChangesets(repo, base, badBlobSha, gitEnv),
  );
  expect(blobRefusal?.exitCode).toBe(1);
  expect(blobRefusal?.message).toContain("not valid UTF-8");

  git(repo, "checkout", "--quiet", base);
  const badNameBytes = Buffer.concat([
    Buffer.from(".changeset/bad-"),
    Buffer.from([0xff]),
    Buffer.from(".md"),
  ]);
  stageRawPath(
    repo,
    badNameBytes,
    '---\n"bun-typescript-template": patch\n---\n\nValid.\n',
  );
  const badNameSha = commitObjects(repo, "invalid utf8 filename", []);
  const nameRefusal = captureCliError(() =>
    readTemplateUpgradeChangesets(repo, base, badNameSha, gitEnv),
  );
  expect(nameRefusal?.exitCode).toBe(1);
  expect(nameRefusal?.code).toBe("changeset_invalid");
  expect(nameRefusal?.message).toContain("not valid UTF-8 text");
});
