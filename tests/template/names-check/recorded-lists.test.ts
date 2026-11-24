import { expect, test } from "bun:test";
import { existsSync, lstatSync, readFileSync, rmSync } from "node:fs";
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
const health = (identities: object, extra: object = {}) => ({
  kind: "health",
  finding_counts: {},
  identity_finding_counts: identities,
  runtime_coverage_findings: [],
  target_keys: [],
  ...extra,
});
const targetKey = "src/cli-error.ts:high impact";
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
      grown: [
        health(codeWeight),
        health({}, { runtime_coverage_findings: ["src/cli-error.ts:fn"] }),
        health({}, { target_keys: [targetKey] }),
        health(
          {},
          {
            target_keys: [targetKey],
            approved: { runtime_coverage_findings: { [targetKey]: "MAG-1" } },
          },
        ),
      ],
      shrunk: health({}),
      approved: health(
        {
          "src/cli-error.ts\u0000codeWeight": {
            complexity_critical: { count: 1, approved: "MAG-1" },
          },
        },
        {
          target_keys: [targetKey],
          approved: { target_keys: { [targetKey]: "MAG-1" } },
        },
      ),
    },
  ],
]);

function landedList(file: string, landed: unknown) {
  const root = emptyRepository();
  put(root, recordedHitsFile, JSON.stringify({ hits: [] }));
  put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
  put(root, file, JSON.stringify(landed));
  git(root, "add", "--", recordedHitsFile, recordedUnusedTermsFile, file);
  git(root, "commit", "--quiet", "-m", "landed");
  return Object.assign(
    (current: unknown) => {
      put(root, file, JSON.stringify(current));
      return recordedAdditionProblems(root, "HEAD", (path) =>
        existsSync(join(root, path))
          ? readFileSync(join(root, path), "utf8")
          : undefined,
      );
    },
    { root },
  );
}

test("every recorded list has a planted addition", () => {
  expect([...recordedListFiles].sort()).toEqual([...plants.keys()].sort());
});

for (const [file, { landed, grown, shrunk, approved }] of plants)
  test(`${file} refuses a planted addition or rise, and passes a shrink and an approved landing`, () => {
    const problemsAfter = landedList(file, landed);
    for (const plant of grown) {
      const refused = problemsAfter(plant);
      expect(refused).toHaveLength(1);
      expect(refused[0]).toStartWith(`${file} `);
      expect(refused[0]).toContain("so this change widens what");
    }
    expect(problemsAfter(landed)).toEqual([]);
    expect(problemsAfter(shrunk)).toEqual([]);
    expect(problemsAfter(approved)).toEqual([]);
  });

test("a list the base revision holds but git cannot read stops the run, not read as absent", () => {
  const file = "names-plain-words.json";
  const problemsAfter = landedList(file, { words: [] });
  const root = problemsAfter.root;
  const blob = git(root, "rev-parse", `HEAD:${file}`);
  rmSync(join(root, ".git/objects", blob.slice(0, 2), blob.slice(2)));
  expect(() => problemsAfter({ words: [] })).toThrow(
    `git cannot read ${file} at `,
  );
});

test("an approval the base revision already holds does not admit a rise, even with spaces around it", () => {
  const file = "eslint-suppressions.json";
  const landed = { "tests/a.test.ts": suppression(2, { approved: "MAG-1" }) };
  expect(
    landedList(
      file,
      landed,
    )({
      "tests/a.test.ts": suppression(3, { approved: " MAG-1 " }),
    }),
  ).toEqual([
    `${file} raises a recorded repository/tests-use-test-folder hit for tests/a.test.ts from 2 to 3, above what HEAD records, so this change widens what lint admits. Repair: remove it (fix the lint error, since eslint --suppress-rule writes the entry); or, if it must stay, make a reviewed change that gives the entry an "approved" field naming the ticket or pull request that agreed it, with its reason.`,
  ]);
});

test("a recorded list in a form its reader does not know is refused, not read as empty", () => {
  const malformed: [string, unknown, unknown][] = [
    ["eslint-suppressions.json", {}, []],
    ["eslint-suppressions.json", {}, { "tests/a.test.ts": ["not-an-object"] }],
    ["eslint-suppressions.json", {}, { "tests/a.test.ts": suppression(-1) }],
    ["scripts/file-size-recorded-hits.json", {}, []],
    ["fallow-health-recorded-hits.json", health({}), []],
    ["fallow-health-recorded-hits.json", health({}), health({}, { more: [] })],
    ["fallow-health-recorded-hits.json", health({}), { kind: "health" }],
    ["names-plain-words.json", { words: [] }, { words: [{ word: "a", x: 1 }] }],
  ];
  for (const [file, landed, current] of malformed)
    expect(() => landedList(file, landed)(current)).toThrow(`${file} is not `);
});

const listName =
  /(?:recorded-[a-z-]+|plain-words|suppressions|baseline)\.json$/;

let overlay: ReadonlyMap<string, string> = new Map();

function readText(root: string, path: string): string {
  return (
    overlay.get(path) ??
    (existsSync(join(root, path)) && lstatSync(join(root, path)).isFile()
      ? readFileSync(join(root, path), "utf8")
      : "")
  );
}

const generatedSettings = "generated-repository/settings/";
const ciBaseRef = '"origin/${{ github.base_ref }}"';
const fallowRuns = new Map<string, readonly string[]>([
  [
    "package.json",
    [
      "bun run check:file-size && bun run lint && bun run format:check && bun run typecheck && bun run test && bun run --silent quality:fallow",
      "node_modules/.bin/fallow audit --baseline-mode identity --format json --quiet",
    ],
  ],
  [
    `${generatedSettings}package.json`,
    [
      "bun run lint && bun run format:check && bun run typecheck && bun run test && bun run --silent quality:fallow",
      "node_modules/.bin/fallow --format json --quiet --type-aware --type-aware-require complete --fail-on-issues --baseline-mode identity --baseline fallow-dead-code-recorded-hits.json --dupes-baseline fallow-duplicates-recorded-hits.json --health-baseline fallow-health-recorded-hits.json",
      "node_modules/.bin/fallow --format json --quiet --type-aware --type-aware-require complete --save-baseline fallow-dead-code-recorded-hits.json && node_modules/.bin/fallow dupes --format json --quiet --save-baseline fallow-duplicates-recorded-hits.json && node_modules/.bin/fallow health --report-only --format json --quiet --baseline-mode identity --save-baseline fallow-health-recorded-hits.json && biome format --write fallow-dead-code-recorded-hits.json fallow-duplicates-recorded-hits.json fallow-health-recorded-hits.json",
    ],
  ],
  [
    ".github/workflows/ci.yml",
    [
      `bun run --silent quality:fallow --base ${ciBaseRef}`,
      'bun run --silent quality:fallow --base "${{ github.event.before }}"',
    ],
  ],
  [".github/workflows/macos-nightly.yml", ["bun run check"]],
  [
    "generated-repository/hosted-check/ci.yml",
    [
      "bun run check",
      'if [ -z "${BASE:-}" ] || ! git cat-file -e "${BASE}^{commit}" 2>/dev/null; then\n  echo "Skipping Fallow recorded-hits growth check: no base commit ${BASE:-} in this checkout."\n  exit 0\nfi\nbun run --silent quality:fallow -- --fail-on-baseline-growth --baseline-base "$BASE"\n',
    ],
  ],
]);
function* walk(value: unknown, key = ""): Generator<[string, unknown]> {
  yield [key, value];
  if (typeof value === "object" && value !== null)
    for (const [inner, child] of Object.entries(value))
      if (key !== "rules") yield* walk(child, inner);
}

const generatedGuarded = new Set(
  (fallowRuns.get(`${generatedSettings}package.json`)?.[1] ?? "")
    .split(" ")
    .filter((word) => word.endsWith(".json"))
    .map((name) => `${generatedSettings}${name}`),
);

function fallowRunProblems(paths: readonly string[], root: string): string[] {
  const scripts = paths
    .filter((path) => basename(path) === "package.json")
    .map((path): [string, [string, unknown][]] => [
      path,
      Object.entries(
        (JSON.parse(readText(root, path)) as { scripts?: object }).scripts ??
          {},
      ),
    ]);
  const reachers = new Set(["fallow"]);
  const reaches = (text: unknown) =>
    typeof text === "string" &&
    [...reachers].some((name) =>
      new RegExp(`(?<![\\w:.-])${name}(?![\\w:.-])`).test(text),
    );
  for (let size = 0; size !== reachers.size; ) {
    size = reachers.size;
    for (const [, entries] of scripts)
      for (const [name, text] of entries) if (reaches(text)) reachers.add(name);
  }
  const runs: [string, unknown][] = [
    ...scripts.flatMap(([path, entries]) =>
      entries.map(([, text]): [string, unknown] => [path, text]),
    ),
    ...paths
      .filter((path) => /\.ya?ml$/.test(path))
      .flatMap((path) =>
        [...walk(Bun.YAML.parse(readText(root, path)))].flatMap(
          ([key, value]): [string, unknown][] =>
            key === "run" || key === "FALLOW_CONFIG"
              ? [[path, value ?? key]]
              : [],
        ),
      ),
  ];
  return [
    ...runs.flatMap(([path, text]) =>
      reaches(text) ||
      /\bFALLOW_CONFIG\b|--suppressions-location/.test(String(text))
        ? (fallowRuns.get(path) ?? []).includes(String(text))
          ? []
          : [path]
        : [],
    ),
    ...paths.filter(
      (path) =>
        !/\.md$|^tests\/planted-faults\//.test(path) &&
        path !== "tests/template/names-check/recorded-lists.test.ts" &&
        /\bFALLOW_CONFIG\b/.test(readText(root, path)),
    ),
  ];
}

function configProblems(paths: readonly string[], root: string): string[] {
  return [".fallowrc.json", `${generatedSettings}.fallowrc.json`].filter(
    (config) => {
      const folder = config.slice(0, -".fallowrc.json".length);
      return [...walk(JSON.parse(readText(root, config)))].some(
        ([key, value]) =>
          key === "extends" ||
          (/baseline|suppress/i.test(key) &&
            !(
              typeof value === "string" &&
              paths.includes(`${folder}${value}`) &&
              (folder === ""
                ? recordedListFiles.includes(value)
                : generatedGuarded.has(`${folder}${value}`))
            )),
      );
    },
  );
}

function listsIn(paths: readonly string[], settings: string) {
  return new Set([
    ...paths.filter((path) => listName.test(path)),
    `${settings}eslint-suppressions.json`,
  ]);
}

function unguardedLists(paths: readonly string[], root: string): string[] {
  const generated = listsIn(
    paths.filter((path) => path.startsWith("generated-repository/")),
    generatedSettings,
  );
  const template = listsIn(
    paths.filter((path) => !path.startsWith("generated-repository/")),
    "",
  );
  const guarded = new Set(recordedListFiles);
  const fallowConfigs = new Set([
    ".fallowrc.json",
    `${generatedSettings}.fallowrc.json`,
  ]);
  return [
    ...new Set([
      ...fallowRunProblems(paths, root),
      ...configProblems(paths, root),
      ...paths.filter(
        (path) =>
          /(?:^|\/)(?:\.fallowrc\.jsonc?|\.?fallow\.toml)$/.test(path) &&
          !fallowConfigs.has(path),
      ),
      ...[...template].filter((path) => !guarded.has(path)),
      ...[...generated].filter(
        (path) =>
          !(generatedGuarded.has(path) && paths.includes(path)) &&
          (paths.includes(path) ||
            basename(path) !== "eslint-suppressions.json"),
      ),
    ]),
  ].sort();
}

function trackedPaths(): string[] {
  return gitInNamesCheck(templateRoot, ["ls-files", "-z"])
    .stdout.toString()
    .split("\0")
    .filter((path) => path !== "");
}

test("every recorded list in this repository and in a generated repository has a shrink-only guard", () => {
  const tracked = trackedPaths();
  expect(unguardedLists(tracked, templateRoot)).toEqual([]);
  expect(
    unguardedLists(
      [
        ...tracked,
        "tests/template/lint/lint-recorded-hits.json",
        "generated-repository/settings/eslint-suppressions.json",
        ".fallowrc.jsonc",
        "generated-repository/settings/fallow.toml",
      ],
      templateRoot,
    ),
  ).toEqual([
    ".fallowrc.jsonc",
    "generated-repository/settings/eslint-suppressions.json",
    "generated-repository/settings/fallow.toml",
    "tests/template/lint/lint-recorded-hits.json",
  ]);
});

const ciBase = 'quality:fallow --base "origin/${{ github.base_ref }}"';
const growth = '--baseline-base "$BASE"';
const auditScript = "--baseline-mode identity --format json --quiet";
const dodgedRuns: readonly (readonly [string, string, string])[] = [
  [
    ".github/workflows/ci.yml",
    ciBase,
    `${ciBase} --health-baseline extra-exemptions.json`,
  ],
  [".github/workflows/ci.yml", ciBase, `${ciBase} --config extra-fallow.json`],
  [
    "generated-repository/hosted-check/ci.yml",
    growth,
    `${growth} --health-baseline extra-exemptions.json`,
  ],
  ["package.json", auditScript, `${auditScript} -cextra-fallow.json`],
  [
    "package.json",
    auditScript,
    `${auditScript} --health-baseline extra-exemptions.txt`,
  ],
  [
    "package.json",
    "eslint . --max-warnings 0",
    "eslint . --max-warnings 0 --suppressions-location extra.json",
  ],
  [".fallowrc.json", "", '{"audit":{"healthBaseline":"custom.json"}}'],
  [
    ".fallowrc.json",
    '"audit": {',
    '"health": { "baseline": "extra.json" }, "audit": {',
  ],
];

test("a Fallow run or config that names a list another way is refused", () => {
  const tracked = trackedPaths();
  const refused = dodgedRuns.map(([path, from, to]) => {
    const text = readFileSync(join(templateRoot, path), "utf8");
    overlay = new Map([[path, from === "" ? to : text.replace(from, to)]]);
    return text.includes(from) ? unguardedLists(tracked, templateRoot) : [];
  });
  overlay = new Map();
  expect(refused).toEqual(dodgedRuns.map(([path]) => [path]));
});
