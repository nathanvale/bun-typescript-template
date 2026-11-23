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

function duplicateKeyJsonShape() {
  const old =
    '{\n  "entry": ["a"],\n  "x1": 1,\n  "x2": 2,\n  "x3": 3,\n  "x4": 4,\n  "x5": 5,\n  "rules": {"r": "error"}\n}\n';
  const ours = old.replace(
    '  "entry": ["a"],\n',
    '  "entry": ["a"],\n  "boundaries": {"zones": ["mine"]},\n',
  );
  const next = old.replace(
    '  "rules": {"r": "error"}\n',
    '  "rules": {"r": "error"},\n  "boundaries": {"zones": ["template"]}\n',
  );
  return {
    old,
    ours,
    next,
    marked: `<<<<<<< ours\n${ours}=======\n${next}>>>>>>> new\n`,
  };
}

test("a JSON key conflict whose text merges cleanly is written as one marked conflict, ours above new, that does not parse", async () => {
  const shape = duplicateKeyJsonShape();
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
});

test("an ordinary JSON text conflict keeps git merge-file's markers and a clean JSON key merge writes the merged keys", async () => {
  const oldDir = folder("json-plain-old-");
  const newDir = folder("json-plain-new-");
  const oursDir = folder("json-plain-ours-");
  write(oldDir, "biome.json", '{\n  "indentWidth": 2\n}\n');
  write(newDir, "biome.json", '{\n  "indentWidth": 4\n}\n');
  write(oursDir, "biome.json", '{\n  "indentWidth": 8\n}\n');
  write(oldDir, "tsconfig.json", '{"a": 1, "b": 1}\n');
  write(newDir, "tsconfig.json", '{"a": 1, "b": 2}\n');
  write(oursDir, "tsconfig.json", '{"a": 3, "b": 1}\n');

  const rows = await mergeTemplateUpgradeTrees(oldDir, newDir, oursDir);
  expect(rows).toEqual([
    { path: "biome.json", ownerLabel: "shared", outcome: "conflict" },
    { path: "tsconfig.json", ownerLabel: "shared", outcome: "merge" },
  ]);
  const referenceDir = folder("json-plain-reference-");
  write(referenceDir, "ours.json", '{\n  "indentWidth": 8\n}\n');
  write(referenceDir, "old.json", '{\n  "indentWidth": 2\n}\n');
  write(referenceDir, "new.json", '{\n  "indentWidth": 4\n}\n');
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

test(
  "rerunning apply after editing another file reports a clean-text JSON key conflict as resolution-in-progress and commits nothing",
  async () => {
    const shape = duplicateKeyJsonShape();
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
      "json-duplicate-key-app",
    );
    commitIn(repo, "owner adds boundaries", { ".fallowrc.json": shape.ours });
    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = applyNoCheckJsonArgs(repo, targetCommit);

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
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
    const rerun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect({
      exitCode: rerun.exitCode,
      ...(JSON.parse(rerun.stdout) as object),
    }).toMatchObject({
      exitCode: 5,
      status: "resolution-in-progress",
      conflicts: [".fallowrc.json"],
    });
    expect(
      gitResult(
        repo,
        "rev-parse",
        "--verify",
        "--quiet",
        `refs/heads/${branch}`,
      ).exitCode,
    ).not.toBe(0);
    expect(readFileSync(join(worktree, ".fallowrc.json"), "utf8")).toBe(
      shape.marked,
    );
  },
  processWatchdog(4),
);
