import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const root = join(import.meta.dir, "../../..");
const recordedHitsFile =
  "tests/template/standards/coverage-gaps-recorded-hits.json";
const fallowArgs = [
  "health",
  "--coverage-gaps",
  "--format",
  "json",
  "--quiet",
] as const;
const fallowRun = `node_modules/.bin/fallow ${fallowArgs.join(" ")}`;
const done = "Done when bun run test:area standards passes.";
const gapsReport = `${fallowRun}: its "coverage_gaps"`;

type Gap = { readonly path: string; readonly exportName?: string };

function shown({ path, exportName }: Gap): string {
  return exportName === undefined ? path : `${path} export ${exportName}`;
}

function field(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? new Map(Object.entries(value)).get(key)
    : undefined;
}

function listAt(
  value: unknown,
  key: string,
  where: string,
  repair: string,
): unknown[] {
  const list = field(value, key);
  if (!Array.isArray(list))
    throw new Error(
      `${where} has no "${key}" array. Repair: ${repair} ${done}`,
    );
  return list;
}

function textAt(value: unknown, key: string, where: string): string {
  const text = field(value, key);
  if (typeof text !== "string" || text === "")
    throw new Error(
      `${where} needs a non-empty ${key}. Repair: write it as a non-empty string. ${done}`,
    );
  return text;
}

function countedList(gaps: unknown, key: string, count: string): unknown[] {
  const countsNone = field(field(gaps, "summary"), count) === 0;
  return countsNone && field(gaps, key) === undefined
    ? []
    : listAt(
        gaps,
        key,
        gapsReport,
        "install the pinned fallow with bun install --frozen-lockfile.",
      );
}

function reportedGaps(report: string): Gap[] {
  const gaps = field(JSON.parse(report), "coverage_gaps");
  return [
    ...countedList(gaps, "files", "untested_files").map((entry, index) => ({
      path: textAt(entry, "path", `${gapsReport}.files[${index}]`),
    })),
    ...countedList(gaps, "exports", "untested_exports").map((entry, index) => ({
      path: textAt(entry, "path", `${gapsReport}.exports[${index}]`),
      exportName: textAt(
        entry,
        "export_name",
        `${gapsReport}.exports[${index}]`,
      ),
    })),
  ];
}

function recordedGaps(text: string): Gap[] {
  return listAt(
    JSON.parse(text),
    "hits",
    recordedHitsFile,
    'add "hits": [] at its top level.',
  ).map((entry, index) => {
    const where = `${recordedHitsFile}: hits[${index}]`;
    const path = textAt(entry, "path", where);
    textAt(entry, "reason", where);
    return field(entry, "export") === undefined
      ? { path }
      : { path, exportName: textAt(entry, "export", where) };
  });
}

function gapProblems(reported: readonly Gap[], recorded: readonly Gap[]) {
  const reportedKeys = new Set(reported.map(shown));
  const recordedKeys = new Set(recorded.map(shown));
  const repair =
    "Repair: import and call it from a test, beside any test that spawns it.";
  return [
    ...reported
      .filter((gap) => !recordedKeys.has(shown(gap)))
      .map(({ path, exportName }) =>
        exportName === undefined
          ? `${path}: no test imports this runtime file, so only a spawned process runs its functions. ${repair} ${done}`
          : `${path}: no test imports its export ${exportName}, so only a spawned process runs it. ${repair} ${done}`,
      ),
    ...recorded
      .filter((gap) => !reportedKeys.has(shown(gap)))
      .map(
        (gap) =>
          `${recordedHitsFile}: records ${shown(gap)}, which fallow no longer reports as a coverage gap. Repair: remove that recorded hit. ${done}`,
      ),
  ];
}

async function fallowGaps(): Promise<Gap[]> {
  const run = await spawnBounded(
    [join(root, "node_modules/.bin/fallow"), ...fallowArgs],
    { cwd: root },
  );
  if (run.exit !== 0)
    throw new Error(
      `${fallowRun}: exited ${run.exit}: ${run.stderr.trim()} Repair: run it by hand and fix what it prints, or run bun install --frozen-lockfile. ${done}`,
    );
  return reportedGaps(run.stdout);
}

test(
  "every runtime file and export is imported by a test, apart from its recorded hits",
  async () => {
    const recorded = recordedGaps(
      readFileSync(join(root, recordedHitsFile), "utf8"),
    );
    expect(gapProblems(await fallowGaps(), recorded)).toEqual([]);
  },
  processWatchdog(1),
);

const fixtureReport = JSON.stringify({
  coverage_gaps: {
    files: [{ path: "scripts/spawned.ts" }],
    exports: [{ path: "scripts/runner.ts", export_name: "run" }],
  },
});
const fixtureHits = (hits: object[]) => JSON.stringify({ hits });
const spawnedHit = { path: "scripts/spawned.ts", reason: "fixture" };
const runHit = { path: "scripts/runner.ts", export: "run", reason: "fixture" };

test("a gap fallow reports and the recorded hits list passes", () => {
  expect(
    gapProblems(
      reportedGaps(fixtureReport),
      recordedGaps(fixtureHits([spawnedHit, runHit])),
    ),
  ).toEqual([]);
});

test.each([
  [
    "a runtime file no test imports",
    [runHit],
    [
      `scripts/spawned.ts: no test imports this runtime file, so only a spawned process runs its functions. Repair: import and call it from a test, beside any test that spawns it. ${done}`,
    ],
  ],
  [
    "an export no test imports",
    [spawnedHit],
    [
      `scripts/runner.ts: no test imports its export run, so only a spawned process runs it. Repair: import and call it from a test, beside any test that spawns it. ${done}`,
    ],
  ],
  [
    "a recorded export that fallow no longer reports",
    [spawnedHit, runHit, { ...runHit, export: "stop" }],
    [
      `${recordedHitsFile}: records scripts/runner.ts export stop, which fallow no longer reports as a coverage gap. Repair: remove that recorded hit. ${done}`,
    ],
  ],
  [
    "a recorded file that fallow no longer reports",
    [spawnedHit, runHit, { path: "scripts/imported.ts", reason: "fixture" }],
    [
      `${recordedHitsFile}: records scripts/imported.ts, which fallow no longer reports as a coverage gap. Repair: remove that recorded hit. ${done}`,
    ],
  ],
  [
    "a recorded file standing in for its export",
    [spawnedHit, { path: "scripts/runner.ts", reason: "fixture" }],
    [
      `scripts/runner.ts: no test imports its export run, so only a spawned process runs it. Repair: import and call it from a test, beside any test that spawns it. ${done}`,
      `${recordedHitsFile}: records scripts/runner.ts, which fallow no longer reports as a coverage gap. Repair: remove that recorded hit. ${done}`,
    ],
  ],
])("%s fails, naming the path and the repair", (_case, hits, expected) => {
  expect(
    gapProblems(reportedGaps(fixtureReport), recordedGaps(fixtureHits(hits))),
  ).toEqual(expected);
});

test("a list fallow leaves out is read as empty when its summary counts none", () => {
  const summary = { untested_files: 0, untested_exports: 1 };
  const exports = [{ path: "scripts/runner.ts", export_name: "run" }];
  expect(
    reportedGaps(JSON.stringify({ coverage_gaps: { summary, exports } })),
  ).toEqual([{ path: "scripts/runner.ts", exportName: "run" }]);
});

test.each([
  [
    "a recorded hit with no reason",
    () => recordedGaps(fixtureHits([{ path: "scripts/spawned.ts" }])),
    `${recordedHitsFile}: hits[0] needs a non-empty reason. Repair: write it as a non-empty string. ${done}`,
  ],
  [
    "a recorded hit with an empty export",
    () => recordedGaps(fixtureHits([{ ...runHit, export: "" }])),
    `${recordedHitsFile}: hits[0] needs a non-empty export. Repair: write it as a non-empty string. ${done}`,
  ],
  [
    "a fallow report with no coverage gaps",
    () => reportedGaps("{}"),
    `${fallowRun}: its "coverage_gaps" has no "files" array. Repair: install the pinned fallow with bun install --frozen-lockfile. ${done}`,
  ],
  [
    "a fallow report that counts a gap and lists none",
    () =>
      reportedGaps(
        JSON.stringify({
          coverage_gaps: {
            summary: { untested_files: 0, untested_exports: 1 },
          },
        }),
      ),
    `${fallowRun}: its "coverage_gaps" has no "exports" array. Repair: install the pinned fallow with bun install --frozen-lockfile. ${done}`,
  ],
])("%s is refused, naming the field", (_case, read, message) => {
  expect(read).toThrow(message);
});
