import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ESLint } from "eslint";
import { runFileSizeCheck } from "../../../scripts/check-file-size.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { git, gitResult } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { check, namesCheckFixture, put } from "./names-check-fixture.ts";

const { plainWordsRepository } = namesCheckFixture();
const biomeBin = join(ROOT, "node_modules/.bin/biome");

function plantReviewFiles(root: string): void {
  put(root, ".review/SPEC.md", "# Review spec\n");
  put(root, ".review/code-review/SKILL.md", "# Code review skill\n");
  put(root, ".review/standards/CODING_STANDARDS.md", "# Standards\n");
  put(root, ".review/probe.ts", "export const   probe: any = 1;\n");
}

async function starterKitFixture(): Promise<string> {
  const root = plainWordsRepository();
  put(root, ".gitignore", readFileSync(join(ROOT, ".gitignore"), "utf8"));
  put(root, "biome.json", readFileSync(join(ROOT, "biome.json"), "utf8"));
  put(root, "scripts/file-size-recorded-hits.json", "{}\n");
  const formatted = await spawnBounded([biomeBin, "format", "--write", "."], {
    cwd: root,
    processGroup: true,
  });
  expect(formatted.exit).toBe(0);
  git(
    root,
    "add",
    ".gitignore",
    "biome.json",
    "names-plain-words.json",
    "scripts/file-size-recorded-hits.json",
    "tests/template/names-check/public-surface.json",
    "tests/template/names-check/recorded-hits.json",
    "tests/template/names-check/recorded-unused-terms.json",
  );
  git(root, "commit", "--quiet", "-m", "add starter kit ignore and checks");
  return root;
}

test(
  "skips untracked .review/ files across tree-walking checks",
  async () => {
    const root = await starterKitFixture();
    plantReviewFiles(root);

    expect(await check(root, ["--against", "HEAD"])).toEqual({
      code: 0,
      stderr: "",
    });

    const untracked = gitResult(
      root,
      "-c",
      "core.excludesFile=/dev/null",
      "ls-files",
      "--others",
      "--exclude-standard",
    );
    expect(untracked.exitCode).toBe(0);
    expect(untracked.stdout.toString()).toBe("");

    const format = await spawnBounded([biomeBin, "format", "."], {
      cwd: root,
      processGroup: true,
    });
    expect(format.exit).toBe(0);
    expect(format.stderr).not.toContain(".review");

    const eslint = new ESLint({ cwd: ROOT });
    expect(await eslint.isPathIgnored(".review/probe.ts")).toBe(true);

    const fileSize = runFileSizeCheck([], root);
    expect(fileSize.code).toBe(0);
  },
  processWatchdog(2),
);

test(
  "refuses untracked review/, .reviews/, docs/.review-notes.md and docs/.review/ when they use unknown words",
  async () => {
    const root = await starterKitFixture();
    put(root, "review/SPEC.md", "# Not ignored\n");
    put(root, ".reviews/SPEC.md", "# Not ignored\n");
    put(root, "docs/.review-notes.md", "# Not ignored\n");
    put(root, "docs/.review/SKILL.md", "# Not ignored\n");
    put(root, "docs/.review/SPEC.md", "# Not ignored\n");

    const untracked = gitResult(
      root,
      "-c",
      "core.excludesFile=/dev/null",
      "ls-files",
      "--others",
      "--exclude-standard",
    );
    expect(untracked.exitCode).toBe(0);
    const listed = untracked.stdout.toString().trim().split("\n");
    expect(listed).toContain("docs/.review/SKILL.md");
    expect(listed).toContain("docs/.review/SPEC.md");

    const result = await check(root, ["--against", "HEAD"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("review/SPEC.md");
    expect(result.stderr).toContain(".reviews/SPEC.md");
    expect(result.stderr).toContain("docs/.review-notes.md");
    expect(result.stderr).toContain("docs/.review/SKILL.md");
    expect(result.stderr).toContain("docs/.review/SPEC.md");

    const eslint = new ESLint({ cwd: ROOT });
    expect(await eslint.isPathIgnored("docs/.review/probe.ts")).toBe(false);
  },
  processWatchdog(1),
);
