import { expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitOutput,
  initRepository,
} from "../../support/git-fixture.ts";
import { cloneTemplateAtHead } from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();

function makeTemplateRepository(files: Record<string, string>): {
  readonly templateRoot: string;
  readonly headCommit: string;
} {
  const templateRoot = folder("overlay-template-");
  initRepository(templateRoot);
  const { sha } = commitIn(templateRoot, "initial", files);
  return { templateRoot, headCommit: sha };
}

test("leaves a clean template checkout at HEAD and excludes ignored untracked files", () => {
  const { templateRoot, headCommit } = makeTemplateRepository({
    ".gitignore": "src/ignored.ts\n",
    "src/bootstrap.ts": "export const version = 1;\n",
  });
  write(templateRoot, "src/ignored.ts", "export const ignored = true;\n");

  const { templateClone, baseCommit } = cloneTemplateAtHead(
    folder,
    templateRoot,
  );
  expect(baseCommit).toBe(headCommit);
  expect(existsSync(join(templateClone, "src/ignored.ts"))).toBe(false);
});

test("includes new untracked source files in the working-tree overlay", () => {
  const { templateRoot, headCommit } = makeTemplateRepository({
    ".gitignore": "src/ignored.ts\n",
    "src/bootstrap.ts": 'export const name = "initial";\n',
  });
  write(
    templateRoot,
    "src/bootstrap.ts",
    'import { value } from "./helper.ts";\nexport const name = value;\n',
  );
  write(templateRoot, "src/helper.ts", 'export const value = "overlay";\n');
  write(templateRoot, "src/ignored.ts", "export const ignored = true;\n");

  const { templateClone, baseCommit } = cloneTemplateAtHead(
    folder,
    templateRoot,
  );
  expect(baseCommit).not.toBe(headCommit);
  expect(readFileSync(join(templateClone, "src/helper.ts"), "utf8")).toBe(
    'export const value = "overlay";\n',
  );
  expect(gitOutput(templateClone, "show", `${baseCommit}:src/helper.ts`)).toBe(
    'export const value = "overlay";\n',
  );
  expect(existsSync(join(templateClone, "src/ignored.ts"))).toBe(false);
});

test("reads changed and untracked paths with NUL framing when filenames hold tabs or line feeds", () => {
  const trackedName = "src/tab\tline\nfeed.ts";
  const untrackedName = "src/new\tline\nfeed.ts";
  const { templateRoot, headCommit } = makeTemplateRepository({
    [trackedName]: "export const stage = 1;\n",
  });
  write(templateRoot, trackedName, "export const stage = 2;\n");
  write(templateRoot, untrackedName, "export const added = true;\n");

  const { templateClone, baseCommit } = cloneTemplateAtHead(
    folder,
    templateRoot,
  );
  expect(baseCommit).not.toBe(headCommit);
  expect(readFileSync(join(templateClone, trackedName), "utf8")).toBe(
    "export const stage = 2;\n",
  );
  expect(readFileSync(join(templateClone, untrackedName), "utf8")).toBe(
    "export const added = true;\n",
  );
  expect(gitOutput(templateClone, "show", `${baseCommit}:${trackedName}`)).toBe(
    "export const stage = 2;\n",
  );
  expect(
    gitOutput(templateClone, "show", `${baseCommit}:${untrackedName}`),
  ).toBe("export const added = true;\n");
});

test("preserves changed symbolic links pointing to missing destinations in the overlay", () => {
  const { templateRoot } = makeTemplateRepository({
    "src/bootstrap.ts": "export const ok = true;\n",
  });
  const linkPath = join(templateRoot, "src/missing-link");
  symlinkSync("missing-before", linkPath);
  git(templateRoot, "add", "--", "src/missing-link");
  git(templateRoot, "commit", "--quiet", "-m", "add missing-target link");
  const headCommit = git(templateRoot, "rev-parse", "HEAD");

  rmSync(linkPath);
  symlinkSync("missing-after", linkPath);

  const { templateClone, baseCommit } = cloneTemplateAtHead(
    folder,
    templateRoot,
  );
  const clonedLink = join(templateClone, "src/missing-link");
  expect(baseCommit).not.toBe(headCommit);
  expect(lstatSync(clonedLink).isSymbolicLink()).toBe(true);
  expect(readlinkSync(clonedLink)).toBe("missing-after");
  expect(
    gitOutput(templateClone, "show", `${baseCommit}:src/missing-link`),
  ).toBe("missing-after");
});
