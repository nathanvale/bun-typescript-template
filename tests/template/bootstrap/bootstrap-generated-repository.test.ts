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
  "lint, the template's rules, formatting and native type errors fail independent read-only checks",
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
  },
  processWatchdog(10),
);
