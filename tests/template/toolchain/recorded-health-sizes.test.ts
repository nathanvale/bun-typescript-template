import { expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { commitIn, git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  createFixture,
  longFileSource,
  nestSource,
  routeSource,
  runHostedGrowthStep,
  runScriptDirect,
  SHIPPED_SETTINGS_DIR,
  simpleCommandsSource,
  withHealthApproval,
} from "../../support/recorded-health-sizes-fixture.ts";

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
