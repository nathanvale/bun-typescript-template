import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapCliFixture,
  invoke,
  requireSuccess,
  runIn,
} from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const temporaryRoot = bootstrapCliFixture();

test(
  "domain loading failures preserve help, discovery and unrelated commands",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "domains");
    requireSuccess(
      await invoke(
        "--profile",
        "scratch",
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/spec",
        "--json",
      ),
      "generate domain specimen",
    );
    await writeFile(
      join(destination, "src/domains/status.ts"),
      'throw new Error("provider configuration unavailable");\nexport function inspectStatus(): never { throw new Error("unavailable"); }\n',
    );
    const statusCommands: unknown = expect.arrayContaining([
      expect.objectContaining({ commandIdentity: "example.status" }),
    ]);
    for (const [args, expected] of [
      [
        ["--help", "--json"],
        {
          commandIdentity: "example.help",
          data: { usage: "example COMMAND [--json]" },
        },
      ],
      [
        ["--discover", "--json"],
        {
          commandIdentity: "example.discovery",
          data: {
            profile: "simple",
            commands: statusCommands,
          },
        },
      ],
      [
        ["template", "info", "--json"],
        {
          commandIdentity: "example.template.info",
          data: { contractVersion: "2.0.0" },
        },
      ],
    ] as const) {
      const result = await runIn(
        destination,
        ["run", "--silent", "start", "--", ...args],
        {},
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({ result: expected });
    }
    const unavailable = await runIn(
      destination,
      ["run", "--silent", "start", "--", "status", "--json"],
      {},
    );
    expect(unavailable.exitCode).toBe(1);
    expect(unavailable.stderr).toBe("");
    expect(JSON.parse(unavailable.stdout)).toMatchObject({
      result: {
        commandIdentity: "example.status",
        causeCode: "INTERNAL_RESULT_UNCHANGED",
        transactionState: "unchanged",
      },
    });
  },
  processWatchdog(5),
);

test(
  "lint, local rules, formatting and native type errors fail independent read-only checks",
  async () => {
    const root = temporaryRoot();
    const destination = join(root, "gates");
    requireSuccess(
      await invoke(
        "--profile",
        "durable",
        "--starter",
        "simple",
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
      "positive lint and local rule control",
    );
    const { scripts } = JSON.parse(
      await readFile(join(destination, "package.json"), "utf8"),
    ) as { scripts: Record<string, string> };
    const path = join(destination, "src/domains/status.ts");
    const original = await readFile(path, "utf8");
    const mutations = [
      {
        source: original + '\nprocess.stdout.write("forbidden");\n',
        phase: "lint",
        code: 1,
        diagnostic: "repository/no-domain-output",
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
        source: "export function inspectStatus(): string {\n  return 42;\n}\n",
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
  },
  processWatchdog(7),
);
