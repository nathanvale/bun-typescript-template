import { expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapCliFixture,
  invoke,
  requireSuccess,
  runIn,
} from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const temporaryRoot = bootstrapCliFixture();

interface GateOutcome {
  status: string;
  enforced: boolean;
  observed?: number;
  threshold?: number;
  threshold_label?: string;
}

interface CombinedFallowReport {
  kind: string;
  gate_outcomes: Record<string, GateOutcome>;
  check?: { unused_exports?: Array<{ export_name: string }> };
  dupes?: { clone_groups?: unknown[] };
  health?: { findings?: Array<{ name: string; exceeded: string }> };
}

interface RecordedHitsFile {
  kind?: string;
  identity_finding_counts?: Record<string, unknown>;
}

function parseCombinedFallow(
  stdout: string,
  stderr: string,
): CombinedFallowReport {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(
      `Expected Fallow JSON output, got stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  return JSON.parse(stdout.slice(start)) as CombinedFallowReport;
}

function duplicateModuleSource(name: string): string {
  return `export function ${name}(items: readonly number[], factor: number): number {
  let total = 0;
  let bonus = 0;
  for (const item of items) {
    if (item > 100) {
      total += item * factor + 7;
      bonus += 3;
    } else if (item > 50) {
      total += item * factor + 3;
      bonus += 2;
    } else if (item > 10) {
      total += item * 2 + 1;
      bonus += 1;
    } else if (item > 0) {
      total += item;
    } else {
      total -= item;
      bonus -= 1;
    }
  }
  return total + bonus;
}
`;
}

function complexModuleSource(name: string): string {
  return `export function ${name}(value: number): number {
  if (value === 1) return 1;
  if (value === 2) return 2;
  if (value === 3) return 3;
  if (value === 4) return 4;
  if (value === 5) return 5;
  if (value === 6) return 6;
  if (value === 7) return 7;
  if (value === 8) return 8;
  if (value === 9) return 9;
  if (value === 10) return 10;
  if (value === 11) return 11;
  if (value === 12) return 12;
  if (value === 13) return 13;
  if (value === 14) return 14;
  if (value === 15) return 15;
  if (value === 16) return 16;
  if (value === 17) return 17;
  if (value === 18) return 18;
  if (value === 19) return 19;
  if (value === 20) return 20;
  if (value === 21) return 21;
  return 0;
}
`;
}

function secondComplexModuleSource(name: string): string {
  return `export function ${name}(code: string): string {
  switch (code) {
    case "a":
      return "alpha";
    case "b":
      return "bravo";
    case "c":
      return "charlie";
    case "d":
      return "delta";
    case "e":
      return "echo";
    case "f":
      return "foxtrot";
    case "g":
      return "golf";
    case "h":
      return "hotel";
    case "i":
      return "india";
    case "j":
      return "juliet";
    case "k":
      return "kilo";
    case "l":
      return "lima";
    case "m":
      return "mike";
    case "n":
      return "november";
    case "o":
      return "oscar";
    case "p":
      return "papa";
    case "q":
      return "quebec";
    case "r":
      return "romeo";
    case "s":
      return "sierra";
    case "t":
      return "tango";
    case "u":
      return "uniform";
    default:
      return "other";
  }
}
`;
}

async function assertFallowGates(
  destination: string,
  commandsPath: string,
  original: string,
): Promise<void> {
  await writeFile(commandsPath, original);
  const clean = await runIn(destination, ["run", "check"], {});
  requireSuccess(clean, "clean generated check command");
  const cleanReport = parseCombinedFallow(clean.stdout, clean.stderr);
  expect({
    kind: cleanReport.kind,
    deadCode: cleanReport.gate_outcomes["error-severity-findings"],
    duplication: cleanReport.gate_outcomes["duplication-findings"],
    health: cleanReport.gate_outcomes["health-findings"],
    typeAware: cleanReport.gate_outcomes["type-aware-require"],
  }).toEqual({
    kind: "combined",
    deadCode: {
      status: "pass",
      enforced: true,
      observed: 0,
      threshold_label: "error",
    },
    duplication: { status: "pass", enforced: true, observed: 0, threshold: 0 },
    health: {
      status: "pass",
      enforced: true,
      observed: 0,
      threshold_label: "error",
    },
    typeAware: { status: "pass", enforced: true },
  });

  await writeFile(commandsPath, `${original}\nexport const unusedValue = 1;\n`);
  const unused = await runIn(destination, ["run", "check"], {});
  expect(unused.exitCode).toBe(1);
  const unusedReport = parseCombinedFallow(unused.stdout, unused.stderr);
  expect(unusedReport.gate_outcomes["error-severity-findings"]?.status).toBe(
    "fail",
  );
  expect(
    unusedReport.check?.unused_exports?.map((entry) => entry.export_name),
  ).toContain("unusedValue");

  const firstDup = join(destination, "src/duplicate-first.ts");
  const secondDup = join(destination, "src/duplicate-second.ts");
  try {
    await writeFile(firstDup, duplicateModuleSource("scoreA"));
    await writeFile(secondDup, duplicateModuleSource("scoreB"));
    await writeFile(
      commandsPath,
      `import { scoreA } from "./duplicate-first.ts";\nimport { scoreB } from "./duplicate-second.ts";\n${original.replace("ready: true", "ready: scoreA([1], 2) + scoreB([1], 2) >= 0")}`,
    );
    const duplicate = await runIn(destination, ["run", "check"], {});
    expect(duplicate.exitCode).toBe(1);
    const duplicateReport = parseCombinedFallow(
      duplicate.stdout,
      duplicate.stderr,
    );
    expect({
      deadCode:
        duplicateReport.gate_outcomes["error-severity-findings"]?.status,
      duplication:
        duplicateReport.gate_outcomes["duplication-findings"]?.status,
      health: duplicateReport.gate_outcomes["health-findings"]?.status,
      cloneGroups: (duplicateReport.dupes?.clone_groups ?? []).length > 0,
    }).toEqual({
      deadCode: "pass",
      duplication: "fail",
      health: "pass",
      cloneGroups: true,
    });
  } finally {
    await rm(firstDup, { force: true });
    await rm(secondDup, { force: true });
  }

  const complexPath = join(destination, "src/complex-branching.ts");
  const secondComplexPath = join(
    destination,
    "src/second-complex-branching.ts",
  );
  const recordedHitsPath = join(
    destination,
    "fallow-health-recorded-hits.json",
  );
  const originalRecordedHits = await readFile(recordedHitsPath, "utf8");
  try {
    await rm(recordedHitsPath);
    const missingRecordedHits = await runIn(
      destination,
      ["run", "quality:fallow"],
      {},
    );
    expect(missingRecordedHits.exitCode).toBe(2);
    expect(missingRecordedHits.stdout).toContain(
      "failed to read health baseline",
    );
    await writeFile(recordedHitsPath, originalRecordedHits);

    await writeFile(complexPath, complexModuleSource("decideBranch"));
    await writeFile(
      commandsPath,
      `import { decideBranch } from "./complex-branching.ts";\n${original.replace("ready: true", "ready: decideBranch(1) === 1")}`,
    );
    const complex = await runIn(destination, ["run", "check"], {});
    expect(complex.exitCode).toBe(1);
    const complexReport = parseCombinedFallow(complex.stdout, complex.stderr);
    expect({
      deadCode: complexReport.gate_outcomes["error-severity-findings"]?.status,
      duplication: complexReport.gate_outcomes["duplication-findings"]?.status,
      health: complexReport.gate_outcomes["health-findings"]?.status,
      findings: complexReport.health?.findings?.map((entry) => entry.name),
    }).toEqual({
      deadCode: "pass",
      duplication: "pass",
      health: "fail",
      findings: ["decideBranch"],
    });

    const recorded = await runIn(
      destination,
      ["run", "quality:fallow:record-hits"],
      {},
    );
    requireSuccess(recorded, "record Fallow complexity hits");
    const recordedHits = JSON.parse(
      await readFile(recordedHitsPath, "utf8"),
    ) as RecordedHitsFile;
    expect({
      kind: recordedHits.kind,
      recordedFunctions: Object.keys(
        recordedHits.identity_finding_counts ?? {},
      ),
    }).toEqual({
      kind: "health",
      recordedFunctions: ["src/complex-branching.ts\u0000decideBranch"],
    });

    const withRecorded = await runIn(destination, ["run", "check"], {});
    requireSuccess(withRecorded, "check command with recorded complexity hits");
    const withRecordedReport = parseCombinedFallow(
      withRecorded.stdout,
      withRecorded.stderr,
    );
    expect({
      deadCode:
        withRecordedReport.gate_outcomes["error-severity-findings"]?.status,
      duplication:
        withRecordedReport.gate_outcomes["duplication-findings"]?.status,
      health: withRecordedReport.gate_outcomes["health-findings"]?.status,
    }).toEqual({
      deadCode: "pass",
      duplication: "pass",
      health: "pass",
    });

    await writeFile(
      secondComplexPath,
      secondComplexModuleSource("classifyCode"),
    );
    await writeFile(
      commandsPath,
      `import { decideBranch } from "./complex-branching.ts";\nimport { classifyCode } from "./second-complex-branching.ts";\n${original.replace("ready: true", 'ready: decideBranch(1) === 1 && classifyCode("a") === "alpha"')}`,
    );
    const secondComplex = await runIn(destination, ["run", "check"], {});
    expect(secondComplex.exitCode).toBe(1);
    const secondComplexReport = parseCombinedFallow(
      secondComplex.stdout,
      secondComplex.stderr,
    );
    expect({
      deadCode:
        secondComplexReport.gate_outcomes["error-severity-findings"]?.status,
      duplication:
        secondComplexReport.gate_outcomes["duplication-findings"]?.status,
      health: secondComplexReport.gate_outcomes["health-findings"]?.status,
      findings: secondComplexReport.health?.findings?.map(
        (entry) => entry.name,
      ),
    }).toEqual({
      deadCode: "pass",
      duplication: "pass",
      health: "fail",
      findings: ["classifyCode"],
    });
  } finally {
    await rm(complexPath, { force: true });
    await rm(secondComplexPath, { force: true });
    await writeFile(commandsPath, original);
    await writeFile(recordedHitsPath, originalRecordedHits);
  }
}

test(
  "lint, the template's rules, formatting, native type errors and Fallow gates fail independent read-only checks",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "gates");
    requireSuccess(
      await invoke(
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        "--json",
      ),
      "generate gate specimen",
    );
    requireSuccess(
      await runIn(destination, ["install", "--frozen-lockfile"], {}),
      "install gate specimen",
    );
    requireSuccess(
      await runIn(destination, ["run", "lint"], {}),
      "positive lint control",
    );
    const { scripts } = JSON.parse(
      await readFile(join(destination, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const path = join(destination, "src/commands.ts");
    const original = await readFile(path, "utf8");
    await writeFile(path, `// Platform: Bun drains spawn pipes.\n${original}`);
    requireSuccess(
      await runIn(destination, ["run", "lint"], {}),
      "sanctioned comment marker control",
    );
    const mutations = [
      {
        source: `// Loop over the names.\n${original}`,
        phase: "lint",
        code: 1,
        diagnostic: "repository/no-comments",
      },
      {
        source: original + "\nexport type Opaque = unknown;\n",
        phase: "lint",
        code: 1,
        diagnostic: "anti-slop/no-unknown-type-aliases",
      },
      {
        source: original + "\nexport const unsafe: any = 1;\n",
        phase: "lint",
        code: 1,
        diagnostic: "@typescript-eslint/no-explicit-any",
      },
      {
        source: original + "\n\n",
        phase: "format:check",
        code: 1,
        diagnostic: "Formatter would have printed",
      },
      {
        source: original + "\nexport const wrong: string = 42;\n",
        phase: "typecheck",
        code: 2,
        diagnostic: "TS2322",
      },
    ];
    for (const mutation of mutations) {
      await writeFile(path, mutation.source);
      const result = await runIn(destination, ["run", "check"], {});
      expect(result.exitCode).toBe(mutation.code);
      expect(
        result.stderr.split("\n").findLast((line) => line.startsWith("$ ")),
      ).toBe(`$ ${scripts[mutation.phase]}`);
      expect(result.stdout + result.stderr).toContain(mutation.diagnostic);
      expect(await readFile(path, "utf8")).toBe(mutation.source);
    }
    await assertFallowGates(destination, path, original);
  },
  processWatchdog(10),
);
