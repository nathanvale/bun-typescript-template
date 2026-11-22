import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { recordedHitsFile } from "../../../scripts/glossary.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  checkNames,
  checkNamesFrom,
  fixtureRepository,
  fixtureTree,
  runFixtureGit,
  removeFixtureTrees,
  writeRecordedHits,
} from "./fixture-tree.ts";
import { write } from "../../support/fixture-files.ts";

const usage =
  "Usage: bun run check:names <path> [path ...] | --staged | --tool-call | --against <revision>";

afterAll(removeFixtureTrees);

test.each([
  [
    "an Avoid word",
    "docs/mutation-notes.md",
    'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: Look in the glossary first; rename it with "Planted fault".',
  ],
  [
    "a qualify word alone",
    "src/host.ts",
    'src/host.ts uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.',
  ],
])(
  "CN.a a name that uses %s is refused with its word and its repair",
  async (_kind, path, line) => {
    expect(await checkNames(fixtureTree(), [path])).toEqual({
      stdout: "",
      stderr: `${line}\n`,
      exit: 1,
    });
  },
  processWatchdog(1),
);

test(
  "names that use only glossary words pass in silence",
  async () => {
    expect(
      await checkNames(fixtureTree(), [
        "docs/planted-fault-notes.md",
        "src/test-host.ts",
      ]),
    ).toEqual({ stdout: "", stderr: "", exit: 0 });
  },
  processWatchdog(1),
);

test(
  "a recorded hit passes",
  async () => {
    const tree = fixtureTree([
      { path: "proofs", word: "proof", reason: "fixture" },
    ]);
    expect(await checkNames(tree, ["proofs"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  },
  processWatchdog(1),
);

test(
  "a recorded hit that no longer occurs is left to the tracked names check",
  async () => {
    const tree = fixtureTree([
      { path: "src/host.ts", word: "host", reason: "fixture" },
    ]);
    expect(await checkNames(tree, ["src/test-host.ts"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  },
  processWatchdog(1),
);

test(
  "CN.b every folder on a given path is judged once, by its own name",
  async () => {
    expect(
      await checkNames(fixtureTree(), [
        "src/allowlist/proof/index.ts",
        "src/allowlist/other.ts",
      ]),
    ).toEqual({
      stdout: "",
      stderr: [
        'src/allowlist uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: Look in the glossary first; rename it with "Recorded hit".',
        'src/allowlist/proof uses "proof" with no qualifier. Repair: Look in the glossary first; add a word that says which proof it is.',
        "",
      ].join("\n"),
      exit: 1,
    });
  },
  processWatchdog(1),
);

test(
  "CN.c --staged judges an added and a renamed name, and ignores a modified one",
  async () => {
    const tree = await fixtureRepository();
    const body = "A file long enough for git to see its move as a rename.\n";
    write(tree, "docs/mutation-notes.md", "before\n");
    write(tree, "docs/planted-fault-notes.md", body);
    await runFixtureGit(tree, "add", "--", "docs");
    await runFixtureGit(tree, "commit", "--quiet", "-m", "base");
    write(tree, "docs/mutation-notes.md", "after\n");
    await runFixtureGit(tree, "add", "--", "docs");
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
    await runFixtureGit(
      tree,
      "mv",
      "docs/planted-fault-notes.md",
      "docs/host.md",
    );
    write(tree, "src/allowlist.ts", "");
    await runFixtureGit(tree, "add", "--", "src");
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: [
        'docs/host.md uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.',
        'src/allowlist.ts uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: Look in the glossary first; rename it with "Recorded hit".',
        "",
      ].join("\n"),
      exit: 1,
    });
  },
  processWatchdog(10),
);

const hostHit = { path: "docs/host.md", word: "host", reason: "fixture" };
const hostRefusal =
  'docs/host.md uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.\n';

async function repositoryWithStagedHost(): Promise<string> {
  const tree = await fixtureRepository();
  write(tree, "docs/host.md", "notes\n");
  await runFixtureGit(tree, "add", "--", "docs/host.md");
  return tree;
}

test(
  "CN.f --staged refuses a name whose recorded hit is only an unstaged edit",
  async () => {
    const tree = await repositoryWithStagedHost();
    writeRecordedHits(tree, [hostHit]);
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: hostRefusal,
      exit: 1,
    });
  },
  processWatchdog(5),
);

test(
  "--staged passes a name whose recorded hit is staged, though the working tree has lost it",
  async () => {
    const tree = await repositoryWithStagedHost();
    writeRecordedHits(tree, [hostHit]);
    await runFixtureGit(tree, "add", "--", recordedHitsFile);
    writeRecordedHits(tree, []);
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: "",
      exit: 0,
    });
  },
  processWatchdog(6),
);

test(
  "CN.g --staged refuses a name that uses an Avoid word the staged glossary adds, though the working tree's glossary lacks it",
  async () => {
    const tree = await fixtureRepository();
    const glossary = readFileSync(join(tree, "GLOSSARY.md"), "utf8");
    write(
      tree,
      "GLOSSARY.md",
      glossary.replace("mutant, mutation", "mutant, mutation, canary"),
    );
    write(tree, "docs/canary-notes.md", "notes\n");
    await runFixtureGit(
      tree,
      "add",
      "--",
      "GLOSSARY.md",
      "docs/canary-notes.md",
    );
    write(tree, "GLOSSARY.md", glossary);
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr:
        'docs/canary-notes.md uses "canary", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: Look in the glossary first; rename it with "Planted fault".\n',
      exit: 1,
    });
  },
  processWatchdog(5),
);

test.each([["GLOSSARY.md"], [recordedHitsFile]])(
  "CN.h --staged with no staged %s cannot run, and names the file and the repair",
  async (path) => {
    const tree = await fixtureRepository();
    await runFixtureGit(tree, "rm", "--cached", "--quiet", "--", path);
    expect(await checkNames(tree, ["--staged"])).toEqual({
      stdout: "",
      stderr: `git has no staged ${path}, so the names check cannot judge a commit by the ${path} it will contain. Repair: stage it with git add ${path}, then run the names check again.\n`,
      exit: 2,
    });
  },
  processWatchdog(5),
);

test(
  "an absolute path inside the repository is judged by its path from the root",
  async () => {
    const tree = fixtureTree();
    expect(await checkNames(tree, [join(tree, "src/host.ts")])).toEqual({
      stdout: "",
      stderr:
        'src/host.ts uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.\n',
      exit: 1,
    });
  },
  processWatchdog(1),
);

test(
  "CN.i a relative path is resolved from the folder the entry runs in, and judged by its path from the root",
  async () => {
    const tree = fixtureTree();
    const docs = join(tree, "docs");
    mkdirSync(docs);
    expect(await checkNamesFrom(tree, docs, ["host.md"])).toEqual({
      stdout: "",
      stderr:
        'docs/host.md uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.\n',
      exit: 1,
    });
    expect(await checkNamesFrom(tree, docs, ["../src/host.ts"])).toEqual({
      stdout: "",
      stderr:
        'src/host.ts uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.\n',
      exit: 1,
    });
  },
  processWatchdog(2),
);

test.each([
  ["no path", [], "Give at least one path, --staged or --tool-call."],
  ["an option it does not know", ["--stagd"], 'Unknown option "--stagd".'],
  [
    "a path beside --staged",
    ["--staged", "src/host.ts"],
    "--staged takes no path.",
  ],
  [
    "a path outside the repository",
    ["../elsewhere/host.ts"],
    "../elsewhere/host.ts is outside this repository.",
  ],
])(
  "CN.d %s is a usage error",
  async (_kind, args, reason) => {
    expect(await checkNames(fixtureTree(), args)).toEqual({
      stdout: "",
      stderr: `${usage}. ${reason}\n`,
      exit: 2,
    });
  },
  processWatchdog(1),
);

test(
  "CN.e a check that cannot run exits 2, so it is not read as a refused name",
  async () => {
    const tree = fixtureTree();
    write(tree, recordedHitsFile, "{}");
    expect(await checkNames(tree, ["src/host.ts"])).toEqual({
      stdout: "",
      stderr: `${recordedHitsFile} has no "hits" array. Repair: add "hits": [] at its top level.\n`,
      exit: 2,
    });
  },
  processWatchdog(1),
);
