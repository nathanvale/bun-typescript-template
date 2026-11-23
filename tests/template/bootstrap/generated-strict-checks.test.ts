import { expect, test } from "bun:test";
import { mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ESLint } from "eslint";
import ts from "typescript";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import {
  bootstrapCliFixture,
  invokeIn,
  requireSuccess,
  ROOT,
  runIn,
} from "../../support/bootstrap-cli-fixture.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { kernelCheckout } from "../../support/kernel-sibling.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  messages,
  ruleHits,
  ruleOn,
  templateSourceFile,
} from "../../support/template-lint.ts";

const temporaryRoot = bootstrapCliFixture();

function bootstrapIsolated(destination: string) {
  return invokeIn(ROOT, { ...inherited(), ...gitEnv }, [
    "--destination",
    destination,
    "--source-packet",
    "https://example.test/spec",
    "--json",
  ]);
}

function linkTemplatePackagesAndKernel(destination: string): void {
  const modules = join(destination, "node_modules");
  mkdirSync(modules);
  for (const name of readdirSync(join(ROOT, "node_modules"))) {
    symlinkSync(join(ROOT, "node_modules", name), join(modules, name));
  }
  kernelCheckout(join(modules, readKernelPin(ROOT).repository));
}

function diagnosticCodesFor(
  rootDir: string,
  filePath: string,
  code: string,
): number[] {
  const parsed = ts.parseJsonConfigFileContent(
    ts.readConfigFile(resolve(rootDir, "tsconfig.json"), (path) =>
      ts.sys.readFile(path),
    ).config,
    ts.sys,
    rootDir,
  );
  const target = resolve(rootDir, filePath);
  const host = ts.createCompilerHost(parsed.options);
  host.getCurrentDirectory = () => rootDir;
  const read = host.getSourceFile.bind(host);
  host.getSourceFile = (name, language, ...rest) =>
    name === target
      ? ts.createSourceFile(name, code, language)
      : read(name, language, ...rest);
  const program = ts.createProgram([target], parsed.options, host);
  return ts
    .getPreEmitDiagnostics(program, program.getSourceFile(target))
    .map((item) => item.code);
}

function plantUnusedParameter(source: string): string {
  const replaced = source.replace(
    "run: (_input, context) =>",
    "run: (input, context) =>",
  );
  if (replaced === source) {
    throw new Error("Expected run: (_input, context) => in src/commands.ts");
  }
  return replaced;
}

function plantUnreachableReturn(source: string): string {
  const replaced = source.replace(
    "export const commands = [status] as const;",
    "function deadStep(): number {\n  return 1;\n  return 2;\n}\n\nvoid deadStep;\n\nexport const commands = [status] as const;",
  );
  if (replaced === source) {
    throw new Error("Expected export const commands in src/commands.ts");
  }
  return replaced;
}

async function assertLintParamMatrix(
  lintText: (code: string) => Promise<readonly (string | null)[]>,
): Promise<void> {
  expect(
    await lintText(
      "export function probe(unused: number, used: number): number {\n  return used;\n}\n",
    ),
  ).toContain("@typescript-eslint/no-unused-vars");
  expect(
    await lintText(
      "export function probe(used: number, unused: number): number {\n  return used;\n}\n",
    ),
  ).toContain("@typescript-eslint/no-unused-vars");
  expect(
    await lintText(
      "export function probe(_unused: number, used: number): number {\n  return used;\n}\n",
    ),
  ).toEqual([]);
  expect(
    await lintText(
      "export function probe(used: number, _unused: number): number {\n  return used;\n}\n",
    ),
  ).toEqual([]);
  expect(
    await lintText(
      "export function probe(): number {\n  return 1;\n  return 2;\n}\n",
    ),
  ).toEqual([]);
}

test(
  "template eslint.config.mjs and tsconfig.base.json enforce strict checks with single ownership",
  async () => {
    expect(
      await ruleOn("@typescript-eslint/no-unused-vars", "scripts/probe.mts"),
    ).toBe(true);
    await assertLintParamMatrix(async (code) =>
      (await messages(templateSourceFile, code)).map((item) => item.ruleId),
    );
    expect(
      await ruleHits(
        "@typescript-eslint/no-unused-vars",
        templateSourceFile,
        "export function probe(unused: number, used: number): number {\n  return used;\n}\n",
      ),
    ).toHaveLength(1);
    expect(
      diagnosticCodesFor(
        ROOT,
        templateSourceFile,
        "export function probe(): number {\n  return 1;\n  return 2;\n}\n",
      ),
    ).toContain(7027);
    expect(
      diagnosticCodesFor(
        ROOT,
        templateSourceFile,
        "export function probe(unused: number, used: number): number {\n  return used;\n}\n",
      ),
    ).toEqual([]);
  },
  processWatchdog(5),
);

test(
  "bootstrapped eslint.config.mjs refuses plain unused parameters and accepts underscore-prefixed ones",
  async () => {
    const destination = join(temporaryRoot(), "fast-unused-params");
    requireSuccess(
      await bootstrapIsolated(destination),
      "bootstrap fast unused parameters specimen",
    );
    linkTemplatePackagesAndKernel(destination);

    const generatedEslint = new ESLint({ cwd: destination });
    const commandsPath = join(destination, "src/commands.ts");
    await assertLintParamMatrix(async (code) => {
      const [result] = await generatedEslint.lintText(code, {
        filePath: commandsPath,
      });
      return (result?.messages ?? []).map((item) => item.ruleId);
    });
    const mtsConfig: unknown = await generatedEslint.calculateConfigForFile(
      join(destination, "scripts/probe.mts"),
    );
    expect(mtsConfig).toBeDefined();
  },
  processWatchdog(5),
);

test(
  "bootstrapped tsconfig.base.json refuses unreachable code after return without duplicating lint",
  async () => {
    const destination = join(temporaryRoot(), "fast-unreachable");
    requireSuccess(
      await bootstrapIsolated(destination),
      "bootstrap fast unreachable specimen",
    );
    linkTemplatePackagesAndKernel(destination);

    expect(
      diagnosticCodesFor(
        destination,
        "src/commands.ts",
        "export function probe(): number {\n  return 1;\n  return 2;\n}\n",
      ),
    ).toContain(7027);
    expect(
      diagnosticCodesFor(
        destination,
        "src/commands.ts",
        "export function probe(unused: number, used: number): number {\n  return used;\n}\n",
      ),
    ).toEqual([]);
  },
  processWatchdog(5),
);

test(
  "a fresh Bootstrap passes bun run check with strict checks on and refuses planted unused parameters and unreachable code",
  async () => {
    const destination = join(temporaryRoot(), "strict-checks-bootstrap");
    requireSuccess(
      await bootstrapIsolated(destination),
      "bootstrap strict checks specimen",
    );
    requireSuccess(
      await runIn(destination, ["install", "--frozen-lockfile"], {}),
      "install strict checks specimen",
    );
    requireSuccess(
      await runIn(destination, ["run", "check"], {}),
      "fresh Bootstrap passes bun run check with strict checks on",
    );

    const commandsPath = join(destination, "src/commands.ts");
    const original = await readFile(commandsPath, "utf8");

    try {
      await writeFile(commandsPath, plantUnusedParameter(original));
      const plainCheck = await runIn(destination, ["run", "check"], {});
      expect(plainCheck.exitCode).not.toBe(0);
      expect(`${plainCheck.stdout}\n${plainCheck.stderr}`).toContain(
        "@typescript-eslint/no-unused-vars",
      );

      await writeFile(commandsPath, plantUnreachableReturn(original));
      const unreachableCheck = await runIn(destination, ["run", "check"], {});
      expect(unreachableCheck.exitCode).not.toBe(0);
      expect(
        `${unreachableCheck.stdout}\n${unreachableCheck.stderr}`,
      ).toContain("TS7027");
    } finally {
      await writeFile(commandsPath, original);
    }
  },
  processWatchdog(15),
);
