import { expect, test } from "bun:test";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapCliFixture,
  invoke,
  requireSuccess,
  runIn,
} from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const temporaryRoot = bootstrapCliFixture();

interface BoundaryViolation {
  readonly from_zone: string;
  readonly to_zone: string;
}

interface BoundaryCoverageViolation {
  readonly path: string;
}

interface CombinedFallowReport {
  readonly check?: {
    readonly boundary_violations?: readonly BoundaryViolation[];
    readonly boundary_coverage_violations?: readonly BoundaryCoverageViolation[];
  };
}

function parseCombinedReport(
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

async function expectBoundaryRefusal(
  destination: string,
  expectedFrom: string,
  expectedTo: string,
): Promise<void> {
  const result = await runIn(destination, ["run", "quality:fallow"], {});
  expect(result.exitCode).toBe(1);
  const report = parseCombinedReport(result.stdout, result.stderr);
  const pairs = (report.check?.boundary_violations ?? []).map(
    (entry) => `${entry.from_zone}->${entry.to_zone}`,
  );
  expect(pairs).toContain(`${expectedFrom}->${expectedTo}`);
}

test(
  "a fresh Bootstrap passes flat and subject-folder checks and refuses every planted source layout violation",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "source-layout-guard");
    requireSuccess(
      await invoke(
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        "--json",
      ),
      "bootstrap source layout guard specimen",
    );
    requireSuccess(
      await runIn(destination, ["install", "--frozen-lockfile"], {}),
      "install source layout guard specimen",
    );
    requireSuccess(
      await runIn(destination, ["run", "check"], {}),
      "fresh flat Bootstrap passes bun run check with layout guard on",
    );

    const commandsPath = join(destination, "src/commands.ts");
    const cliPath = join(destination, "src/cli.ts");
    const originalCommands = await readFile(commandsPath, "utf8");
    const originalCli = await readFile(cliPath, "utf8");

    const flatHelperPath = join(destination, "src/helper.ts");
    await writeFile(
      flatHelperPath,
      "export function formatTag(name: string): string {\n  return name.trim();\n}\n",
    );
    await writeFile(
      commandsPath,
      `import { formatTag } from "./helper.ts";\n${originalCommands}\nexport const helperTag = formatTag("flat");\n`,
    );
    await writeFile(
      cliPath,
      `${originalCli}\nimport { helperTag } from "./commands.ts";\nvoid helperTag;\n`,
    );
    requireSuccess(
      await runIn(destination, ["run", "check"], {}),
      "flat tool with peer file in src/ passes bun run check",
    );

    await rm(flatHelperPath, { force: true });
    await mkdir(join(destination, "src/alpha"), { recursive: true });
    await mkdir(join(destination, "src/beta"), { recursive: true });
    await mkdir(join(destination, "src/shared"), { recursive: true });

    const alphaRulesPath = join(destination, "src/alpha/rules.ts");
    const sharedEdgePath = join(destination, "src/shared/edge.ts");
    const alphaRunPath = join(destination, "src/alpha/run.ts");
    const betaRunPath = join(destination, "src/beta/run.ts");

    const alphaRulesSource =
      "export function alphaRule(value: string): string {\n  return value.trim();\n}\n";
    const sharedEdgeSource =
      'import { alphaRule } from "../alpha/rules.ts";\n\nexport function sharedEdge(value: string): string {\n  return alphaRule(value);\n}\n';
    const alphaRunSource =
      'import { sharedEdge } from "../shared/edge.ts";\nimport { alphaRule } from "./rules.ts";\n\nexport function runAlpha(value: string): string {\n  return sharedEdge(alphaRule(value));\n}\n';
    const betaRunSource =
      'import { alphaRule } from "../alpha/rules.ts";\nimport { sharedEdge } from "../shared/edge.ts";\n\nexport function runBeta(value: string): string {\n  return sharedEdge(alphaRule(value));\n}\n';
    const subjectCommandsSource = `import { runAlpha } from "./alpha/run.ts";\nimport { runBeta } from "./beta/run.ts";\n${originalCommands}\nexport const wiredSubjects = [runAlpha, runBeta];\n`;
    const subjectCliSource = `${originalCli}\nimport { wiredSubjects } from "./commands.ts";\nvoid wiredSubjects;\n`;

    await writeFile(alphaRulesPath, alphaRulesSource);
    await writeFile(sharedEdgePath, sharedEdgeSource);
    await writeFile(alphaRunPath, alphaRunSource);
    await writeFile(betaRunPath, betaRunSource);
    await writeFile(commandsPath, subjectCommandsSource);
    await writeFile(cliPath, subjectCliSource);
    requireSuccess(
      await runIn(destination, ["run", "format"], {}),
      "format two-subject specimen",
    );
    requireSuccess(
      await runIn(destination, ["run", "check"], {}),
      "clean two-subject layout passes bun run check",
    );

    const formattedBeta = await readFile(betaRunPath, "utf8");
    const formattedShared = await readFile(sharedEdgePath, "utf8");
    const formattedRules = await readFile(alphaRulesPath, "utf8");
    const formattedCommands = await readFile(commandsPath, "utf8");

    try {
      await writeFile(
        betaRunPath,
        `import { runAlpha } from "../alpha/run.ts";\n${formattedBeta}\nvoid runAlpha;\n`,
      );
      await expectBoundaryRefusal(destination, "subject/beta", "subject/alpha");
    } finally {
      await writeFile(betaRunPath, formattedBeta);
    }

    try {
      await writeFile(
        sharedEdgePath,
        `import { runAlpha } from "../alpha/run.ts";\n${formattedShared}\nvoid runAlpha;\n`,
      );
      await expectBoundaryRefusal(destination, "shared", "subject/alpha");
    } finally {
      await writeFile(sharedEdgePath, formattedShared);
    }

    try {
      await writeFile(
        sharedEdgePath,
        `import { wiredSubjects } from "../commands.ts";\n${formattedShared}\nvoid wiredSubjects;\n`,
      );
      await expectBoundaryRefusal(destination, "shared", "entry");
    } finally {
      await writeFile(sharedEdgePath, formattedShared);
    }

    try {
      await writeFile(
        alphaRulesPath,
        `import { sharedEdge } from "../shared/edge.ts";\n${formattedRules}\nvoid sharedEdge;\n`,
      );
      await expectBoundaryRefusal(destination, "rules", "shared");
    } finally {
      await writeFile(alphaRulesPath, formattedRules);
    }

    const loosePath = join(destination, "src/loose.ts");
    try {
      await writeFile(loosePath, 'export const looseValue = "loose";\n');
      await writeFile(
        commandsPath,
        `import { looseValue } from "./loose.ts";\n${formattedCommands}\nvoid looseValue;\n`,
      );
      const lintResult = await runIn(destination, ["run", "lint"], {});
      expect(lintResult.exitCode).toBe(1);
      expect(`${lintResult.stdout}\n${lintResult.stderr}`).toContain(
        "repository/no-loose-source-with-subjects",
      );
      expect(`${lintResult.stdout}\n${lintResult.stderr}`).toContain(
        "loose.ts",
      );

      await writeFile(
        betaRunPath,
        `import { looseValue } from "../loose.ts";\n${formattedBeta}\nvoid looseValue;\n`,
      );
      await expectBoundaryRefusal(destination, "subject/beta", "flat");
    } finally {
      await rm(loosePath, { force: true });
      await writeFile(commandsPath, formattedCommands);
      await writeFile(betaRunPath, formattedBeta);
    }

    const strayPath = join(destination, "stray.ts");
    try {
      await writeFile(strayPath, 'export const strayValue = "stray";\n');
      const fallowResult = await runIn(
        destination,
        ["run", "quality:fallow"],
        {},
      );
      expect(fallowResult.exitCode).toBe(1);
      const report = parseCombinedReport(
        fallowResult.stdout,
        fallowResult.stderr,
      );
      expect(
        report.check?.boundary_coverage_violations?.map((entry) => entry.path),
      ).toContain("stray.ts");
    } finally {
      await rm(strayPath, { force: true });
    }
  },
  processWatchdog(15),
);
