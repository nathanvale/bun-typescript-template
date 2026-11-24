import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  checkGatedPaths,
  isGatedTemplatePath,
  runGatedPathCheck,
} from "../../../scripts/check-gated-paths.ts";
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
const folder = ownedFolders();

type ChangesetConfig = {
  readonly changedFilePatterns?: readonly string[];
};

function readPatterns(relativePath: string): readonly string[] {
  const parsed = JSON.parse(
    readFileSync(join(ROOT, relativePath), "utf8"),
  ) as ChangesetConfig;
  return parsed.changedFilePatterns ?? [];
}

function matchesAnyPattern(
  patterns: readonly string[],
  candidate: string,
): boolean {
  return patterns.some((pattern) => {
    const glob = new Bun.Glob(pattern);
    return glob.match(candidate);
  });
}

function writeFileTree(root: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = join(root, relativePath);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }
}

function createTemplateFixtureRepo(): {
  readonly repo: string;
  readonly baseSha: string;
} {
  const repo = folder("check-gated-template-");
  initRepository(repo);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  const { sha: baseSha } = commitIn(repo, "base", {
    ".changeset/config.json": readFileSync(
      join(ROOT, ".changeset/config.json"),
      "utf8",
    ),
    ".changeset/README.md": "# Changesets\n",
    "README.md": "# Template\n",
    "generated-repository/application/src/cli.ts": "export const cli = 1;\n",
    "src/recipe.ts": "export const recipe = 1;\n",
    "docs/guide.md": "# Guide\n",
  });
  git(repo, "update-ref", "refs/remotes/origin/main", baseSha);
  return { repo, baseSha };
}

function createGeneratedFixtureRepo(): {
  readonly repo: string;
  readonly baseSha: string;
} {
  const repo = folder("check-gated-generated-");
  initRepository(repo);
  symlinkSync(join(ROOT, "node_modules"), join(repo, "node_modules"));
  const { sha: baseSha } = commitIn(repo, "base", {
    ".changeset/config.json": readFileSync(
      join(ROOT, "generated-repository/changeset/config.json"),
      "utf8",
    ),
    ".changeset/README.md": "# Changesets\n",
    "scripts/check-gated-paths.ts": readFileSync(
      join(ROOT, "generated-repository/scripts/check-gated-paths.ts"),
      "utf8",
    ),
    "package.json": JSON.stringify({ name: "demo-app", version: "0.0.0" }),
    "README.md": "# Demo\n",
    "src/cli.ts": "export const cli = 1;\n",
    "tests/cli.test.ts": "export const ok = true;\n",
  });
  git(repo, "update-ref", "refs/remotes/origin/main", baseSha);
  return { repo, baseSha };
}

function resetFixture(repo: string, sha: string): void {
  git(repo, "checkout", "--force", "--quiet", "--detach", sha);
  git(repo, "clean", "-fdq");
}

function runGeneratedGate(repo: string) {
  return spawnBounded([process.execPath, "scripts/check-gated-paths.ts"], {
    cwd: repo,
    env: { ...inherited(), ...gitEnv, NO_COLOR: "1", FORCE_COLOR: "0" },
    processGroup: true,
  });
}

describe("changedFilePatterns and script predicate parity", () => {
  test("every changedFilePatterns entry in .changeset/config.json matches isGatedTemplatePath and vice versa", () => {
    const patterns = readPatterns(".changeset/config.json");
    expect(patterns.length).toBeGreaterThan(0);

    const sampleCandidates = [
      ...patterns.map((pattern) =>
        pattern.endsWith("/**")
          ? `${pattern.slice(0, -3)}/nested/file.ts`
          : pattern,
      ),
      "generated-repository/.dot",
      "generated-repository/café.txt",
      "generated-repository/bun.lock",
      "kernel-pin.json",
      "config/anti-slop-bindings.mjs",
      "config/anti-slop-rules.mjs",
      "config/anti-slop-type-rules.mjs",
      "config/payload-rules.mjs",
      "config/platform-rules.mjs",
      "config/template-rules.mjs",
      "tests/support/test-folder.ts",
      "src/bootstrap.ts",
      "src/bootstrap-arguments.ts",
      "src/kernel-pin.ts",
      "src/recipe.ts",
      "src/token-substitution.ts",
      "README.md",
      "package.json",
      "docs/template-upgrade.md",
      "scripts/check-gated-paths.ts",
      "src/template-upgrade.ts",
      "config/other.mjs",
      "tests/support/git-fixture.ts",
    ];

    for (const candidate of sampleCandidates) {
      expect([candidate, isGatedTemplatePath(candidate)]).toEqual([
        candidate,
        matchesAnyPattern(patterns, candidate),
      ]);
    }
  });

  test("every changedFilePatterns entry in generated-repository/changeset/config.json matches generated script predicate and vice versa", () => {
    const patterns = readPatterns("generated-repository/changeset/config.json");
    const scriptText = readFileSync(
      join(ROOT, "generated-repository/scripts/check-gated-paths.ts"),
      "utf8",
    );
    expect(scriptText).toContain(
      'path === "package.json" || path.startsWith("src/")',
    );
    const isGeneratedGated = (candidate: string) =>
      candidate === "package.json" || candidate.startsWith("src/");

    const sampleCandidates = [
      "package.json",
      "src/cli.ts",
      "src/nested/file.ts",
      "src/.e.ts",
      "src/café.ts",
      "README.md",
      "tests/cli.test.ts",
      "scripts/check-gated-paths.ts",
      "src-other/file.ts",
      "nested/package.json",
    ];

    for (const candidate of sampleCandidates) {
      expect([candidate, isGeneratedGated(candidate)]).toEqual([
        candidate,
        matchesAnyPattern(patterns, candidate),
      ]);
    }
  });
});

describe("template scripts/check-gated-paths.ts", () => {
  test(
    "refuses unnoted gated edits, rename-out, dot-files, non-ASCII, index-only masked edits, and working-tree masked reverts, while admitting non-gated edits and added changesets",
    async () => {
      const { repo, baseSha } = createTemplateFixtureRepo();

      resetFixture(repo, baseSha);
      commitIn(repo, "edit gated path", {
        "generated-repository/application/src/cli.ts":
          "export const cli = 2;\n",
      });
      const unnoted = await checkGatedPaths(repo, "origin/main");
      expect(unnoted.code).toBe(1);
      expect(unnoted.stderr).toContain(
        'This branch changes 1 gated path(s) (first: "generated-repository/application/src/cli.ts") and adds no changeset. Repair:',
      );

      commitIn(repo, "add empty changeset", {
        ".changeset/empty-change.md": "---\n---\n\n",
      });
      expect(await checkGatedPaths(repo, "origin/main")).toEqual({
        stdout: "",
        stderr: "",
        code: 0,
      });

      resetFixture(repo, baseSha);
      commitIn(repo, "non-gated edit", { "README.md": "# Updated\n" });
      expect(await checkGatedPaths(repo, "origin/main")).toEqual({
        stdout: "",
        stderr: "",
        code: 0,
      });

      resetFixture(repo, baseSha);
      mkdirSync(join(repo, "moved"), { recursive: true });
      git(
        repo,
        "mv",
        "generated-repository/application/src/cli.ts",
        "moved/cli.ts",
      );
      git(repo, "commit", "--quiet", "-m", "rename out");
      const renamedOut = await checkGatedPaths(repo, "origin/main");
      expect(renamedOut.code).toBe(1);
      expect(renamedOut.stderr).toContain(
        'gated path(s) (first: "generated-repository/application/src/cli.ts")',
      );

      resetFixture(repo, baseSha);
      commitIn(repo, "dot-file", { "generated-repository/.dot": "x\n" });
      const dotFile = await checkGatedPaths(repo, "origin/main");
      expect(dotFile.code).toBe(1);
      expect(dotFile.stderr).toContain(
        'gated path(s) (first: "generated-repository/.dot")',
      );

      resetFixture(repo, baseSha);
      commitIn(repo, "non-ascii", { "generated-repository/café.txt": "x\n" });
      const nonAscii = await checkGatedPaths(repo, "origin/main");
      expect(nonAscii.code).toBe(1);
      expect(nonAscii.stderr).toContain(
        'gated path(s) (first: "generated-repository/café.txt")',
      );

      resetFixture(repo, baseSha);
      writeFileTree(repo, { "src/recipe.ts": "export const recipe = 2;\n" });
      git(repo, "add", "--", "src/recipe.ts");
      writeFileTree(repo, { "src/recipe.ts": "export const recipe = 1;\n" });
      const stagedMasked = await checkGatedPaths(repo, "origin/main");
      expect(stagedMasked.code).toBe(1);
      expect(stagedMasked.stderr).toContain(
        'gated path(s) (first: "src/recipe.ts")',
      );

      resetFixture(repo, baseSha);
      commitIn(repo, "committed gated edit", {
        "src/recipe.ts": "export const recipe = 2;\n",
      });
      writeFileTree(repo, { "src/recipe.ts": "export const recipe = 1;\n" });
      const workingTreeMasked = await checkGatedPaths(repo, "origin/main");
      expect(workingTreeMasked.code).toBe(1);
      expect(workingTreeMasked.stderr).toContain(
        'gated path(s) (first: "src/recipe.ts")',
      );

      expect(await runGatedPathCheck(["--unknown"], repo)).toMatchObject({
        code: 2,
      });
    },
    processWatchdog(4),
  );
});

describe("generated-repository/scripts/check-gated-paths.ts", () => {
  test(
    "refuses unnoted gated edits, rename-out, dot-files, non-ASCII, and index-only masked edits, while admitting non-gated edits and added changesets",
    async () => {
      const { repo, baseSha } = createGeneratedFixtureRepo();

      resetFixture(repo, baseSha);
      commitIn(repo, "edit src", { "src/cli.ts": "export const cli = 2;\n" });
      const unnoted = await runGeneratedGate(repo);
      expect(unnoted.exit).toBe(1);
      expect(unnoted.stderr).toContain('gated path(s) (first: "src/cli.ts")');

      commitIn(repo, "add empty changeset", {
        ".changeset/empty.md": "---\n---\n\n",
      });
      expect((await runGeneratedGate(repo)).exit).toBe(0);

      resetFixture(repo, baseSha);
      commitIn(repo, "readme only", { "README.md": "# Changed\n" });
      expect((await runGeneratedGate(repo)).exit).toBe(0);

      resetFixture(repo, baseSha);
      mkdirSync(join(repo, "moved"), { recursive: true });
      git(repo, "mv", "src/cli.ts", "moved/cli.ts");
      git(repo, "commit", "--quiet", "-m", "rename out");
      const renamed = await runGeneratedGate(repo);
      expect(renamed.exit).toBe(1);
      expect(renamed.stderr).toContain('gated path(s) (first: "src/cli.ts")');

      resetFixture(repo, baseSha);
      commitIn(repo, "dot-file", { "src/.e.ts": "export const e = 1;\n" });
      const dotFile = await runGeneratedGate(repo);
      expect(dotFile.exit).toBe(1);
      expect(dotFile.stderr).toContain('gated path(s) (first: "src/.e.ts")');

      resetFixture(repo, baseSha);
      commitIn(repo, "non-ascii", { "src/café.ts": "export const c = 1;\n" });
      const nonAscii = await runGeneratedGate(repo);
      expect(nonAscii.exit).toBe(1);
      expect(nonAscii.stderr).toContain('gated path(s) (first: "src/café.ts")');

      resetFixture(repo, baseSha);
      writeFileTree(repo, { "src/cli.ts": "export const cli = 2;\n" });
      git(repo, "add", "--", "src/cli.ts");
      writeFileTree(repo, { "src/cli.ts": "export const cli = 1;\n" });
      const stagedMasked = await runGeneratedGate(repo);
      expect(stagedMasked.exit).toBe(1);
      expect(stagedMasked.stderr).toContain(
        'gated path(s) (first: "src/cli.ts")',
      );
    },
    processWatchdog(4),
  );
});
