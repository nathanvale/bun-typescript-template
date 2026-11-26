import { expect, test } from "bun:test";
import { findRecordedHitsGrowth } from "../../../src/template-upgrade-recorded-hits-growth.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";

const folder = ownedFolders();
const CLONE_FILE = "fallow-duplicates-recorded-hits.json";
const OLD_LABEL =
  "src/shared/markdown-files.ts:399-403|src/shared/markdown-files.ts:473-478";
const MOVED_LABEL =
  "src/shared/markdown-sections.ts:170-175|src/shared/markdown-sections.ts:92-96";

function growthOf(
  file: string,
  before: Readonly<Record<string, unknown>>,
  after: Readonly<Record<string, unknown>>,
): ReturnType<typeof findRecordedHitsGrowth> {
  const worktree = folder("recorded-hits-clone-");
  write(worktree, file, `${JSON.stringify(after, null, 2)}\n`);
  const snapshots = new Map([
    [file, new TextEncoder().encode(`${JSON.stringify(before, null, 2)}\n`)],
  ]);
  return findRecordedHitsGrowth(worktree, snapshots);
}

const recordedBeforeMove = {
  kind: "dupes",
  clone_groups: [OLD_LABEL],
  clone_fingerprints: ["dup:d7d81527:2"],
  normalized_clone_fingerprints: ["dup:56cf1cbc:2"],
};

test("a duplicates file whose clone moved files, keeping its normalized fingerprint, does not grow", () => {
  const growth = growthOf(CLONE_FILE, recordedBeforeMove, {
    kind: "dupes",
    clone_groups: [MOVED_LABEL],
    clone_fingerprints: ["dup:0b2c41f9:2"],
    normalized_clone_fingerprints: ["dup:56cf1cbc:2"],
  });
  expect(growth).toEqual([]);
});

test("a duplicates file that gains a normalized fingerprint grows, naming only that fingerprint", () => {
  const growth = growthOf(CLONE_FILE, recordedBeforeMove, {
    kind: "dupes",
    clone_groups: [OLD_LABEL, "src/a.ts:1-9|src/b.ts:4-12"],
    clone_fingerprints: ["dup:d7d81527:2", "dup:7a7a7a7a:2"],
    normalized_clone_fingerprints: ["dup:56cf1cbc:2", "dup:e4e4e4e4:2"],
  });
  expect(growth).toEqual([
    {
      file: CLONE_FILE,
      entries: ["normalized_clone_fingerprints: dup:e4e4e4e4:2"],
    },
  ]);
});

test("a duplicates file whose clone gains an instance grows", () => {
  const growth = growthOf(CLONE_FILE, recordedBeforeMove, {
    kind: "dupes",
    clone_groups: [`${MOVED_LABEL}|src/shared/markdown-sections.ts:210-215`],
    clone_fingerprints: ["dup:d7d81527:3"],
    normalized_clone_fingerprints: ["dup:56cf1cbc:3"],
  });
  expect(growth).toEqual([
    {
      file: CLONE_FILE,
      entries: ["normalized_clone_fingerprints: dup:56cf1cbc:3"],
    },
  ]);
});

test("a duplicates file that gains a second clone with the same normalized fingerprint grows", () => {
  const growth = growthOf(CLONE_FILE, recordedBeforeMove, {
    kind: "dupes",
    clone_groups: [OLD_LABEL, MOVED_LABEL],
    clone_fingerprints: ["dup:d7d81527:2", "dup:0b2c41f9:2"],
    normalized_clone_fingerprints: ["dup:56cf1cbc:2", "dup:56cf1cbc:2"],
  });
  expect(growth).toEqual([
    {
      file: CLONE_FILE,
      entries: ["normalized_clone_fingerprints: dup:56cf1cbc:2 (1 -> 2)"],
    },
  ]);
});

test("a duplicates file without normalized fingerprints on one side counts a new clone label as growth", () => {
  const growth = growthOf(
    CLONE_FILE,
    {
      kind: "dupes",
      clone_groups: [OLD_LABEL],
      clone_fingerprints: ["dup:d7d81527:2"],
    },
    {
      kind: "dupes",
      clone_groups: [MOVED_LABEL],
      clone_fingerprints: ["dup:d7d81527:2"],
      normalized_clone_fingerprints: ["dup:56cf1cbc:2"],
    },
  );
  expect(growth).toEqual([
    {
      file: CLONE_FILE,
      entries: [
        `clone_groups: ${MOVED_LABEL}`,
        "normalized_clone_fingerprints: dup:56cf1cbc:2",
      ],
    },
  ]);
});

test("a recorded file that is not a duplicates file still counts a new clone label as growth", () => {
  const growth = growthOf(
    "fallow-other-recorded-hits.json",
    { ...recordedBeforeMove, kind: "other" },
    {
      kind: "other",
      clone_groups: [MOVED_LABEL],
      clone_fingerprints: ["dup:d7d81527:2"],
      normalized_clone_fingerprints: ["dup:56cf1cbc:2"],
    },
  );
  expect(growth).toEqual([
    {
      file: "fallow-other-recorded-hits.json",
      entries: [`clone_groups: ${MOVED_LABEL}`],
    },
  ]);
});

test("a health file whose finding count rises still grows", () => {
  const growth = growthOf(
    "fallow-health-recorded-hits.json",
    { kind: "health", finding_counts: { "src/a.ts": 1 } },
    { kind: "health", finding_counts: { "src/a.ts": 2 } },
  );
  expect(growth).toEqual([
    {
      file: "fallow-health-recorded-hits.json",
      entries: ["finding_counts.src/a.ts (1 -> 2)"],
    },
  ]);
});
