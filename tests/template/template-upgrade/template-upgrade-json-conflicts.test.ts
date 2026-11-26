import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gitMergeFile } from "../../../src/template-upgrade-git.ts";
import type { JsonKeyConflict } from "../../../src/template-upgrade-json-merge.ts";
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

function markedJsonShape(ours: string, next: string, old = OLD_JSON) {
  return {
    old,
    ours,
    next,
    marked: `<<<<<<< ours\n${ours}=======\n${next}>>>>>>> new\n`,
  };
}

const CLEAN_TEXT_MARKED = [
  "{",
  '  "entry": [',
  '    "a"',
  "  ],",
  '  "boundaries": {',
  "<<<<<<< ours",
  '    "zones": [',
  '      "mine"',
  "    ]",
  "=======",
  '    "zones": [',
  '      "template"',
  "    ]",
  ">>>>>>> new",
  "  },",
  '  "x1": 1,',
  '  "x2": 2,',
  '  "x3": 3,',
  '  "x4": 4,',
  '  "x5": 5,',
  '  "rules": {',
  '    "r": "error"',
  "  }",
  "}",
  "",
].join("\n");

const TEXT_CONFLICT_MARKED = CLEAN_TEXT_MARKED.replace(
  '  "x5": 5,\n',
  '<<<<<<< ours\n  "x5": "OURS",\n=======\n  "x5": "NEW",\n>>>>>>> new\n',
);

const BOUNDARIES_CONFLICT: JsonKeyConflict = {
  path: "$.boundaries.zones",
  ours: ["mine"],
  next: ["template"],
};

const cleanTextShape = {
  old: OLD_JSON,
  ours: OURS_BOUNDARIES,
  next: NEW_BOUNDARIES,
  marked: CLEAN_TEXT_MARKED,
  keyConflicts: [BOUNDARIES_CONFLICT],
};
const textConflictShape = {
  old: OLD_JSON,
  ours: OURS_BOUNDARIES.replace(X5_LINE, '  "x5": "OURS",\n'),
  next: NEW_BOUNDARIES.replace(X5_LINE, '  "x5": "NEW",\n'),
  marked: TEXT_CONFLICT_MARKED,
  keyConflicts: [
    BOUNDARIES_CONFLICT,
    { path: "$.x5", base: 5, ours: "OURS", next: "NEW" },
  ],
};
const commentedShape = markedJsonShape(
  OURS_BOUNDARIES.replace(ENTRY_LINE, '  "entry": ["a"], // owner note\n'),
  NEW_BOUNDARIES,
);

const X6_TO_X10 = [6, 7, 8, 9, 10].map((n) => `  "x${n}": ${n},\n`).join("");
const withX6ToX10 = (text: string) =>
  text.replace('  "rules"', `${X6_TO_X10}  "rules"`);
const X5_HUNK =
  /<{7} ours\n( {2}"x5": "OURS",\n)(?:\|{7} old\n {2}"x5": 5,\n)?={7}\n {2}"x5": "NEW",\n>{7} new\n/;
const commentedHunkShape = markedJsonShape(
  withX6ToX10(
    textConflictShape.ours.replace(
      ENTRY_LINE,
      '  "entry": ["a"], // owner note\n',
    ),
  ),
  withX6ToX10(textConflictShape.next),
  withX6ToX10(OLD_JSON),
);

const crlf = (text: string) => text.replaceAll("\n", "\r\n");
const NESTED_CLOSE = '    "r": "error"\n  }\n}\n';
const OLD_NESTED = OLD_JSON.replace(
  RULES_LINE,
  `  "rules": {\n${NESTED_CLOSE}`,
);
const crlfBraceHunkShape = markedJsonShape(
  crlf(
    OLD_NESTED.replace(
      ENTRY_LINE,
      '  "entry": ["a"], // owner note\n  "boundaries": {"zones": ["mine"]},\n',
    ).replace(NESTED_CLOSE, '    "r": "error"\n  } // owner end\n}\n'),
  ),
  crlf(
    OLD_NESTED.replace(
      NESTED_CLOSE,
      '    "r": "error"\n  },\n  "boundaries": {"zones": ["template"]}\n}\n',
    ),
  ),
  crlf(OLD_NESTED),
);
const CRLF_BRACE_HUNK =
  /<{7} ours\r\n( {2}\} \/\/ owner end\r\n)(?:\|{7} old\r\n {2}\}\r\n)?={7}\r\n[\s\S]*?>{7} new\r\n/;

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

async function expectKeyMarked(shape: typeof cleanTextShape): Promise<void> {
  const oldDir = folder("json-key-old-");
  const newDir = folder("json-key-new-");
  const oursDir = folder("json-key-ours-");
  write(oldDir, ".fallowrc.json", shape.old);
  write(newDir, ".fallowrc.json", shape.next);
  write(oursDir, ".fallowrc.json", shape.ours);

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    {
      path: ".fallowrc.json",
      ownerLabel: "shared",
      outcome: "conflict",
      keyConflicts: shape.keyConflicts,
    },
  ]);
  const written = readFileSync(join(oursDir, ".fallowrc.json"), "utf8");
  expect(written).toBe(shape.marked);
  expect(written.startsWith("<<<<<<< ours\n")).toBe(false);
  expect(written.match(/"boundaries"/g)?.length).toBe(1);
  expect(() => {
    JSON.parse(written);
  }).toThrow("JSON Parse error");
}

test("a JSON key conflict whose text merges cleanly is written with member-level markers, ours above new, that do not parse", async () => {
  await expectKeyMarked(cleanTextShape);
});

test("a JSON key conflict beside a text conflict is written with member-level markers, so no member repeats outside the markers", async () => {
  await expectKeyMarked(textConflictShape);
});

test("a JSON file that does not parse and whose clean text merge repeats a member is written as one marked conflict", async () => {
  await expectWholeFileMarked(commentedShape);
});

test("a JSON file that does not parse and whose text conflict leaves a repeated member outside git's markers is written as one marked conflict", async () => {
  await expectWholeFileMarked(commentedHunkShape);
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

async function expectGitMarkersKept(lineEnding: (text: string) => string) {
  const oldDir = folder("json-plain-old-");
  const newDir = folder("json-plain-new-");
  const oursDir = folder("json-plain-ours-");
  write(
    oldDir,
    "biome.json",
    lineEnding(`{\n  // indent\n  "indentWidth": 2\n}\n`),
  );
  write(
    newDir,
    "biome.json",
    lineEnding(`{\n  // indent\n  "indentWidth": 4\n}\n`),
  );
  write(
    oursDir,
    "biome.json",
    lineEnding(`{\n  // indent\n  "indentWidth": 8\n}\n`),
  );
  write(oldDir, "tsconfig.json", '{"a": 1, "b": 1}\n');
  write(newDir, "tsconfig.json", '{"a": 1, "b": 2}\n');
  write(oursDir, "tsconfig.json", '{"a": 3, "b": 1}\n');

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: "biome.json", ownerLabel: "shared", outcome: "conflict" },
    { path: "tsconfig.json", ownerLabel: "shared", outcome: "merge" },
  ]);
  const referenceDir = folder("json-plain-reference-");
  write(
    referenceDir,
    "ours.json",
    lineEnding(`{\n  // indent\n  "indentWidth": 8\n}\n`),
  );
  write(
    referenceDir,
    "old.json",
    lineEnding(`{\n  // indent\n  "indentWidth": 2\n}\n`),
  );
  write(
    referenceDir,
    "new.json",
    lineEnding(`{\n  // indent\n  "indentWidth": 4\n}\n`),
  );
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
}

test("a JSON text conflict with no key conflict keeps git merge-file's markers and a clean JSON key merge writes the merged keys", async () => {
  await expectGitMarkersKept((text) => text);
});

test("a CRLF JSON text conflict with no repeated member keeps git merge-file's markers, as its LF twin does", async () => {
  await expectGitMarkersKept(crlf);
});

async function expectRerunHoldsMarkers(
  shape: ReturnType<typeof markedJsonShape>,
  appName: string,
  resolveVisibleHunk: (text: string) => string = (text) => text,
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
  const settingsFile = join(worktree, ".fallowrc.json");
  writeFileSync(
    settingsFile,
    resolveVisibleHunk(readFileSync(settingsFile, "utf8")),
  );

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

test(
  "rerunning apply after resolving git's visible hunk in a JSON file that does not parse and repeats a member outside it reports resolution-in-progress and commits nothing",
  async () => {
    await expectRerunHoldsMarkers(
      commentedHunkShape,
      "json-commented-hunk-app",
      (text) => text.replace(X5_HUNK, "$1"),
    );
  },
  processWatchdog(4),
);

test(
  "rerunning apply after resolving git's visible CRLF hunk at a nested object's closing brace, with a member repeated outside it, reports resolution-in-progress and commits nothing",
  async () => {
    await expectRerunHoldsMarkers(
      crlfBraceHunkShape,
      "json-crlf-brace-hunk-app",
      (text) => text.replace(CRLF_BRACE_HUNK, "$1"),
    );
  },
  processWatchdog(4),
);
