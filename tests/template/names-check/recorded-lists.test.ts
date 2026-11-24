import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import {
  recordedAdditionProblems,
  recordedListFiles,
} from "../../../scripts/glossary-additions.ts";
import {
  gitInNamesCheck,
  recordedHitsFile,
  recordedUnusedTermsFile,
} from "../../../scripts/glossary.ts";
import { git } from "../../support/git-fixture.ts";
import { namesCheckFixture, put } from "./names-check-fixture.ts";

const { emptyRepository } = namesCheckFixture();
const templateRoot = join(import.meta.dir, "../../..");

type Plant = {
  readonly landed: unknown;
  readonly grown: readonly unknown[];
  readonly shrunk: unknown;
  readonly approved: unknown;
};

const suppression = (count: number, extra: object = {}) => ({
  "repository/tests-use-test-folder": { count, ...extra },
});
const health = (identities: object) => ({
  kind: "health",
  finding_counts: {},
  identity_finding_counts: identities,
});
const codeWeight = {
  "src/cli-error.ts\u0000codeWeight": { complexity_critical: { count: 1 } },
};
const doneLine = {
  path: "scripts/doctor.ts",
  export: "doneLine",
  reason: "Only the spawned doctor calls it.",
};
const zorp = { word: "zorp", reason: "A ledger term." };
const landedGap = { path: "src/bootstrap.ts", export: "main", reason: "r" };
const landedHit = { path: "docs/host.md", word: "host", reason: "r" };
const landedTerm = { term: "Fixture term", reason: "r", ticket: "MAG-1" };
const landedWord = { word: "apply", reason: "r" };

const plants = new Map<string, Plant>([
  [
    "tests/template/names-check/recorded-hits.json",
    {
      landed: { hits: [landedHit] },
      grown: [{ hits: [landedHit, { ...landedHit, path: "docs/proof.md" }] }],
      shrunk: { hits: [] },
      approved: {
        hits: [landedHit, { ...landedHit, path: "a.md", approved: "MAG-1" }],
      },
    },
  ],
  [
    "tests/template/names-check/recorded-unused-terms.json",
    {
      landed: { terms: [landedTerm] },
      grown: [{ terms: [landedTerm, { ...landedTerm, term: "Other term" }] }],
      shrunk: { terms: [] },
      approved: {
        terms: [landedTerm, { ...landedTerm, term: "B", approved: "MAG-1" }],
      },
    },
  ],
  [
    "names-plain-words.json",
    {
      landed: { words: [landedWord] },
      grown: [{ words: [landedWord, zorp] }],
      shrunk: { words: [] },
      approved: { words: [landedWord, { ...zorp, approved: "MAG-1" }] },
    },
  ],
  [
    "tests/template/standards/coverage-gaps-recorded-hits.json",
    {
      landed: { hits: [landedGap] },
      grown: [{ hits: [landedGap, doneLine] }],
      shrunk: { hits: [] },
      approved: { hits: [landedGap, { ...doneLine, approved: "MAG-1" }] },
    },
  ],
  [
    "scripts/file-size-recorded-hits.json",
    {
      landed: { "a.json": { lifetime: "temporary", reason: "r" } },
      grown: [
        { "a.json": { lifetime: "standing", reason: "r" } },
        {
          "a.json": { lifetime: "temporary", reason: "r" },
          "b.json": { lifetime: "standing", reason: "r" },
        },
      ],
      shrunk: {},
      approved: {
        "a.json": { lifetime: "temporary", reason: "r" },
        "b.json": { lifetime: "standing", reason: "r", approved: "MAG-1" },
      },
    },
  ],
  [
    "eslint-suppressions.json",
    {
      landed: { "tests/a.test.ts": suppression(2) },
      grown: [
        { "tests/a.test.ts": suppression(3) },
        {
          "tests/a.test.ts": suppression(2),
          "src/cli-error.ts": {
            "repository/no-locale-compare": { count: 1 },
          },
        },
      ],
      shrunk: { "tests/a.test.ts": suppression(1) },
      approved: { "tests/a.test.ts": suppression(3, { approved: "MAG-1" }) },
    },
  ],
  [
    "fallow-health-recorded-hits.json",
    {
      landed: health({}),
      grown: [health(codeWeight)],
      shrunk: health({}),
      approved: health({
        "src/cli-error.ts\u0000codeWeight": {
          complexity_critical: { count: 1, approved: "MAG-1" },
        },
      }),
    },
  ],
]);

function problemsAfter(file: string, landed: unknown, current: unknown) {
  const root = emptyRepository();
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
  put(root, file, JSON.stringify(landed));
  git(root, "add", "--", recordedHitsFile, recordedUnusedTermsFile, file);
  git(root, "commit", "--quiet", "-m", "landed");
  put(root, file, JSON.stringify(current));
  return recordedAdditionProblems(root, "HEAD", (path) =>
    existsSync(join(root, path))
      ? readFileSync(join(root, path), "utf8")
      : undefined,
  );
}

test("every recorded list refuses a planted addition or rise, and passes a shrink and an approved landing", () => {
  expect([...recordedListFiles].sort()).toEqual([...plants.keys()].sort());
  for (const file of recordedListFiles) {
    const { landed, grown, shrunk, approved } = plants.get(file) ?? {
      landed: {},
      grown: [],
      shrunk: {},
      approved: {},
    };
    for (const plant of grown) {
      const refused = problemsAfter(file, landed, plant);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toStartWith(`${file} `);
      expect(refused[0]).toContain("so this change widens what");
    }
    expect(problemsAfter(file, landed, landed)).toEqual([]);
    expect(problemsAfter(file, landed, shrunk)).toEqual([]);
    expect(problemsAfter(file, landed, approved)).toEqual([]);
  }
});

test("an approval the base revision already holds does not admit a rise", () => {
  const file = "eslint-suppressions.json";
  const landed = { "tests/a.test.ts": suppression(2, { approved: "MAG-1" }) };
  expect(
    problemsAfter(file, landed, {
      "tests/a.test.ts": suppression(3, { approved: "MAG-1" }),
    }),
  ).toEqual([
    `${file} raises a recorded repository/tests-use-test-folder hit for tests/a.test.ts from 2 to 3, above what HEAD records, so this change widens what lint admits. Repair: remove it (fix the lint error, since eslint --suppress-rule writes the entry); or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`,
  ]);
});

const listName =
  /(?:recorded-[a-z-]+|plain-words|suppressions|baseline)\.json$/;
const configuredList =
  /--(?:[a-z]+-)*(?:baseline|suppressions-location)[ =]([^\s"&]+\.json)/g;

function readText(root: string, path: string): string {
  return existsSync(join(root, path))
    ? readFileSync(join(root, path), "utf8")
    : "";
}

function listsIn(paths: readonly string[], root: string, settings: string) {
  const configured = [
    ...readText(root, `${settings}package.json`).matchAll(configuredList),
    ...readText(root, `${settings}.fallowrc.json`).matchAll(
      /Baseline": "([^"]+)"/g,
    ),
  ].map(([, path]) => path ?? "");
  return new Set([
    ...paths.filter((path) => listName.test(path)),
    ...configured.map((path) => `${settings}${path}`),
    `${settings}eslint-suppressions.json`,
  ]);
}

function unguardedLists(paths: readonly string[], root: string): string[] {
  const settings = "generated-repository/settings/";
  const generated = listsIn(
    paths.filter((path) => path.startsWith("generated-repository/")),
    root,
    settings,
  );
  const template = listsIn(
    paths.filter((path) => !path.startsWith("generated-repository/")),
    root,
    "",
  );
  const guarded = new Set(recordedListFiles);
  const fallowScript = readText(root, `${settings}package.json`)
    .split("\n")
    .find((line) => line.includes('"quality:fallow":'));
  const growthStep = readText(
    root,
    "generated-repository/hosted-check/ci.yml",
  ).includes("quality:fallow -- --fail-on-baseline-growth");
  const generatedGuarded = (path: string) =>
    growthStep &&
    path.startsWith(settings) &&
    (fallowScript?.includes(` ${basename(path)}`) ?? false) &&
    paths.includes(path);
  return [
    ...[...template].filter((path) => !guarded.has(path)),
    ...[...generated].filter(
      (path) =>
        !generatedGuarded(path) &&
        (paths.includes(path) || basename(path) !== "eslint-suppressions.json"),
    ),
  ].sort();
}

test("every recorded list in this repository and in a generated repository has a shrink-only guard", () => {
  const tracked = gitInNamesCheck(templateRoot, ["ls-files", "-z"])
    .stdout.toString()
    .split("\0")
    .filter((path) => path !== "");
  expect(unguardedLists(tracked, templateRoot)).toEqual([]);
  expect(
    unguardedLists(
      [
        ...tracked,
        "tests/template/lint/lint-recorded-hits.json",
        "generated-repository/settings/eslint-suppressions.json",
      ],
      templateRoot,
    ),
  ).toEqual([
    "generated-repository/settings/eslint-suppressions.json",
    "tests/template/lint/lint-recorded-hits.json",
  ]);
});
