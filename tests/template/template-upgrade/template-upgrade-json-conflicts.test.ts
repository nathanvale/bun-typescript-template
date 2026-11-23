import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitMergeFile } from "../../../src/template-upgrade-git.ts";
import { mergeTemplateUpgradeTrees } from "../../../src/template-upgrade-merge.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { commitIn, gitResult } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

const OLD_JSON =
  '{\n  "entry": ["a"],\n  "x1": 1,\n  "x2": 2,\n  "x3": 3,\n  "x4": 4,\n  "x5": 5,\n  "rules": {"r": "error"}\n}\n';
const ENTRY_LINE = '  "entry": ["a"],\n';
const X5_LINE = '  "x5": 5,\n';
const RULES_LINE = '  "rules": {"r": "error"}\n';
const OURS_BOUNDARIES = OLD_JSON.replace(
  ENTRY_LINE,
  `${ENTRY_LINE}  "boundaries": {"zones": ["mine"]},\n`,
);
const NEW_BOUNDARIES = OLD_JSON.replace(
  RULES_LINE,
  '  "rules": {"r": "error"},\n  "boundaries": {"zones": ["template"]}\n',
);

function markedJsonShape(ours: string, next: string) {
  return {
    old: OLD_JSON,
    ours,
    next,
    marked: `<<<<<<< ours\n${ours}=======\n${next}>>>>>>> new\n`,
  };
}

const cleanTextShape = markedJsonShape(OURS_BOUNDARIES, NEW_BOUNDARIES);
const textConflictShape = markedJsonShape(
  OURS_BOUNDARIES.replace(X5_LINE, '  "x5": "OURS",\n'),
  NEW_BOUNDARIES.replace(X5_LINE, '  "x5": "NEW",\n'),
);
const commentedShape = markedJsonShape(
  OURS_BOUNDARIES.replace(ENTRY_LINE, '  "entry": ["a"], // owner note\n'),
  NEW_BOUNDARIES,
);

async function expectWholeFileMarked(
  shape: ReturnType<typeof markedJsonShape>,
): Promise<void> {
  const oldDir = folder("json-dup-old-");
  const newDir = folder("json-dup-new-");
  const oursDir = folder("json-dup-ours-");
  write(oldDir, ".fallowrc.json", shape.old);
  write(newDir, ".fallowrc.json", shape.next);
  write(oursDir, ".fallowrc.json", shape.ours);

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: ".fallowrc.json", ownerLabel: "shared", outcome: "conflict" },
  ]);
  const written = readFileSync(join(oursDir, ".fallowrc.json"), "utf8");
  expect(written).toBe(shape.marked);
  expect(
    written
      .split("=======\n")
      .map((side) => side.match(/"boundaries"/g)?.length),
  ).toEqual([1, 1]);
  expect(() => {
    JSON.parse(written);
  }).toThrow("JSON Parse error");
}

test("a JSON key conflict whose text merges cleanly is written as one marked conflict, ours above new, that does not parse", async () => {
  await expectWholeFileMarked(cleanTextShape);
});

test("a JSON key conflict beside a text conflict is written as one marked conflict, so no member repeats outside the markers", async () => {
  await expectWholeFileMarked(textConflictShape);
});

test("a JSON file that does not parse and whose clean text merge repeats a member is written as one marked conflict", async () => {
  await expectWholeFileMarked(commentedShape);
});

test("a JSON file that does not parse and whose clean text merge repeats no member is still a clean merge", async () => {
  const oldDir = folder("json-comment-old-");
  const newDir = folder("json-comment-new-");
  const oursDir = folder("json-comment-ours-");
  const ours = OLD_JSON.replace(
    ENTRY_LINE,
    '  "entry": ["a"], // owner note\n',
  );
  write(oldDir, ".fallowrc.json", OLD_JSON);
  write(newDir, ".fallowrc.json", NEW_BOUNDARIES);
  write(oursDir, ".fallowrc.json", ours);

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: ".fallowrc.json", ownerLabel: "shared", outcome: "merge" },
  ]);
  expect(readFileSync(join(oursDir, ".fallowrc.json"), "utf8")).toBe(
    NEW_BOUNDARIES.replace(ENTRY_LINE, '  "entry": ["a"], // owner note\n'),
  );
});

test("a JSON text conflict with no key conflict keeps git merge-file's markers and a clean JSON key merge writes the merged keys", async () => {
  const oldDir = folder("json-plain-old-");
  const newDir = folder("json-plain-new-");
  const oursDir = folder("json-plain-ours-");
  write(oldDir, "biome.json", `{\n  // indent\n  "indentWidth": 2\n}\n`);
  write(newDir, "biome.json", `{\n  // indent\n  "indentWidth": 4\n}\n`);
  write(oursDir, "biome.json", `{\n  // indent\n  "indentWidth": 8\n}\n`);
  write(oldDir, "tsconfig.json", '{"a": 1, "b": 1}\n');
  write(newDir, "tsconfig.json", '{"a": 1, "b": 2}\n');
  write(oursDir, "tsconfig.json", '{"a": 3, "b": 1}\n');

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: "biome.json", ownerLabel: "shared", outcome: "conflict" },
    { path: "tsconfig.json", ownerLabel: "shared", outcome: "merge" },
  ]);
  const referenceDir = folder("json-plain-reference-");
  write(referenceDir, "ours.json", `{\n  // indent\n  "indentWidth": 8\n}\n`);
  write(referenceDir, "old.json", `{\n  // indent\n  "indentWidth": 2\n}\n`);
  write(referenceDir, "new.json", `{\n  // indent\n  "indentWidth": 4\n}\n`);
  expect(
    gitMergeFile(
      join(referenceDir, "ours.json"),
      join(referenceDir, "old.json"),
      join(referenceDir, "new.json"),
    ),
  ).toBe("conflict");
  expect(readFileSync(join(oursDir, "biome.json"), "utf8")).toBe(
    readFileSync(join(referenceDir, "ours.json"), "utf8"),
  );
  expect(readFileSync(join(oursDir, "tsconfig.json"), "utf8")).toBe(
    '{\n  "a": 3,\n  "b": 2\n}\n',
  );
});

async function expectRerunHoldsMarkers(
  shape: ReturnType<typeof markedJsonShape>,
  appName: string,
): Promise<void> {
  const { templateClone } = cloneTemplateAtHead(folder);
  const settingsPath = "generated-repository/settings/.fallowrc.json";
  const baseCommit = commitIn(templateClone, "json shape base", {
    [settingsPath]: shape.old,
  }).sha;
  const targetCommit = commitIn(templateClone, "json shape target", {
    [settingsPath]: shape.next,
  }).sha;
  const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    appName,
  );
  commitIn(repo, "owner adds boundaries", { ".fallowrc.json": shape.ours });
  const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const args = applyNoCheckJsonArgs(repo, targetCommit);

  const first = await invokeTemplateUpgradeMain(stdout, stderr, args, runtime);
  const firstPayload = JSON.parse(first.stdout) as {
    status: string;
    conflicts: string[];
    worktree: string;
  };
  expect({ exitCode: first.exitCode, ...firstPayload }).toMatchObject({
    exitCode: 2,
    status: "conflicts",
    conflicts: [".fallowrc.json"],
  });
  const worktree = firstPayload.worktree;

  writeFileSync(
    join(worktree, "README.md"),
    `${readFileSync(join(worktree, "README.md"), "utf8")}\nOwner note.\n`,
  );
  const rerun = await invokeTemplateUpgradeMain(stdout, stderr, args, runtime);
  expect({
    exitCode: rerun.exitCode,
    ...(JSON.parse(rerun.stdout) as object),
  }).toMatchObject({
    exitCode: 5,
    status: "resolution-in-progress",
    conflicts: [".fallowrc.json"],
  });
  expect(
    gitResult(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)
      .exitCode,
  ).not.toBe(0);
  expect(readFileSync(join(worktree, ".fallowrc.json"), "utf8")).toBe(
    shape.marked,
  );
}

test(
  "rerunning apply after editing another file reports a clean-text JSON key conflict as resolution-in-progress and commits nothing",
  async () => {
    await expectRerunHoldsMarkers(cleanTextShape, "json-duplicate-key-app");
  },
  processWatchdog(4),
);

test(
  "rerunning apply after editing another file reports a JSON key conflict beside a text conflict as resolution-in-progress and commits nothing",
  async () => {
    await expectRerunHoldsMarkers(textConflictShape, "json-text-conflict-app");
  },
  processWatchdog(4),
);

test(
  "rerunning apply after editing another file reports a JSON file that does not parse and repeats a member as resolution-in-progress and commits nothing",
  async () => {
    await expectRerunHoldsMarkers(commentedShape, "json-commented-app");
  },
  processWatchdog(4),
);
