import { expect, test } from "bun:test";
import { commitIn, git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  createFixture,
  nestSource,
  routeSource,
  runHostedGrowthStep,
  runScriptDirect,
  withFallowSettings,
  withHealthApproval,
} from "../../support/recorded-health-sizes-fixture.ts";

type Changes = Record<string, string | null>;

const ROUTE = "src/commands.ts function route";

function withHealth(health: Readonly<Record<string, unknown>>): string {
  return withFallowSettings((shipped) => ({
    ...shipped,
    health: { ...shipped.health, ...health },
  }));
}

function expectRefusal(
  result: { readonly exit: number; readonly stderr: string },
  ...tokens: readonly string[]
): void {
  expect(result.exit).toBe(1);
  for (const token of tokens) expect(result.stderr).toContain(token);
  expect(result.stderr).toContain("Repair:");
}

function lowComplexityFunction(name: string, totalLines: number): string {
  const steps = Array.from(
    { length: totalLines - 3 },
    (_, index) => `  const openLine${index} = value + ${index * 3};`,
  ).join("\n");
  const last = totalLines > 3 ? `openLine${totalLines - 4}` : "value";
  return `export function ${name}(value: number): number {\n${steps}\n  return ${last};\n}\n`;
}

function uniqueFileSource(prefix: string, lineCount: number): string {
  const body = Array.from(
    { length: lineCount - 1 },
    (_, index) => `const ${prefix}${index} = ${index * 7 + 1};`,
  ).join("\n");
  return `${body}\nexport const ${prefix}Total = ${prefix}0;\n`;
}

function addRecordedIdentity(
  healthJson: string,
  identity: string,
  approved?: string,
): string {
  const parsed = JSON.parse(healthJson) as {
    identity_finding_counts: Record<
      string,
      Record<string, { count: number; approved?: string }>
    >;
  };
  parsed.identity_finding_counts[identity] = {
    complexity_moderate:
      approved === undefined ? { count: 1 } : { count: 1, approved },
  };
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

test(
  "refuses growth in a recorded function or file below base thresholds even when the same diff raises maxCyclomatic or maxFileLines, and passes no growth, approval, and true deletion",
  async () => {
    const { repo, recordedHits } = await createFixture();
    const baseHealth = addRecordedIdentity(
      addRecordedIdentity(
        recordedHits["fallow-health-recorded-hits.json"] ?? "",
        "src/open.ts\u0000run",
      ),
      "src/medium.ts\u0000<file>",
    );
    const { sha: baseSha } = commitIn(
      repo,
      "add low-complexity recorded function and sub-threshold recorded file",
      {
        "src/open.ts": lowComplexityFunction("run", 187),
        "src/medium.ts": uniqueFileSource("medium", 480),
        "src/cli.ts":
          'import { nest, route } from "./commands.ts";\nimport { total } from "./long.ts";\nimport { mediumTotal } from "./medium.ts";\nimport { run } from "./open.ts";\nexport function main(): number {\n  return route(1) + nest(1) + total + mediumTotal + run(1);\n}\nmain();\n',
        "tests/cli.test.ts":
          'import { expect, test } from "bun:test";\nimport { nest, route } from "../src/commands.ts";\nimport { total } from "../src/long.ts";\nimport { mediumTotal } from "../src/medium.ts";\nimport { run } from "../src/open.ts";\ntest("uses modules", () => {\n  expect(route(1) + nest(1) + total + mediumTotal + run(1)).toBeGreaterThanOrEqual(0);\n});\n',
        "fallow-health-recorded-hits.json": baseHealth,
      },
    );

    const runCase = (subject: string, changes: Changes) => {
      git(repo, "checkout", "--quiet", "--detach", baseSha);
      commitIn(repo, subject, changes);
      return runHostedGrowthStep(repo, baseSha);
    };

    expect((await runCase("no growth", {})).exit).toBe(0);

    expectRefusal(
      await runCase(
        "grow recorded 187-line function to 190 lines while raising maxCyclomatic to 5000",
        {
          "src/open.ts": lowComplexityFunction("run", 190),
          ".fallowrc.json": withHealth({ maxCyclomatic: 5000 }),
        },
      ),
      "src/open.ts function run",
      "function lines 187 to 190",
    );

    expectRefusal(
      await runCase(
        "grow recorded sub-threshold file while raising maxFileLines to 1000",
        {
          "src/medium.ts": uniqueFileSource("medium", 490),
          ".fallowrc.json": withHealth({ maxFileLines: 1000 }),
        },
      ),
      "src/medium.ts (<file>)",
      "file lines 480 to 490",
    );

    const approved = await runCase("grow recorded function with new approval", {
      "src/open.ts": lowComplexityFunction("run", 190),
      ".fallowrc.json": withHealth({ maxCyclomatic: 5000 }),
      "fallow-health-recorded-hits.json": addRecordedIdentity(
        baseHealth,
        "src/open.ts\u0000run",
        "PR #42: temporary growth",
      ),
    });
    expect(approved.exit).toBe(0);

    const deleted = await runCase("truly delete recorded function", {
      "src/open.ts": "export const openReady = 1;\n",
      "src/cli.ts":
        'import { nest, route } from "./commands.ts";\nimport { total } from "./long.ts";\nimport { mediumTotal } from "./medium.ts";\nimport { openReady } from "./open.ts";\nexport function main(): number {\n  return route(1) + nest(1) + total + mediumTotal + openReady;\n}\nmain();\n',
      "tests/cli.test.ts":
        'import { expect, test } from "bun:test";\nimport { nest, route } from "../src/commands.ts";\nimport { total } from "../src/long.ts";\nimport { mediumTotal } from "../src/medium.ts";\nimport { openReady } from "../src/open.ts";\ntest("uses modules", () => {\n  expect(route(1) + nest(1) + total + mediumTotal + openReady).toBeGreaterThanOrEqual(0);\n});\n',
      "fallow-health-recorded-hits.json":
        recordedHits["fallow-health-recorded-hits.json"] ?? "",
    });
    expect(deleted.exit).toBe(0);
  },
  processWatchdog(10),
);

test(
  "refuses growth in a recorded function when its file is renamed in the same change, and refuses a deleted recorded function replaced by a larger same-named function in another file",
  async () => {
    const { repo, baseSha, recordedHits } = await createFixture();
    const runCase = (subject: string, changes: Changes) => {
      git(repo, "checkout", "--quiet", "--detach", baseSha);
      commitIn(repo, subject, changes);
      return runScriptDirect(repo, ["--base", baseSha]);
    };

    expectRefusal(
      await runCase("rename file and grow recorded function by 3 lines", {
        "src/commands.ts": null,
        "src/router.ts": `${routeSource(20, 4)}\n${nestSource(false)}`,
        "src/cli.ts":
          'import { nest, route } from "./router.ts";\nimport { total } from "./long.ts";\nexport function main(): number {\n  return route(1) + nest(1) + total;\n}\nmain();\n',
        "tests/cli.test.ts":
          'import { expect, test } from "bun:test";\nimport { nest, route } from "../src/router.ts";\nimport { total } from "../src/long.ts";\ntest("uses modules", () => {\n  expect(route(1) + nest(1) + total).toBeGreaterThanOrEqual(0);\n});\n',
      }),
      ROUTE,
      "(renamed to src/router.ts)",
      "function lines 26 to 29",
    );

    const renamedUnchanged = await runCase("rename file without growth", {
      "src/commands.ts": null,
      "src/router.ts": `${routeSource(20, 1)}\n${nestSource(false)}`,
    });
    expect(renamedUnchanged).toMatchObject({ exit: 0, stderr: "" });

    const renamedApproved = await runCase(
      "rename file and grow with a new approved field",
      {
        "src/commands.ts": null,
        "src/router.ts": `${routeSource(20, 4)}\n${nestSource(false)}`,
        "fallow-health-recorded-hits.json": withHealthApproval(
          recordedHits["fallow-health-recorded-hits.json"] ?? "",
          { routeApproved: "PR #43: moved and grew" },
        ),
      },
    );
    expect(renamedApproved).toMatchObject({ exit: 0, stderr: "" });

    expectRefusal(
      await runCase(
        "delete recorded function and add a larger same-named function in another file",
        {
          "src/commands.ts": nestSource(false),
          "src/other.ts": routeSource(20, 4),
          "src/cli.ts":
            'import { nest } from "./commands.ts";\nimport { total } from "./long.ts";\nimport { route } from "./other.ts";\nexport function main(): number {\n  return route(1) + nest(1) + total;\n}\nmain();\n',
        },
      ),
      ROUTE,
      "src/other.ts",
      "function lines 26 to 29",
    );

    const trulyDeleted = await runCase("truly delete recorded function", {
      "src/commands.ts": nestSource(false),
      "src/cli.ts":
        'import { nest } from "./commands.ts";\nimport { total } from "./long.ts";\nexport function main(): number {\n  return nest(1) + total;\n}\nmain();\n',
    });
    expect(trulyDeleted).toMatchObject({ exit: 0, stderr: "" });
  },
  processWatchdog(10),
);
