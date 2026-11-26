import { expect, test } from "bun:test";
import {
  diffPackageDependencies,
  mergeJsonDocuments,
  readPackageChanges,
  tryMergeJsonText,
} from "../../../src/template-upgrade-json-merge.ts";

function samplePackageDocuments() {
  const base = {
    name: "demo-app",
    version: "0.0.0",
    private: true,
    scripts: { check: "bun run lint", test: "bun test" },
    devDependencies: { "@biomejs/biome": "2.6.7", eslint: "10.15.0" },
  };
  const next = {
    name: "demo-app",
    version: "0.0.0",
    private: true,
    engines: { bun: ">=1.4.4" },
    scripts: { check: "bun run lint", test: "bun test" },
    devDependencies: { "@biomejs/biome": "2.6.8", eslint: "10.15.0" },
  };
  const ours = {
    name: "demo-app",
    version: "0.1.0",
    bin: { "demo-app": "./src/cli.ts" },
    private: true,
    scripts: {
      check: "bun run lint",
      test: "bun test",
      build: "bun build",
    },
    devDependencies: {
      "@biomejs/biome": "2.6.7",
      eslint: "10.15.0",
      "owner-tool": "1.0.0",
    },
  };
  return { base, next, ours };
}

test("preserves repository key order and inserts a new key after its nearest earlier neighbour from new", () => {
  const { base, next, ours } = samplePackageDocuments();
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual([]);
  const parsed = JSON.parse(result.mergedText) as Record<string, unknown>;
  expect(Object.keys(parsed)).toEqual([
    "name",
    "version",
    "bin",
    "private",
    "engines",
    "scripts",
    "devDependencies",
  ]);
  expect(parsed).toEqual({
    name: "demo-app",
    version: "0.1.0",
    bin: { "demo-app": "./src/cli.ts" },
    private: true,
    engines: { bun: ">=1.4.4" },
    scripts: {
      check: "bun run lint",
      test: "bun test",
      build: "bun build",
    },
    devDependencies: {
      "@biomejs/biome": "2.6.8",
      eslint: "10.15.0",
      "owner-tool": "1.0.0",
    },
  });
});

test("inserts a new first key at index zero when it has no earlier neighbour in new", () => {
  const base = { b: 1, c: 2 };
  const next = { a: 0, b: 1, c: 2 };
  const ours = { c: 2, b: 1, custom: true };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual([]);
  expect(Object.keys(JSON.parse(result.mergedText) as object)).toEqual([
    "a",
    "c",
    "b",
    "custom",
  ]);
});

test("deletes a key removed in new when unchanged in ours", () => {
  const base = { keep: 1, removeMe: 2 };
  const next = { keep: 1 };
  const ours = { keep: 1, removeMe: 2, mine: 3 };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual([]);
  expect(JSON.parse(result.mergedText)).toEqual({ keep: 1, mine: 3 });
});

test("keeps an owner deletion when new leaves the key unchanged and accepts identical edits on both sides", () => {
  const base = { dropByOwner: 1, bothChanged: "v1", keep: true };
  const next = { dropByOwner: 1, bothChanged: "v2", keep: true };
  const ours = { bothChanged: "v2", keep: true };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual([]);
  expect(JSON.parse(result.mergedText)).toEqual({
    bothChanged: "v2",
    keep: true,
  });
});

test("renders an empty object when owner and new delete the remaining keys", () => {
  const base = { ownerDeleted: 1, newDeleted: 2 };
  const next = { ownerDeleted: 1 };
  const ours = { newDeleted: 2 };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual([]);
  expect(result.mergedText).toBe("{}\n");
  expect(result.markedText).toBe("{}\n");
});

test("marks delete-versus-modify conflicts on both sides without dropping the surviving value", () => {
  const base = { deletedInOurs: 1, deletedInNew: 2 };
  const next = { deletedInOurs: 3 };
  const ours = { deletedInNew: 4 };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual(["$.deletedInOurs", "$.deletedInNew"]);
  expect(result.conflicts).toEqual([
    { path: "$.deletedInOurs", base: 1, next: 3 },
    { path: "$.deletedInNew", base: 2, ours: 4 },
  ]);
  expect(JSON.parse(result.mergedText)).toEqual({ deletedInNew: 4 });
  expect(result.markedText).toBe(
    [
      "{",
      "<<<<<<< ours",
      "=======",
      '  "deletedInOurs": 3,',
      ">>>>>>> new",
      "<<<<<<< ours",
      '  "deletedInNew": 4',
      "=======",
      ">>>>>>> new",
      "}",
      "",
    ].join("\n"),
  );
});

test("recursively merges nested objects added on both sides when base is not an object", () => {
  const base = { settings: "legacy" };
  const next = { settings: { templateKey: true } };
  const ours = { settings: { ownerKey: 1 } };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual([]);
  expect(JSON.parse(result.mergedText)).toEqual({
    settings: { templateKey: true, ownerKey: 1 },
  });
});

test("records a conflict path, values, and member-level markers when all three disagree on a key", () => {
  const base = {
    name: "demo",
    devDependencies: { "@biomejs/biome": "2.6.7", eslint: "10.15.0" },
  };
  const next = {
    name: "demo",
    devDependencies: { "@biomejs/biome": "2.6.8", eslint: "10.15.0" },
  };
  const ours = {
    name: "demo",
    devDependencies: {
      "@biomejs/biome": "2.6.9",
      eslint: "10.15.0",
      "owner-tool": "1.0.0",
    },
  };
  const result = mergeJsonDocuments(ours, base, next);
  expect(result.conflictPaths).toEqual(["$.devDependencies.@biomejs/biome"]);
  expect(result.conflicts).toEqual([
    {
      path: "$.devDependencies.@biomejs/biome",
      base: "2.6.7",
      ours: "2.6.9",
      next: "2.6.8",
    },
  ]);
  expect(result.markedText).toBe(
    [
      "{",
      '  "name": "demo",',
      '  "devDependencies": {',
      "<<<<<<< ours",
      '    "@biomejs/biome": "2.6.9",',
      "=======",
      '    "@biomejs/biome": "2.6.8",',
      ">>>>>>> new",
      '    "eslint": "10.15.0",',
      '    "owner-tool": "1.0.0"',
      "  }",
      "}",
      "",
    ].join("\n"),
  );
  expect(JSON.parse(result.mergedText)).toEqual(ours);
});

test("tryMergeJsonText returns undefined when any document is not valid JSON", () => {
  expect(tryMergeJsonText("{invalid", "{}", "{}")).toBeUndefined();
  const valid = tryMergeJsonText('{"a":1}', '{"a":1}', '{"a":2}');
  expect(valid).toEqual({
    mergedText: '{\n  "a": 2\n}\n',
    markedText: '{\n  "a": 2\n}\n',
    conflictPaths: [],
    conflicts: [],
  });
});

test("readPackageChanges reports unavailable instead of removals when package.json cannot be parsed", () => {
  const before = JSON.stringify({
    dependencies: { "agent-cli-kernel": "github:org/repo#aaa", rumdl: "0.3.5" },
  });
  const marked = `<<<<<<< ours\n${before}\n=======\n{}\n>>>>>>> new\n`;
  expect(readPackageChanges(before, marked)).toEqual({
    changes: [],
    unavailableReason: "merged package.json could not be parsed as JSON",
  });
  expect(readPackageChanges("{bad", before)).toEqual({
    changes: [],
    unavailableReason: "current package.json could not be parsed as JSON",
  });
});

test("diffPackageDependencies reports added, changed, and removed dependency entries", () => {
  const before = JSON.stringify({
    dependencies: { "agent-cli-kernel": "github:org/repo#aaa" },
    devDependencies: {
      "@biomejs/biome": "2.6.7",
      "removed-pkg": "1.0.0",
    },
    overrides: { old: "1.0.0" },
  });
  const after = JSON.stringify({
    dependencies: { "agent-cli-kernel": "github:org/repo#bbb" },
    devDependencies: {
      "@biomejs/biome": "2.6.8",
      "added-pkg": "2.0.0",
    },
    overrides: { old: "1.0.0" },
  });
  expect(diffPackageDependencies(before, after)).toEqual([
    {
      section: "dependencies",
      packageName: "agent-cli-kernel",
      before: "github:org/repo#aaa",
      after: "github:org/repo#bbb",
    },
    {
      section: "devDependencies",
      packageName: "@biomejs/biome",
      before: "2.6.7",
      after: "2.6.8",
    },
    {
      section: "devDependencies",
      packageName: "added-pkg",
      before: null,
      after: "2.0.0",
    },
    {
      section: "devDependencies",
      packageName: "removed-pkg",
      before: "1.0.0",
      after: null,
    },
  ]);
});
