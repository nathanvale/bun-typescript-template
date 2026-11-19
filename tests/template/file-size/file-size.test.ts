import { afterEach, expect, test } from "bun:test";
import {
  chmodSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { runFileSizeCheck } from "../../../scripts/check-file-size.ts";
import { write } from "../../support/fixture-files.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  fileSizeHits,
  fileSizeRecordedHitsPath as recordedHits,
  fixtureRepository,
  runFixtureGit,
  gitOutcome,
  removeFixtureTrees,
  repository,
  runInFixture,
} from "../naming/fixture-tree.ts";

const oneTokenOfText = " x";
const atLimit = oneTokenOfText.repeat(5_000);
const overLimit = oneTokenOfText.repeat(5_001);
const { glossary, integration, standing } = fileSizeHits;
const note = "docs/file-size.txt";
const noteRefusal =
  'check:file-size: "docs/file-size.txt": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.\n';

const hookRefusal = `check:file-size: scanned 1 staged UTF-8 text files (limit 5000 tokens).\n${noteRefusal}`;

afterEach(removeFixtureTrees);

function checkFileSize(
  tree: string,
  args: readonly string[] = [],
  env?: Readonly<Record<string, string>>,
) {
  return runInFixture(
    [process.execPath, "run", "--silent", "check:file-size", ...args],
    tree,
    env,
  );
}

function checkInProcess(tree: string, args: readonly string[] = []) {
  const previous = process.env;
  process.env = { ...inherited(), ...gitEnv };
  try {
    return runFileSizeCheck(args, tree);
  } finally {
    process.env = previous;
  }
}

async function seed(tree: string, files: Readonly<Record<string, string>>) {
  for (const [path, content] of Object.entries(files))
    write(tree, path, content);
  await runFixtureGit(tree, "add", "--", ...Object.keys(files));
}

function linkToolchain(tree: string) {
  symlinkSync(join(repository, "node_modules"), join(tree, "node_modules"));
}

async function treeWithHook(files: Readonly<Record<string, string>> = {}) {
  const tree = await fixtureRepository();
  await seed(tree, { [note]: "original", ...files });
  await runFixtureGit(tree, "commit", "--quiet", "-m", "seed");
  linkToolchain(tree);
  await runFixtureGit(tree, "config", "core.hooksPath", ".githooks");
  return tree;
}

test(
  "the package command passes 5000 tokens and refuses 5001",
  async () => {
    const tree = await fixtureRepository();
    linkToolchain(tree);
    await seed(tree, {
      [glossary]: overLimit,
      [integration]: overLimit,
      [note]: atLimit,
    });
    write(tree, "docs/untracked.txt", overLimit);

    const admitted = await checkFileSize(tree);
    expect(admitted).toMatchObject({ exit: 0, stderr: "" });
    expect(admitted.stdout).toContain(
      "check:file-size: scanned 6 tracked UTF-8 text files (limit 5000 tokens).\n",
    );

    write(tree, note, overLimit);
    const refused = await checkFileSize(tree);
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toBe(noteRefusal);
  },
  processWatchdog(7),
);

test(
  "pre-commit counts staged bytes in a partially staged file",
  async () => {
    const tree = await treeWithHook();
    await seed(tree, { [note]: overLimit });
    write(tree, note, atLimit);

    const refused = await gitOutcome(
      tree,
      "commit",
      "--quiet",
      "-m",
      "oversized",
    );
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toBe(hookRefusal);
    expect(await gitOutcome(tree, "show", `:${note}`)).toMatchObject({
      exit: 0,
      stdout: overLimit,
    });
    expect(await gitOutcome(tree, "show", `HEAD:${note}`)).toMatchObject({
      exit: 0,
      stdout: "original",
    });

    await runFixtureGit(tree, "add", "--", note);
    write(tree, note, overLimit);
    await runFixtureGit(tree, "commit", "--quiet", "-m", "within limit");
    expect(await gitOutcome(tree, "show", `HEAD:${note}`)).toMatchObject({
      exit: 0,
      stdout: atLimit,
    });
    expect(await Bun.file(join(tree, note)).text()).toBe(overLimit);
  },
  processWatchdog(15),
);

test(
  "pre-commit refuses oversized bytes from the active alternate index",
  async () => {
    const tree = await treeWithHook();
    const env = { GIT_INDEX_FILE: join(tree, ".git", "other-index") };
    const gitInIndex = (...args: string[]) =>
      runInFixture(["git", ...args], tree, env);
    expect(await gitInIndex("read-tree", "HEAD")).toMatchObject({ exit: 0 });
    write(tree, note, overLimit);
    expect(await gitInIndex("add", "--", note)).toMatchObject({ exit: 0 });
    write(tree, note, "original");

    const refused = await gitInIndex("commit", "--quiet", "-m", "oversized");
    expect(refused).toMatchObject({ exit: 1, stderr: hookRefusal });
    expect(await gitInIndex("show", `:${note}`)).toMatchObject({
      exit: 0,
      stdout: overLimit,
    });
    expect(await gitOutcome(tree, "show", `:${note}`)).toMatchObject({
      exit: 0,
      stdout: "original",
    });
  },
  processWatchdog(13),
);

test(
  "the file-size command refuses malformed and excluded recorded hits",
  async () => {
    const tree = await fixtureRepository();
    const objectRefusal = `${recordedHits} must contain an object keyed by path.`;
    const fieldsRefusal = `${recordedHits}: "${note}" needs a standing or temporary lifetime and a reason.`;
    const excluded = "docs/vendor/notes.txt";
    const cases = [
      { input: [], refusal: objectRefusal },
      { input: { [note]: null }, refusal: objectRefusal },
      {
        input: { [note]: { lifetime: "forever", reason: "Fixtures." } },
        refusal: fieldsRefusal,
      },
      {
        input: { [note]: { lifetime: "temporary", reason: " " } },
        refusal: fieldsRefusal,
      },
      {
        input: { [excluded]: { lifetime: "temporary", reason: "Fixtures." } },
        refusal: `${recordedHits} names excluded path "${excluded}". Remove its entry.`,
      },
    ];
    for (const { input, refusal } of cases) {
      write(tree, recordedHits, JSON.stringify(input));
      expect(checkInProcess(tree)).toEqual({
        code: 2,
        stdout: "",
        stderr: `check:file-size: ${refusal} Repair: resolve the Git or filesystem error and run the gate again.\n`,
      });
    }
  },
  processWatchdog(5),
);

test(
  "the hook uses the staged record when a temporary recorded hit is removed",
  async () => {
    const tree = await treeWithHook({ [glossary]: overLimit });
    const original = await Bun.file(join(tree, recordedHits)).text();
    const hits = JSON.parse(original) as Record<string, unknown>;
    expect(Object.keys(hits)).toContain(glossary);
    const updated = Object.fromEntries(
      Object.entries(hits).filter(([path]) => path !== glossary),
    );
    await runFixtureGit(tree, "rm", "--quiet", "--", glossary);
    write(tree, recordedHits, JSON.stringify(updated));

    const before = await gitOutcome(tree, "write-tree");
    const refused = await gitOutcome(
      tree,
      "commit",
      "--quiet",
      "-m",
      "retire hit",
    );
    expect(refused.exit).toBe(1);
    expect(refused.stderr).toContain(
      `"${glossary}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000). Repair: remove its entry from ${recordedHits}.`,
    );
    expect(await gitOutcome(tree, "write-tree")).toEqual(before);

    await runFixtureGit(tree, "add", "--", recordedHits);
    write(tree, recordedHits, original);
    expect(checkInProcess(tree, ["--staged"])).toEqual({
      code: 0,
      stderr: "",
      stdout:
        "check:file-size: scanned 1 staged UTF-8 text files (limit 5000 tokens).\n",
    });
  },
  processWatchdog(10),
);

test(
  "the staged scan reads Git blobs in one batch across binary frames",
  async () => {
    const tree = await fixtureRepository();
    linkToolchain(tree);
    const binary = "docs/binary.txt";
    const malformed = "docs/not-utf8.txt";
    const duplicate = "docs/second-file-size.txt";
    await seed(tree, {
      "docs/a-empty.txt": "",
      [binary]: `\0\n${"1".repeat(40)} blob 4\ntext\n`,
      [note]: overLimit,
      [duplicate]: overLimit,
      "docs/small.txt": "no trailing newline",
    });
    writeFileSync(join(tree, malformed), Buffer.from([255, 10, 255]));
    await runFixtureGit(tree, "add", "--", malformed);
    write(tree, binary, overLimit);
    write(tree, note, atLimit);

    const trace = join(tree, "git-trace.log");
    expect(
      await checkFileSize(tree, ["--staged"], { GIT_TRACE: trace }),
    ).toEqual({
      exit: 1,
      stdout:
        "check:file-size: scanned 4 staged UTF-8 text files (limit 5000 tokens).\n",
      stderr: `${noteRefusal}check:file-size: "${duplicate}": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.\n`,
    });
    const blobReads = (await Bun.file(trace).text())
      .split("\n")
      .filter((line) => line.includes("built-in: git cat-file "))
      .map((line) => line.slice(line.indexOf("built-in: git cat-file ")));
    expect(blobReads).toEqual(["built-in: git cat-file --batch"]);
  },
  processWatchdog(7),
);

test(
  "the file-size command stops a Git read at its deadline",
  async () => {
    const tree = await fixtureRepository();
    linkToolchain(tree);
    const barrier = join(tree, "git-read");
    expect(await runInFixture(["mkfifo", barrier], tree)).toMatchObject({
      exit: 0,
    });
    write(tree, "bin/git", '#!/bin/sh\nread -r line < "$GIT_READ_BARRIER"\n');
    chmodSync(join(tree, "bin/git"), 0o755);

    const started = performance.now();
    const result = await checkFileSize(tree, [], {
      GIT_READ_BARRIER: barrier,
      PATH: `${join(tree, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    });
    expect(performance.now() - started).toBeLessThan(8_000);
    expect(result).toEqual({
      exit: 2,
      stdout: "",
      stderr:
        "check:file-size: git ls-files --cached --deduplicate -z timed out after 4000 ms. Repair: resolve the Git or filesystem error and run the gate again.\n",
    });
  },
  processWatchdog(14),
);

test(
  "the staged scan refuses a missing eligible blob and skips a missing vendor blob",
  async () => {
    const tree = await fixtureRepository();
    linkToolchain(tree);
    const excluded = "docs/vendor/absent.txt";
    write(tree, note, "an object never written to this repository");
    const hashed = await gitOutcome(tree, "hash-object", "--", note);
    expect(hashed).toMatchObject({ exit: 0, stderr: "" });
    const object = hashed.stdout.trim();
    const stageMissing = (path: string) =>
      runFixtureGit(
        tree,
        "update-index",
        "--add",
        "--cacheinfo",
        `100644,${object},${path}`,
      );
    await stageMissing(excluded);

    expect(await checkFileSize(tree, ["--staged"])).toEqual({
      exit: 0,
      stdout:
        "check:file-size: scanned 0 staged UTF-8 text files (limit 5000 tokens).\n",
      stderr: "",
    });

    await stageMissing(note);
    expect(await checkFileSize(tree, ["--staged"])).toEqual({
      exit: 2,
      stdout: "",
      stderr: `check:file-size: git cat-file could not read staged blob ${object}. Repair: resolve the Git or filesystem error and run the gate again.\n`,
    });
  },
  processWatchdog(8),
);

test(
  "the scan skips excluded files, binary bytes and symlinks and reports exact-path recorded hits",
  async () => {
    const tree = await fixtureRepository();
    const nearby = "docs/fault-records.json";
    await seed(tree, {
      [glossary]: overLimit,
      [integration]: overLimit,
      [standing]: " x",
      [nearby]: overLimit,
      "vendor/upstream/notes.txt": overLimit,
      "starters/complex/bun.lock": overLimit,
      ".claude/hooks/fallow-gate.sh": overLimit,
      ".codex/hooks/fallow-gate.sh": overLimit,
      "docs/binary.txt": `\0${overLimit}`,
      "docs/not-utf8.txt": overLimit,
      "docs/linked.txt": overLimit,
    });
    const malformed = join(tree, "docs/not-utf8.txt");
    writeFileSync(
      malformed,
      Buffer.concat([Buffer.from([255]), Buffer.from(overLimit)]),
    );
    const linked = join(tree, "docs/linked.txt");
    unlinkSync(linked);
    symlinkSync("fault-records.json", linked);

    const result = checkInProcess(tree);
    expect(result).toMatchObject({
      code: 1,
      stderr:
        'check:file-size: "docs/fault-records.json": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.\n',
    });
    expect(result.stdout).toContain(
      "check:file-size: scanned 7 tracked UTF-8 text files (limit 5000 tokens).\n",
    );
    expect(result.stdout).toContain(
      `"${glossary}": 5001 tokens (limit 5000), temporary recorded hit.`,
    );
    expect(result.stdout).toContain(
      `"${integration}": 5001 tokens (limit 5000), temporary recorded hit.`,
    );
    expect(result.stdout).toContain(
      `"${standing}": 1 tokens (limit 5000), standing recorded hit.`,
    );
  },
  processWatchdog(5),
);

test(
  "a temporary recorded hit must leave when its tracked text shrinks or disappears",
  async () => {
    const tree = await fixtureRepository();
    write(tree, integration, overLimit);
    await seed(tree, { [glossary]: atLimit });

    expect(checkInProcess(tree)).toMatchObject({
      code: 1,
      stderr: [
        `check:file-size: "${glossary}": stale temporary recorded hit (5000 tokens, limit 5000). Repair: remove its entry from ${recordedHits}.`,
        `check:file-size: "${integration}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000). Repair: remove its entry from ${recordedHits}.`,
        "",
      ].join("\n"),
    });

    write(tree, glossary, "\0");
    const nonText = checkInProcess(tree);
    expect(nonText.code).toBe(1);
    expect(nonText.stderr).toContain(
      `"${glossary}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000).`,
    );
  },
  processWatchdog(5),
);

test(
  "a staged rename of a temporary recorded hit refuses the old record and the new oversized path",
  async () => {
    const tree = await fixtureRepository();
    await seed(tree, { [glossary]: overLimit, [integration]: overLimit });
    await runFixtureGit(tree, "commit", "--quiet", "-m", "seed");
    const untouched = checkInProcess(tree, ["--staged"]);
    expect(untouched).toEqual({
      code: 0,
      stdout:
        "check:file-size: scanned 0 staged UTF-8 text files (limit 5000 tokens).\n",
      stderr: "",
    });

    const renamed = "docs/glossary-test.txt";
    write(tree, renamed, "");
    renameSync(join(tree, glossary), join(tree, renamed));
    await runFixtureGit(tree, "add", "--", glossary, renamed);
    const result = checkInProcess(tree, ["--staged"]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim().split("\n").sort()).toEqual([
      `check:file-size: "${renamed}": 5001 tokens exceeds the 5000-token limit. Repair: shorten or split the file.`,
      `check:file-size: "${glossary}": stale temporary recorded hit (no tracked UTF-8 text, limit 5000). Repair: remove its entry from ${recordedHits}.`,
    ]);
  },
  processWatchdog(8),
);

test(
  "the staged scan skips a removed file and a symlink to oversized text",
  async () => {
    const tree = await fixtureRepository();
    await seed(tree, { [note]: overLimit });
    await runFixtureGit(tree, "commit", "--quiet", "-m", "seed");
    await runFixtureGit(tree, "rm", "--quiet", "--", note);
    write(tree, note, overLimit);
    const link = "docs/link.txt";
    symlinkSync("file-size.txt", join(tree, link));
    await runFixtureGit(tree, "add", "--", link);

    expect(checkInProcess(tree, ["--staged"])).toEqual({
      code: 0,
      stdout:
        "check:file-size: scanned 0 staged UTF-8 text files (limit 5000 tokens).\n",
      stderr: "",
    });
  },
  processWatchdog(8),
);

test(
  "a working tree with no tracked texts cannot pass the scan",
  async () => {
    const tree = await fixtureRepository();
    await runFixtureGit(tree, "rm", "--cached", "--quiet", "--", recordedHits);
    await runFixtureGit(
      tree,
      "rm",
      "--quiet",
      "GLOSSARY.md",
      "tests/template/naming/recorded-hits.json",
    );

    const result = checkInProcess(tree);
    expect(result).toMatchObject({
      code: 1,
      stdout:
        "check:file-size: scanned 0 tracked UTF-8 text files (limit 5000 tokens).\n",
    });
    expect(result.stderr).toContain(
      "check:file-size: no tracked UTF-8 text files to scan. Repair: run the gate in a populated template checkout.\n",
    );
  },
  processWatchdog(5),
);
