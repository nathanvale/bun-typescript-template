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
  dupes?: {
    clone_groups?: Array<{ instances?: Array<{ file: string }> }>;
  };
  health?: { findings?: Array<{ name: string; exceeded: string }> };
}

interface DeadCodeRecordedHitsFile {
  kind?: string;
  unused_exports?: string[];
}

interface DuplicatesRecordedHitsFile {
  kind?: string;
  clone_groups?: string[];
  clone_fingerprints?: string[];
}

interface HealthRecordedHitsFile {
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

function secondDuplicateModuleSource(name: string): string {
  return `export function ${name}(values: readonly string[], limit: number): number {
  let hits = 0;
  let weight = 1;
  for (const value of values) {
    if (value.length > limit) {
      hits += 4;
      weight += 2;
    } else if (value.length > 8) {
      hits += 3;
      weight += 1;
    } else if (value.length > 4) {
      hits += 2;
    } else if (value.length > 1) {
      hits += 1;
    } else {
      hits -= 1;
      weight -= 1;
    }
  }
  return hits * weight;
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

function gateStatuses(report: CombinedFallowReport) {
  return {
    deadCode: report.gate_outcomes["error-severity-findings"]?.status,
    duplication: report.gate_outcomes["duplication-findings"]?.status,
    health: report.gate_outcomes["health-findings"]?.status,
  };
}

async function assertMissingRecordedHits(
  destination: string,
  cases: readonly { path: string; expectedMessage: string }[],
  restoreRecordedHits: () => Promise<void>,
): Promise<void> {
  try {
    for (const entry of cases) {
      await rm(entry.path);
      const missing = await runIn(destination, ["run", "quality:fallow"], {});
      expect(missing.exitCode).toBe(2);
      expect(missing.stdout).toContain(entry.expectedMessage);
      await restoreRecordedHits();
    }
  } finally {
    await restoreRecordedHits();
  }
}

async function assertDeadCodeRecording(
  destination: string,
  commandsPath: string,
  original: string,
  deadCodeHitsPath: string,
  restoreRecordedHits: () => Promise<void>,
): Promise<void> {
  try {
    await writeFile(
      commandsPath,
      `${original}\nexport const unusedValue = 1;\n`,
    );
    const unused = await runIn(destination, ["run", "check"], {});
    expect(unused.exitCode).toBe(1);
    const unusedReport = parseCombinedFallow(unused.stdout, unused.stderr);
    expect(unusedReport.gate_outcomes["error-severity-findings"]?.status).toBe(
      "fail",
    );
    expect(
      unusedReport.check?.unused_exports?.map((entry) => entry.export_name),
    ).toContain("unusedValue");

    const recorded = await runIn(
      destination,
      ["run", "quality:fallow:record-hits"],
      {},
    );
    requireSuccess(recorded, "record Fallow dead-code hits");
    const recordedHits = JSON.parse(
      await readFile(deadCodeHitsPath, "utf8"),
    ) as DeadCodeRecordedHitsFile;
    expect({
      kind: recordedHits.kind,
      unusedExports: recordedHits.unused_exports,
    }).toEqual({
      kind: "dead-code",
      unusedExports: ["unused-export:src/commands.ts:unusedValue"],
    });

    const withRecorded = await runIn(destination, ["run", "check"], {});
    requireSuccess(withRecorded, "check command with recorded dead-code hits");
    expect(
      gateStatuses(
        parseCombinedFallow(withRecorded.stdout, withRecorded.stderr),
      ),
    ).toEqual({
      deadCode: "pass",
      duplication: "pass",
      health: "pass",
    });

    await writeFile(
      commandsPath,
      `${original}\nexport const unusedValue = 1;\nexport const secondUnusedValue = 2;\n`,
    );
    const secondUnused = await runIn(destination, ["run", "check"], {});
    expect(secondUnused.exitCode).toBe(1);
    const secondUnusedReport = parseCombinedFallow(
      secondUnused.stdout,
      secondUnused.stderr,
    );
    expect({
      ...gateStatuses(secondUnusedReport),
      unusedExports: secondUnusedReport.check?.unused_exports?.map(
        (entry) => entry.export_name,
      ),
    }).toEqual({
      deadCode: "fail",
      duplication: "pass",
      health: "pass",
      unusedExports: ["secondUnusedValue"],
    });
  } finally {
    await writeFile(commandsPath, original);
    await restoreRecordedHits();
  }
}

async function assertDuplicatesRecording(
  destination: string,
  commandsPath: string,
  original: string,
  duplicatesHitsPath: string,
  restoreRecordedHits: () => Promise<void>,
): Promise<void> {
  const firstDup = join(destination, "src/duplicate-first.ts");
  const secondDup = join(destination, "src/duplicate-second.ts");
  const thirdDup = join(destination, "src/duplicate-third.ts");
  const fourthDup = join(destination, "src/duplicate-fourth.ts");
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
      ...gateStatuses(duplicateReport),
      cloneGroups: (duplicateReport.dupes?.clone_groups ?? []).length > 0,
    }).toEqual({
      deadCode: "pass",
      duplication: "fail",
      health: "pass",
      cloneGroups: true,
    });

    const recorded = await runIn(
      destination,
      ["run", "quality:fallow:record-hits"],
      {},
    );
    requireSuccess(recorded, "record Fallow duplication hits");
    const recordedHits = JSON.parse(
      await readFile(duplicatesHitsPath, "utf8"),
    ) as DuplicatesRecordedHitsFile;
    expect({
      kind: recordedHits.kind,
      cloneGroupCount: (recordedHits.clone_groups ?? []).length,
      fingerprintCount: (recordedHits.clone_fingerprints ?? []).length,
    }).toEqual({
      kind: "dupes",
      cloneGroupCount: 1,
      fingerprintCount: 1,
    });

    const withRecorded = await runIn(destination, ["run", "check"], {});
    requireSuccess(
      withRecorded,
      "check command with recorded duplication hits",
    );
    expect(
      gateStatuses(
        parseCombinedFallow(withRecorded.stdout, withRecorded.stderr),
      ),
    ).toEqual({
      deadCode: "pass",
      duplication: "pass",
      health: "pass",
    });

    await writeFile(thirdDup, secondDuplicateModuleSource("tallyA"));
    await writeFile(fourthDup, secondDuplicateModuleSource("tallyB"));
    await writeFile(
      commandsPath,
      `import { scoreA } from "./duplicate-first.ts";\nimport { scoreB } from "./duplicate-second.ts";\nimport { tallyA } from "./duplicate-third.ts";\nimport { tallyB } from "./duplicate-fourth.ts";\n${original.replace("        data: { ready: true },", '        data: {\n          ready:\n            scoreA([1], 2) + scoreB([1], 2) >= 0 &&\n            tallyA(["a"], 1) + tallyB(["b"], 1) >= 0,\n        },')}`,
    );
    const secondDuplicate = await runIn(destination, ["run", "check"], {});
    expect(secondDuplicate.exitCode).toBe(1);
    const secondDuplicateReport = parseCombinedFallow(
      secondDuplicate.stdout,
      secondDuplicate.stderr,
    );
    expect({
      ...gateStatuses(secondDuplicateReport),
      cloneFiles: (secondDuplicateReport.dupes?.clone_groups ?? [])
        .flatMap((group) =>
          (group.instances ?? []).map((instance) => instance.file),
        )
        .toSorted(),
    }).toEqual({
      deadCode: "pass",
      duplication: "fail",
      health: "pass",
      cloneFiles: ["src/duplicate-fourth.ts", "src/duplicate-third.ts"],
    });
  } finally {
    await rm(firstDup, { force: true });
    await rm(secondDup, { force: true });
    await rm(thirdDup, { force: true });
    await rm(fourthDup, { force: true });
    await writeFile(commandsPath, original);
    await restoreRecordedHits();
  }
}

async function assertComplexityRecording(
  destination: string,
  commandsPath: string,
  original: string,
  healthHitsPath: string,
  restoreRecordedHits: () => Promise<void>,
): Promise<void> {
  const complexPath = join(destination, "src/complex-branching.ts");
  const secondComplexPath = join(
    destination,
    "src/second-complex-branching.ts",
  );
  try {
    await writeFile(complexPath, complexModuleSource("decideBranch"));
    await writeFile(
      commandsPath,
      `import { decideBranch } from "./complex-branching.ts";\n${original.replace("ready: true", "ready: decideBranch(1) === 1")}`,
    );
    const complex = await runIn(destination, ["run", "check"], {});
    expect(complex.exitCode).toBe(1);
    const complexReport = parseCombinedFallow(complex.stdout, complex.stderr);
    expect({
      ...gateStatuses(complexReport),
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
      await readFile(healthHitsPath, "utf8"),
    ) as HealthRecordedHitsFile;
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
    expect(
      gateStatuses(
        parseCombinedFallow(withRecorded.stdout, withRecorded.stderr),
      ),
    ).toEqual({
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
      ...gateStatuses(secondComplexReport),
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
    await restoreRecordedHits();
  }
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

  const deadCodeHitsPath = join(
    destination,
    "fallow-dead-code-recorded-hits.json",
  );
  const duplicatesHitsPath = join(
    destination,
    "fallow-duplicates-recorded-hits.json",
  );
  const healthHitsPath = join(destination, "fallow-health-recorded-hits.json");
  const originalDeadCodeHits = await readFile(deadCodeHitsPath, "utf8");
  const originalDuplicatesHits = await readFile(duplicatesHitsPath, "utf8");
  const originalHealthHits = await readFile(healthHitsPath, "utf8");
  const restoreRecordedHits = async () => {
    await writeFile(deadCodeHitsPath, originalDeadCodeHits);
    await writeFile(duplicatesHitsPath, originalDuplicatesHits);
    await writeFile(healthHitsPath, originalHealthHits);
  };

  await assertMissingRecordedHits(
    destination,
    [
      { path: deadCodeHitsPath, expectedMessage: "failed to read baseline" },
      {
        path: duplicatesHitsPath,
        expectedMessage: "failed to read duplication baseline",
      },
      {
        path: healthHitsPath,
        expectedMessage: "failed to read health baseline",
      },
    ],
    restoreRecordedHits,
  );
  await assertDeadCodeRecording(
    destination,
    commandsPath,
    original,
    deadCodeHitsPath,
    restoreRecordedHits,
  );
  await assertDuplicatesRecording(
    destination,
    commandsPath,
    original,
    duplicatesHitsPath,
    restoreRecordedHits,
  );
  await assertComplexityRecording(
    destination,
    commandsPath,
    original,
    healthHitsPath,
    restoreRecordedHits,
  );
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
