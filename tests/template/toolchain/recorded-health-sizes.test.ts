import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitIn, git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  createFixture,
  longFileSource,
  longTestSource,
  nestSource,
  recordHitsIn,
  routeSource,
  runHostedGrowthStep,
  runScriptDirect,
  SHIPPED_SETTINGS_DIR,
  simpleCommandsSource,
  withFallowSettings,
  withHealthApproval,
} from "../../support/recorded-health-sizes-fixture.ts";

type Changes = Record<string, string | null>;

const LONG = "src/long.ts (<file>)";
const ROUTE = "src/commands.ts function route";
const growLong: Changes = { "src/long.ts": longFileSource(520) };
const growRoute: Changes = {
  "src/commands.ts": `${routeSource(21, 0)}\n${nestSource(false)}`,
};
const MARK = "// fallow-ignore-next-line complexity -- hide it\n";
const markRoute: Changes = {
  "src/commands.ts": `${MARK}${routeSource(20, 1)}\n${nestSource(false)}`,
};
const growMarkedRoute: Changes = {
  "src/commands.ts": `${MARK}${growRoute["src/commands.ts"]}`,
};

function withHealth(health: Readonly<Record<string, unknown>>): string {
  return withFallowSettings((shipped) => ({
    ...shipped,
    health: { ...shipped.health, ...health },
  }));
}

const hidingCases: readonly (readonly [string, Changes, string, string])[] = [
  [
    "maxFileLines",
    { ...growLong, ".fallowrc.json": withHealth({ maxFileLines: 1000 }) },
    LONG,
    "file lines 510 to 520",
  ],
  [
    "maxCyclomatic",
    { ...growRoute, ".fallowrc.json": withHealth({ maxCyclomatic: 100 }) },
    ROUTE,
    "cyclomatic complexity 21 to 22",
  ],
  [
    "thresholdOverrides",
    {
      ...growLong,
      ".fallowrc.json": withHealth({
        thresholdOverrides: [
          { files: ["src/long.ts"], maxFileLines: 1000, reason: "hide it" },
        ],
      }),
    },
    LONG,
    "file lines 510 to 520",
  ],
  [
    "health.ignore",
    { ...growLong, ".fallowrc.json": withHealth({ ignore: ["src/long.ts"] }) },
    LONG,
    "file lines 510 to 520",
  ],
  [
    "rule off",
    {
      ...growLong,
      ".fallowrc.json": withFallowSettings((shipped) => ({
        ...shipped,
        rules: { ...shipped.rules, "complexity-file-lines": "off" },
      })),
    },
    LONG,
    "file lines 510 to 520",
  ],
  [
    "ignorePatterns",
    {
      ...growLong,
      ".fallowrc.json": withFallowSettings((shipped) => ({
        ...shipped,
        ignorePatterns: [...shipped.ignorePatterns, "src/long.ts"],
      })),
    },
    LONG,
    "file lines 510 to 520",
  ],
  [
    "production and entry",
    {
      "tests/long.test.ts": longTestSource(520),
      ".fallowrc.json": withFallowSettings((shipped) => ({
        ...shipped,
        production: true,
        entry: [],
      })),
    },
    "tests/long.test.ts (<file>)",
    "file lines 510 to 520",
  ],
  [
    "fallow.toml",
    {
      ...growLong,
      ".fallowrc.json": null,
      "fallow.toml": "[health]\nmaxFileLines = 1000\n",
    },
    LONG,
    "file lines 510 to 520",
  ],
  [
    ".gitignore",
    { ...growLong, ".gitignore": "node_modules\nsrc/long.ts\n" },
    LONG,
    "file lines 510 to 520",
  ],
  [
    ".ignore",
    { ...growLong, ".ignore": "src/long.ts\n" },
    LONG,
    "file lines 510 to 520",
  ],
  [
    "fallow-ignore-file",
    {
      "src/long.ts": `// fallow-ignore-file complexity -- hide it\n${longFileSource(520)}`,
    },
    LONG,
    "file lines 510 to 521",
  ],
  [
    "fallow-ignore-next-line",
    growMarkedRoute,
    ROUTE,
    "cyclomatic complexity 21 to 22",
  ],
  [
    "fallow-ignore-next-line in a file .gitattributes marks binary",
    { ...growMarkedRoute, ".gitattributes": "src/commands.ts -diff\n" },
    ROUTE,
    "cyclomatic complexity 21 to 22",
  ],
  [
    "block comment fallow-ignore-next-line",
    {
      "src/commands.ts": `/* fallow-ignore-next-line complexity -- hide it */\n${growRoute["src/commands.ts"]}`,
    },
    ROUTE,
    "cyclomatic complexity 21 to 22",
  ],
  [
    "base ignorePatterns containing fallow-ignore",
    { ".fallow-ignore/long.ts": longFileSource(520) },
    ".fallow-ignore/long.ts (<file>)",
    "file lines 510 to 520",
  ],
  [
    "fallow-ignore-next-line after a JSX apostrophe",
    {
      "src/view.tsx": `export const el = () => <div>Don't</div>; // fallow-ignore-next-line complexity\n${routeSource(21, 0)}`,
    },
    "src/view.tsx function route",
    "cyclomatic complexity 21 to 22",
  ],
];

function expectRefusal(
  result: { readonly exit: number; readonly stderr: string },
  ...tokens: readonly string[]
): void {
  expect(result.exit).toBe(1);
  for (const token of tokens) expect(result.stderr).toContain(token);
  expect(result.stderr).toContain("Repair:");
}

test(
  "refuses function line growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow function lines", {
      "src/commands.ts": `${routeSource(20, 4)}\n${nestSource(false)}`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("route");
    expect(result.stderr).toContain("function lines 26 to 29");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses cyclomatic complexity growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow cyclomatic complexity without growing lines", {
      "src/commands.ts": `${routeSource(21, 0)}\n${nestSource(false)}`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("route");
    expect(result.stderr).toContain("cyclomatic complexity 21 to 22");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses cognitive complexity growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow cognitive complexity without growing lines", {
      "src/commands.ts": `${routeSource(20, 1)}\n${nestSource(true)}`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("nest");
    expect(result.stderr).toContain("cognitive complexity 16 to 20");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses file line growth in a recorded health finding",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow file lines", {
      "src/long.ts": longFileSource(520),
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/long.ts");
    expect(result.stderr).toContain("<file>");
    expect(result.stderr).toContain("file lines 510 to 520");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses recorded file line growth when the same diff raises maxFileLines, through the hosted step",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "grow file lines and raise maxFileLines", {
      ...growLong,
      ".fallowrc.json": withHealth({ maxFileLines: 1000 }),
    });

    expectRefusal(
      await runHostedGrowthStep(repo, baseSha),
      LONG,
      "file lines 510 to 520",
    );
  },
  processWatchdog(3),
);

test(
  "refuses recorded growth that a same-diff change to Fallow settings, an ignore file or an inline marker would hide, and passes the controls",
  async () => {
    const { repo } = await createFixture();
    commitIn(
      repo,
      "add a long test file, a .tsx view and a .fallow-ignore file",
      {
        "tests/long.test.ts": longTestSource(510),
        "src/view.tsx": routeSource(20, 1),
        ".fallow-ignore/long.ts": longFileSource(510),
        ".fallowrc.json": withFallowSettings((shipped) => ({
          ...shipped,
          ignorePatterns: [...shipped.ignorePatterns, "!.fallow-ignore/**"],
          boundaries: {
            ...shipped.boundaries,
            coverage: {
              ...shipped.boundaries.coverage,
              allowUnmatched: [
                ...shipped.boundaries.coverage.allowUnmatched,
                ".fallow-ignore/**",
              ],
            },
          },
        })),
      },
    );
    const { sha: baseSha } = commitIn(
      repo,
      "record the long test file and .fallow-ignore file",
      await recordHitsIn(repo),
    );
    // Platform: Fallow reads .gitignore only inside a git repository, so the
    // measured trees go inside this one.
    const inGit = { TMPDIR: join(repo, ".git") };
    const runCase = (subject: string, changes: Changes) => {
      git(repo, "checkout", "--quiet", "--detach", baseSha);
      commitIn(repo, subject, changes);
      return runScriptDirect(repo, ["--base", baseSha], inGit);
    };

    expectRefusal(
      await runCase("control: growth alone", growLong),
      LONG,
      "file lines 510 to 520",
    );
    const shrink = await runCase("control: shrink alone", {
      "src/long.ts": longFileSource(490),
    });
    expect(shrink).toMatchObject({ exit: 0, stderr: "" });
    const settingsAlone = await runCase("control: settings alone", {
      ...markRoute,
      ".fallowrc.json": withFallowSettings((shipped) => ({
        ...shipped,
        production: true,
        entry: [],
        ignorePatterns: [...shipped.ignorePatterns, "src/long.ts"],
        health: {
          maxFileLines: 1000,
          maxCyclomatic: 100,
          ignore: ["src/long.ts"],
        },
        rules: { ...shipped.rules, "complexity-file-lines": "off" },
      })),
      ".gitignore": "node_modules\nsrc/long.ts\n",
      ".ignore": "src/long.ts\n",
    });
    expect(settingsAlone).toMatchObject({ exit: 0, stderr: "" });

    const outcomes: { subject: string; exit: number; refusal: boolean }[] = [];
    for (const [subject, changes, finding, growth] of hidingCases) {
      const { exit, stderr } = await runCase(subject, changes);
      const refusal = [`${finding} grew`, growth, "Repair:"].every((token) =>
        stderr.includes(token),
      );
      outcomes.push({ subject, exit, refusal });
    }
    expect(outcomes).toEqual(
      hidingCases.map(([subject]) => ({ subject, exit: 1, refusal: true })),
    );
  },
  processWatchdog(20),
);

test(
  "refuses recorded growth when the base has no Fallow settings file and the head adds one",
  async () => {
    const { repo } = await createFixture();
    commitIn(repo, "drop the settings file", { ".fallowrc.json": null });
    const { sha: baseSha } = commitIn(
      repo,
      "record hits without a settings file",
      await recordHitsIn(repo),
    );
    commitIn(repo, "grow route and add a settings file", {
      ...growRoute,
      ".fallowrc.json": `${JSON.stringify({
        health: { maxCyclomatic: 100 },
        rules: { "complexity-crap": "off" },
      })}\n`,
    });

    expectRefusal(
      await runScriptDirect(repo, ["--base", baseSha]),
      ROUTE,
      "cyclomatic complexity 21 to 22",
    );
  },
  processWatchdog(3),
);

test(
  "refuses a higher suppression count in eslint-suppressions.json",
  async () => {
    const { repo, baseSha } = await createFixture({
      eslintSuppressions: `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 1 } } },
        null,
        2,
      )}\n`,
    });
    commitIn(repo, "raise eslint suppression count", {
      "eslint-suppressions.json": `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 2 } } },
        null,
        2,
      )}\n`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("eslint-suppressions.json");
    expect(result.stderr).toContain("src/commands.ts");
    expect(result.stderr).toContain("no-console");
    expect(result.stderr).toContain("from 1");
    expect(result.stderr).toContain("to 2");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses a new file and rule pair in eslint-suppressions.json",
  async () => {
    const { repo, baseSha } = await createFixture();
    commitIn(repo, "add new eslint suppression pair", {
      "eslint-suppressions.json": `${JSON.stringify(
        { "src/long.ts": { "no-console": { count: 1 } } },
        null,
        2,
      )}\n`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("eslint-suppressions.json");
    expect(result.stderr).toContain("src/long.ts");
    expect(result.stderr).toContain("no-console");
    expect(result.stderr).toContain("from 0");
    expect(result.stderr).toContain("to 1");
    expect(result.stderr).toContain("Repair:");
  },
  processWatchdog(3),
);

test(
  "refuses growth when the base revision already holds the same approved value, even with spaces around it",
  async () => {
    const { repo, baseSha, recordedHits } = await createFixture({
      healthApprovals: { longApproved: "PR #10" },
      eslintSuppressions: `${JSON.stringify(
        {
          "src/commands.ts": {
            "no-console": { count: 1, approved: "PR #10" },
          },
        },
        null,
        2,
      )}\n`,
    });
    commitIn(repo, "grow with stale approval", {
      "src/long.ts": longFileSource(515),
      "fallow-health-recorded-hits.json": withHealthApproval(
        recordedHits["fallow-health-recorded-hits.json"] ?? "",
        { longApproved: " PR #10 " },
      ),
      "eslint-suppressions.json": `${JSON.stringify(
        {
          "src/commands.ts": {
            "no-console": { count: 2, approved: " PR #10 " },
          },
        },
        null,
        2,
      )}\n`,
    });

    const result = await runHostedGrowthStep(repo, baseSha);
    expect(result.exit).toBe(1);
    expect(result.stderr).toContain("src/long.ts");
    expect(result.stderr).toContain("file lines 510 to 515");
    expect(result.stderr).toContain("eslint-suppressions.json");
    expect(result.stderr).toContain("src/commands.ts");
  },
  processWatchdog(3),
);

test(
  "passes for unchanged sizes, shrinks, removed findings, and growth with a new approved field",
  async () => {
    const { repo, baseSha, recordedHits } = await createFixture({
      eslintSuppressions: `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 2 } } },
        null,
        2,
      )}\n`,
    });

    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);

    commitIn(repo, "shrink recorded file and suppression", {
      "src/long.ts": longFileSource(505),
      "eslint-suppressions.json": `${JSON.stringify(
        { "src/commands.ts": { "no-console": { count: 1 } } },
        null,
        2,
      )}\n`,
    });
    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);

    commitIn(repo, "grow with new approvals", {
      "src/commands.ts": `${routeSource(21, 4)}\n${nestSource(true)}`,
      "src/long.ts": longFileSource(520),
      "fallow-health-recorded-hits.json": withHealthApproval(
        recordedHits["fallow-health-recorded-hits.json"] ?? "",
        {
          routeApproved: "PR #20: temporary growth",
          nestApproved: "PR #20: temporary growth",
          longApproved: "PR #20: temporary growth",
        },
      ),
      "eslint-suppressions.json": `${JSON.stringify(
        {
          "src/commands.ts": {
            "no-console": { count: 3, approved: "PR #20: temporary growth" },
          },
          "src/long.ts": {
            "no-console": { count: 1, approved: "PR #20: temporary growth" },
          },
        },
        null,
        2,
      )}\n`,
    });
    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);

    commitIn(repo, "remove findings completely", {
      "src/commands.ts": simpleCommandsSource(),
      "src/long.ts": "export const total = 0;\n",
      "fallow-health-recorded-hits.json": readFileSync(
        join(SHIPPED_SETTINGS_DIR, "fallow-health-recorded-hits.json"),
        "utf8",
      ),
      "eslint-suppressions.json": "{}\n",
    });
    expect((await runHostedGrowthStep(repo, baseSha)).exit).toBe(0);
  },
  processWatchdog(5),
);

test(
  "fails closed with exit 2 on an unreadable base file, naming the file and git reason",
  async () => {
    const { repo, baseSha } = await createFixture();
    const blob = git(
      repo,
      "rev-parse",
      `${baseSha}:fallow-health-recorded-hits.json`,
    );
    rmSync(join(repo, ".git/objects", blob.slice(0, 2), blob.slice(2)));

    const result = await runScriptDirect(repo, ["--base", baseSha]);
    expect(result.exit).toBe(2);
    expect(result.stderr).toContain("fallow-health-recorded-hits.json");
    expect(result.stderr).toContain("git cannot read");
  },
  processWatchdog(2),
);

test(
  "fails closed with exit 2 on malformed recorded lists",
  async () => {
    const { repo, baseSha } = await createFixture({
      eslintSuppressions: "{}\n",
    });
    commitIn(repo, "malformed eslint suppressions", {
      "eslint-suppressions.json": JSON.stringify({
        "src/commands.ts": { "no-console": { count: -1 } },
      }),
    });

    const badCount = await runScriptDirect(repo, ["--base", baseSha]);
    expect(badCount.exit).toBe(2);
    expect(badCount.stderr).toContain("eslint-suppressions.json");
    expect(badCount.stderr).toContain("is not");

    commitIn(
      repo,
      "non-identity health baseline without identity_finding_counts",
      {
        "eslint-suppressions.json": "{}\n",
        "fallow-health-recorded-hits.json": JSON.stringify({
          kind: "health",
          finding_counts: {
            "src/long.ts": { complexity_moderate: { count: 1 } },
          },
          runtime_coverage_findings: [],
          target_keys: [],
        }),
      },
    );

    const nonIdentity = await runScriptDirect(repo, ["--base", baseSha]);
    expect(nonIdentity.exit).toBe(2);
    expect(nonIdentity.stderr).toContain("fallow-health-recorded-hits.json");
    expect(nonIdentity.stderr).toContain("is not");
  },
  processWatchdog(2),
);
