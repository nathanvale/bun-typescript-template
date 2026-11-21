import { expect, test } from "bun:test";
import { mkdirSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import {
  nameProblems,
  readGlossary,
  recordedUnusedTermsFile,
  recordedHitsFile,
  trackedNames,
} from "../../../scripts/glossary.ts";
import { git } from "../../support/git-fixture.ts";
import {
  check,
  glossary,
  hostHit,
  namesCheckFixture,
  put,
} from "./names-check-fixture.ts";

const { emptyRepository, namesRepository } = namesCheckFixture();

const unusedTerm = {
  term: "Fixture term",
  reason: "Nothing uses it yet.",
  ticket: "MAG-1",
};

function recordedRepository() {
  const root = namesRepository([hostHit]);
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [unusedTerm] }));
  git(root, "add", "--", recordedUnusedTermsFile);
  git(root, "commit", "--quiet", "-m", "terms");
  return root;
}

function widen(root: string, extra: Record<string, unknown> = {}) {
  put(
    root,
    recordedHitsFile,
    JSON.stringify({
      hits: [hostHit, { ...hostHit, path: "docs/proof.md", ...extra }],
    }),
  );
}

function earlierAreaRepository(duplicate: boolean = false) {
  const root = recordedRepository();
  const folder = "tests/template/recorded-checks";
  mkdirSync(join(root, folder), { recursive: true });
  const moved = [recordedHitsFile, recordedUnusedTermsFile].map((file) => ({
    current: file,
    earlier: `${folder}/${file.split("/").at(-1)}`,
  }));
  for (const { current, earlier } of moved)
    git(root, "mv", "--", current, earlier);
  const unrelated = "tests/template/glossary/recorded-hits.json";
  put(root, unrelated, JSON.stringify({ hits: [{ file: "docs/term.md" }] }));
  git(root, "add", "--", unrelated);
  if (duplicate) {
    const other = "tests/template/other/recorded-hits.json";
    const otherTerms = "tests/template/other/recorded-unused-terms.json";
    put(root, other, JSON.stringify({ hits: [hostHit] }));
    put(root, otherTerms, JSON.stringify({ terms: [unusedTerm] }));
    git(root, "add", "--", other, otherTerms);
  }
  git(root, "commit", "--quiet", "-m", "earlier test area");
  for (const { current, earlier } of moved)
    git(root, "mv", "--", earlier, current);
  return root;
}

test("--against follows a moved recorded list and still refuses an unapproved addition", async () => {
  const root = earlierAreaRepository();
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
  widen(root);
  const refused = await check(root, ["--against", "HEAD"]);
  expect(refused.code).toBe(1);
  expect(refused.stderr).toStartWith(
    `${recordedHitsFile} adds a recorded hit for "host" in docs/proof.md`,
  );
});

test("--against refuses to guess between two earlier locations for a recorded list", async () => {
  const root = earlierAreaRepository(true);
  const refused = await check(root, ["--against", "HEAD"]);
  expect(refused.code).toBe(2);
  expect(refused.stderr).toContain(`git has no ${recordedHitsFile} at`);
});

test("a tracked symlink that points nowhere is a name the full-tree check judges", () => {
  const root = namesRepository();
  symlinkSync("nowhere", join(root, "mutation-link.md"));
  git(root, "add", "--", "mutation-link.md");
  expect(trackedNames(root)).toContain("mutation-link.md");
  expect(nameProblems(trackedNames(root), readGlossary(glossary), [])).toEqual([
    'mutation-link.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: rename it with the glossary word.',
  ]);
});

test("--against passes lists that match the base revision, and ones that only shrank", async () => {
  const root = recordedRepository();
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
});

test("--against refuses a recorded hit the base revision does not list, and names the repair", async () => {
  const root = recordedRepository();
  widen(root);
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: `${recordedHitsFile} adds a recorded hit for "host" in docs/proof.md, which HEAD does not record, so this change widens what the names check admits. Repair: remove it (rename the path, or use or remove the term); or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.\n`,
    code: 1,
  });
});

test("--against refuses a recorded unused term the base revision does not list", async () => {
  const root = recordedRepository();
  put(
    root,
    recordedUnusedTermsFile,
    JSON.stringify({
      terms: [unusedTerm, { ...unusedTerm, term: "Another term" }],
    }),
  );
  const { stderr, code } = await check(root, ["--against", "HEAD"]);
  expect(code).toBe(1);
  expect(stderr).toStartWith(
    `${recordedUnusedTermsFile} adds a recorded unused term "Another term", which HEAD does not record`,
  );
});

test("--against admits an addition that carries an approval, and a rewritten reason is no addition", async () => {
  const root = recordedRepository();
  widen(root, { approved: "MAG-1" });
  put(
    root,
    recordedUnusedTermsFile,
    JSON.stringify({ terms: [{ ...unusedTerm, reason: "Reworded." }] }),
  );
  expect(await check(root, ["--against", "HEAD"])).toEqual({
    stderr: "",
    code: 0,
  });
  widen(root, { approved: "  " });
  expect((await check(root, ["--against", "HEAD"])).code).toBe(1);
});

test("--against exits 2 when the base revision does not hold a recorded file, and when it is not given one revision", async () => {
  const root = namesRepository();
  const missing = await check(root, ["--against", "HEAD"]);
  expect(missing.code).toBe(2);
  expect(missing.stderr).toContain(
    "git has no tests/template/names-check/recorded-unused-terms.json at",
  );
  for (const args of [["--against"], ["--against", "a", "b"]])
    expect(await check(root, args)).toEqual({
      stderr:
        "Usage: bun run check:names <path> [path ...] | --staged | --tool-call | --against <revision>. --against takes one revision.\n",
      code: 2,
    });
});

test("--tool-call in this repository with no GLOSSARY.md exits 2, and in a repository with no names check exits 0", async () => {
  const broken = namesRepository();
  git(broken, "rm", "--quiet", "--", "GLOSSARY.md");
  const foreign = emptyRepository();
  const call = (file: string) => () =>
    Promise.resolve(
      JSON.stringify({ tool_name: "Write", tool_input: { file_path: file } }),
    );
  expect(
    await check(
      broken,
      ["--tool-call"],
      call(join(broken, "docs/mutation-notes.md")),
    ),
  ).toEqual({
    stderr: `names check: ${broken} has no GLOSSARY.md or no ${recordedHitsFile}, so it cannot judge the names this call creates. Repair: restore both with git restore GLOSSARY.md ${recordedHitsFile}.\n`,
    code: 2,
  });
  expect(
    await check(
      broken,
      ["--tool-call"],
      call(join(foreign, "docs/mutation-notes.md")),
    ),
  ).toEqual({ stderr: "", code: 0 });
});
