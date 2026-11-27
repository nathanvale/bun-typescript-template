import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ESLint } from "eslint";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { gitResult, initRepository } from "../../support/git-fixture.ts";
import { linkTemplatePackagesAndKernel } from "../../support/kernel-sibling.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import {
  bootstrapRow,
  kernelRowFixture,
} from "../../support/recipe-fixture.ts";

const run = kernelRowFixture();
const biomeBin = join(ROOT, "node_modules/.bin/biome");
const eslintBin = join(ROOT, "node_modules/.bin/eslint");

function writeFixtureFile(root: string, path: string, content: string): void {
  const fullPath = join(root, path);
  mkdirSync(dirname(fullPath), { recursive: true });
  writeFileSync(fullPath, content);
}

test(
  "generated repository ignores .review/ and skips it in lint and format checks",
  async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    linkTemplatePackagesAndKernel(destination);
    initRepository(destination);

    const gitignoreLines = readFileSync(
      join(destination, ".gitignore"),
      "utf8",
    ).split(/\r?\n/);
    expect(gitignoreLines).toContain(".review/");

    const ignored = gitResult(
      destination,
      "-c",
      "core.excludesFile=/dev/null",
      "check-ignore",
      ".review/SPEC.md",
      ".review/code-review/SKILL.md",
      ".review/standards/CODING_STANDARDS.md",
    );
    expect({
      exitCode: ignored.exitCode,
      stdout: ignored.stdout.toString(),
      stderr: ignored.stderr.toString(),
    }).toEqual({
      exitCode: 0,
      stdout:
        ".review/SPEC.md\n.review/code-review/SKILL.md\n.review/standards/CODING_STANDARDS.md\n",
      stderr: "",
    });

    for (const kept of [
      "review/SPEC.md",
      ".reviews/SPEC.md",
      "docs/.review-notes.md",
    ]) {
      const probe = gitResult(
        destination,
        "-c",
        "core.excludesFile=/dev/null",
        "check-ignore",
        kept,
      );
      expect(probe.exitCode).toBe(1);
    }

    writeFixtureFile(destination, ".review/SPEC.md", "# Review spec\n");
    writeFixtureFile(
      destination,
      ".review/code-review/SKILL.md",
      "# Code review skill\n",
    );
    writeFixtureFile(
      destination,
      ".review/standards/CODING_STANDARDS.md",
      "# Standards\n",
    );
    writeFixtureFile(
      destination,
      ".review/probe.ts",
      "export const   probe: any = 1;\n",
    );

    const format = await spawnBounded([biomeBin, "format", "."], {
      cwd: destination,
      processGroup: true,
    });
    expect(format.exit).toBe(0);
    expect(format.stderr).not.toContain(".review");

    const eslint = new ESLint({ cwd: destination });
    expect(await eslint.isPathIgnored(".review/probe.ts")).toBe(true);

    const lint = await spawnBounded([eslintBin, ".", "--max-warnings", "0"], {
      cwd: destination,
      processGroup: true,
    });
    expect({ exit: lint.exit, stderr: lint.stderr }).toEqual({
      exit: 0,
      stderr: "",
    });
  },
  processWatchdog(4),
);
