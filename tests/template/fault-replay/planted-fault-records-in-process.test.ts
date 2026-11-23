import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  add,
  type Fault,
  readRecords,
} from "../../../scripts/planted-faults.ts";
import {
  createPlantedFaultFixture,
  guarded,
  limitTests,
  recordsPath,
  rejection,
  sample,
  unguarded,
} from "../../support/planted-fault-in-process-fixture.ts";
import { write } from "../../support/fixture-files.ts";
import { gitOutput, commit } from "../../support/git-fixture.ts";

const { folder, isolated, repository } = createPlantedFaultFixture();

describe("readRecords", () => {
  function recordsIn(content: string | null, files: string[] = []): string {
    const root = folder("planted-faults-records-");
    for (const file of files) write(root, file, "");
    if (content !== null) write(root, recordsPath, content);
    return root;
  }

  test("gives no records when the records file is absent", () => {
    expect(readRecords(recordsIn(null))).toEqual([]);
  });

  test("reads each record in file order, with every field", () => {
    const other: Fault = { ...sample, id: "def5678-other" };
    const root = recordsIn(JSON.stringify([sample, other]), [
      "tests/limit.test.ts",
    ]);

    expect(readRecords(root)).toEqual([sample, other]);
  });

  test("keeps only the named fields of a record", () => {
    const root = recordsIn(JSON.stringify([{ ...sample, extra: "ignored" }]), [
      "tests/limit.test.ts",
    ]);

    expect(readRecords(root)).toEqual([sample]);
  });

  test("reads removesBound true for a fault whose only symptom is a timeout", () => {
    const root = recordsIn(
      JSON.stringify([{ ...sample, removesBound: true }]),
      ["tests/limit.test.ts"],
    );

    expect(readRecords(root)).toEqual([{ ...sample, removesBound: true }]);
  });

  test.each([
    ["false", false],
    ['"yes"', "yes"],
  ])("refuses removesBound %s and gives its repair", (shown, value) => {
    const root = recordsIn(
      JSON.stringify([{ ...sample, removesBound: value }]),
      ["tests/limit.test.ts"],
    );

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 0 has removesBound ${shown}. Repair: write true for a fault whose only symptom is a timeout, or leave it out.`,
    );
  });

  test("refuses a file whose top level is not an array", () => {
    const root = recordsIn(JSON.stringify({ id: "x" }));

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} must hold an array of fault records. Repair: make its top level one JSON array.`,
    );
  });

  test("refuses a file that is not JSON", () => {
    const root = recordsIn("not json");

    expect(() => readRecords(root)).toThrow("JSON Parse error");
  });

  test("refuses an id listed twice and names it", () => {
    const root = recordsIn(JSON.stringify([sample, sample]), [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} lists abc1234-limit twice. Repair: remove one record, or give it another id.`,
    );
  });

  test.each([
    ["id", "name it <fix short sha>-<source file name>."],
    [
      "patch",
      "name the planted fault's patch under tests/planted-faults/patches.",
    ],
    ["testFile", "name a test file relative to the repository root."],
    [
      "title",
      "name the bun test -t pattern that selects the test that kills the planted fault.",
    ],
    ["source", "name it <fix short sha> <fix subject>."],
  ])("refuses a record with no %s and gives its repair", (field, repair) => {
    const record: Record<string, unknown> = { ...sample };
    delete record[field];
    const root = recordsIn(JSON.stringify([sample, record]), [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 1 needs a non-empty string ${field}. Repair: ${repair}`,
    );
  });

  test("refuses a record whose field is empty or not text", () => {
    const empty = recordsIn(JSON.stringify([{ ...sample, title: "" }]), [
      "tests/limit.test.ts",
    ]);
    const number = recordsIn(JSON.stringify([{ ...sample, patch: 3 }]), [
      "tests/limit.test.ts",
    ]);

    expect(() => readRecords(empty)).toThrow(
      `${recordsPath} record 0 needs a non-empty string title.`,
    );
    expect(() => readRecords(number)).toThrow(
      `${recordsPath} record 0 needs a non-empty string patch.`,
    );
  });

  test.each([
    ["null", "null"],
    ["a string", '"abc"'],
    ["a number", "7"],
  ])("refuses a record that is %s", (_name, entry) => {
    const root = recordsIn(`[${entry}]`);

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 0 needs a non-empty string id.`,
    );
  });

  test("refuses a record whose test file does not exist", () => {
    const root = recordsIn(JSON.stringify([sample]));

    expect(() => readRecords(root)).toThrow(
      `${recordsPath} record 0 names testFile tests/limit.test.ts, which does not exist. Repair: name a test file relative to the repository root.`,
    );
  });

  test("reads the file under the root it is given, not another", () => {
    const left = recordsIn(JSON.stringify([sample]), ["tests/limit.test.ts"]);
    const right = recordsIn(null);

    expect(readRecords(left)).toEqual([sample]);
    expect(readRecords(right)).toEqual([]);
  });
});

describe("add", () => {
  function fixed() {
    const root = repository("planted-faults-add-");
    commit(root, "base", {
      "src/limit.ts": unguarded,
      "src/other.ts": "a\n",
      "src/untouched.ts": "a\n",
    });
    const fix = commit(root, "fix: refuse a NaN limit", {
      "src/limit.ts": guarded,
      "src/other.ts": "b\n",
      "tests/limit.test.ts": limitTests,
    });
    const full = gitOutput(root, "rev-parse", "HEAD").trim();
    return { root, fix, full };
  }

  async function added(root: string, args: readonly string[]) {
    return isolated(() => add(root, args));
  }

  function savedRecords(root: string): Fault[] {
    return readRecords(root);
  }

  const args = (fix: string) => [
    fix,
    "src/limit.ts",
    "tests/limit.test.ts",
    "^L\\.refuses ",
  ];

  test("stores the fix's reverse hunk and a record naming it", async () => {
    const { root, fix, full } = fixed();

    const run = await added(root, args(fix));

    const id = `${fix}-limit`;
    expect(run.result).toBe(0);
    expect(run.stdout).toBe(
      `Added ${id}. Replay it: bun run fault-replay ${id}\n`,
    );
    expect(run.stderr).toBe("");
    expect(savedRecords(root)).toEqual([
      {
        id,
        patch: `tests/planted-faults/patches/${id}.patch`,
        testFile: "tests/limit.test.ts",
        title: "^L\\.refuses ",
        source: `${fix} fix: refuse a NaN limit`,
      },
    ]);
    expect(
      readFileSync(
        join(root, `tests/planted-faults/patches/${id}.patch`),
        "utf8",
      ),
    ).toBe(gitOutput(root, "diff", full, `${full}^`, "--", "src/limit.ts"));
    expect(readFileSync(join(root, recordsPath), "utf8")).toEndWith("}\n]\n");
    expect(run.leftovers).toEqual([]);
  });

  test("the stored patch applies to the fixed tree and removes the fix", async () => {
    const { root, fix } = fixed();
    await added(root, args(fix));

    gitOutput(
      root,
      "apply",
      join(root, `tests/planted-faults/patches/${fix}-limit.patch`),
    );

    expect(readFileSync(join(root, "src/limit.ts"), "utf8")).toBe(unguarded);
  });

  test("accepts a full sha and records the short one", async () => {
    const { root, fix, full } = fixed();

    const run = await added(root, [full, ...args(fix).slice(1)]);

    expect(run.result).toBe(0);
    expect(run.stdout).toStartWith(`Added ${fix}-limit.`);
    expect(savedRecords(root)[0]?.source).toBe(
      `${fix} fix: refuse a NaN limit`,
    );
  });

  test("adds to the records already there, in order", async () => {
    const { root, fix } = fixed();
    const first = await added(root, args(fix));
    expect(first.result).toBe(0);

    const second = await added(root, [
      fix,
      "src/other.ts",
      "tests/limit.test.ts",
      "x",
    ]);

    expect(second.result).toBe(0);
    expect(savedRecords(root).map(({ id, title }) => [id, title])).toEqual([
      [`${fix}-limit`, "^L\\.refuses "],
      [`${fix}-other`, "x"],
    ]);
  });

  test("names the id after the source file without its extension", async () => {
    const root = repository("planted-faults-add-name-");
    commit(root, "base", { Makefile: "a\n", "src/x.tar.gz": "a\n" });
    commit(root, "fix: both", { Makefile: "b\n", "src/x.tar.gz": "b\n" });
    write(root, "t.test.ts", "");
    const short = gitOutput(root, "rev-parse", "--short", "HEAD").trim();

    const plain = await added(root, [short, "Makefile", "t.test.ts", "t"]);
    const dotted = await added(root, [short, "src/x.tar.gz", "t.test.ts", "t"]);

    expect(plain.result).toBe(0);
    expect(dotted.result).toBe(0);
    expect(savedRecords(root).map(({ id }) => id)).toEqual([
      `${short}-Makefile`,
      `${short}-x.tar`,
    ]);
  });

  test("refuses an id already recorded and leaves the files as they were", async () => {
    const { root, fix } = fixed();
    await added(root, args(fix));
    const records = readFileSync(join(root, recordsPath), "utf8");
    const patchPath = join(
      root,
      `tests/planted-faults/patches/${fix}-limit.patch`,
    );
    writeFileSync(patchPath, "edited by hand\n");

    const run = await added(root, args(fix));

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      `${recordsPath} already lists ${fix}-limit. Repair: plant it again by hand, run git diff -- 'src/limit.ts' > 'tests/planted-faults/patches/${fix}-limit.patch', then undo the planted edit; or add the new record by hand under another id.\n`,
    );
    expect(readFileSync(join(root, recordsPath), "utf8")).toBe(records);
    expect(readFileSync(patchPath, "utf8")).toBe("edited by hand\n");
  });

  test.each([
    ["the fix sha", 0],
    ["the source path", 1],
    ["the test file", 2],
    ["the title", 3],
  ])("exits 2 with usage when %s is missing", async (_name, missing) => {
    const { root, fix } = fixed();
    const given = args(fix).slice(0, missing);

    const run = await added(root, given);

    expect(run.result).toBe(2);
    expect(run.stdout).toBe("");
    expect(run.stderr).toBe(
      "Usage: bun run planted-fault:add <fix sha> <source path> <test file> <title>\n",
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
  });

  test("exits 2 and names the short sha when the fix leaves the source path alone", async () => {
    const { root, fix } = fixed();

    const run = await added(root, [
      fix,
      "src/untouched.ts",
      "tests/limit.test.ts",
      "t",
    ]);

    expect(run.result).toBe(2);
    expect(run.stderr).toBe(
      `${fix} does not change src/untouched.ts. Repair: pass a path that git diff --name-only ${fix}^ ${fix} lists.\n`,
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
    expect(existsSync(join(root, "tests/planted-faults"))).toBe(false);
  });

  test("refuses a sha that is no commit, in git's words", async () => {
    const { root } = fixed();

    const run = added(root, [
      "nope",
      "src/limit.ts",
      "tests/limit.test.ts",
      "t",
    ]);

    expect(await rejection(run)).toStartWith(
      "git rev-parse --verify nope^{commit}:",
    );
  });

  test("refuses a test file that does not exist and writes nothing", async () => {
    const { root, fix } = fixed();

    const run = added(root, [
      fix,
      "src/limit.ts",
      "tests/missing.test.ts",
      "t",
    ]);

    expect(await rejection(run)).toBe(
      "planted-fault:add names testFile tests/missing.test.ts, which does not exist. Repair: name a test file relative to the repository root.",
    );
    expect(existsSync(join(root, recordsPath))).toBe(false);
    expect(existsSync(join(root, "tests/planted-faults"))).toBe(false);
  });

  test("works in the repository it is given, not the working directory's", async () => {
    const { root, fix } = fixed();
    const elsewhere = repository("planted-faults-add-elsewhere-");
    commit(elsewhere, "base", { "src/limit.ts": "x\n" });

    const run = await added(root, args(fix));

    expect(run.result).toBe(0);
    expect(existsSync(join(elsewhere, recordsPath))).toBe(false);
    expect(readdirSync(join(root, "tests/planted-faults")).sort()).toEqual([
      "fault-records.json",
      "patches",
    ]);
  });
});
