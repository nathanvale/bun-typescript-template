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

interface CombinedFallowCheck {
  readonly kind: string;
  readonly check?: {
    readonly unused_enum_members?: readonly { readonly member_name: string }[];
  };
}

function parseCombinedReport(
  stdout: string,
  stderr: string,
): CombinedFallowCheck {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error(
      `Expected Fallow JSON output, got stdout=${JSON.stringify(stdout)} stderr=${JSON.stringify(stderr)}`,
    );
  }
  return JSON.parse(stdout.slice(start)) as CombinedFallowCheck;
}

test(
  "a fresh Bootstrap passes bun run check with the nine default Fallow rules enabled and fails when an unused enum member is added",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "fallow-defaults");
    requireSuccess(
      await invoke(
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        "--json",
      ),
      "bootstrap fallow defaults specimen",
    );
    requireSuccess(
      await runIn(destination, ["install", "--frozen-lockfile"], {}),
      "install fallow defaults specimen",
    );
    requireSuccess(
      await runIn(destination, ["run", "check"], {}),
      "fresh Bootstrap passes bun run check with default Fallow rules",
    );

    const commandsPath = join(destination, "src/commands.ts");
    const original = await readFile(commandsPath, "utf8");
    const enumPath = join(destination, "src/mode-probe.ts");
    try {
      await writeFile(
        enumPath,
        'export enum ModeProbe {\n  Used = "used",\n  Unused = "unused",\n}\n',
      );
      await writeFile(
        commandsPath,
        `import { ModeProbe } from "./mode-probe.ts";\nconst usedMode: string = ModeProbe.Used;\nvoid usedMode;\n${original}`,
      );
      const result = await runIn(destination, ["run", "quality:fallow"], {});
      expect(result.exitCode).toBe(1);
      const report = parseCombinedReport(result.stdout, result.stderr);
      expect(
        report.check?.unused_enum_members?.map((entry) => entry.member_name),
      ).toContain("Unused");
    } finally {
      await writeFile(commandsPath, original);
      await rm(enumPath, { force: true });
    }
  },
  processWatchdog(10),
);
