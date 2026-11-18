import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ROOT,
  bootstrapCliFixture,
  commitGeneratedFiles,
  invoke,
  listFiles,
  parsePackage,
  requireSuccess,
  runGit,
  runIn,
} from "../../support/bootstrap-cli-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const temporaryRoot = bootstrapCliFixture();

const GENERATED_CI = `name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with:
          bun-version: 1.4.4
      - run: bun install --frozen-lockfile
      - run: bun run check
`;

const STARTER_FILES = {
  simple: [
    ".cli-design-template.json",
    "eslint-rules.mjs",
    "AGENTS.md",
    "eslint.config.mjs",
    "src/commands-contract.ts",
    "src/commands.ts",
    "src/domains/status.ts",
    "src/domains/result.ts",
    "src/domains/template.ts",
    ".fallowrc.json",
    ".github/workflows/ci.yml",
    ".gitignore",
    "README.md",
    "biome.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "src/cli.ts",
    "tests/cli.test.ts",
    "tsconfig.base.json",
    "tsconfig.json",
  ],
  complex: [
    ".cli-design-template.json",
    "eslint-rules.mjs",
    "AGENTS.md",
    "eslint.config.mjs",
    "src/commands-contract.ts",
    "src/commands.ts",
    "src/domains/state.ts",
    "src/diagnostics-custody.ts",
    ".fallowrc.json",
    ".github/workflows/ci.yml",
    ".gitignore",
    "README.md",
    "biome.json",
    "bun.lock",
    "bunfig.toml",
    "package.json",
    "src/branch-station-catalog.ts",
    "src/cli.ts",
    "src/command-contract.ts",
    "src/diagnostics.ts",
    "src/engine.ts",
    "src/journal.ts",
    "src/model.ts",
    "src/process-lifecycle.ts",
    "src/runtime.ts",
    "tests/catalog/catalog.test.ts",
    "tests/integration/diagnostics.test.ts",
    "tests/integration/integration.test.ts",
    "tests/unit/unit.test.ts",
    "tsconfig.base.json",
    "tsconfig.json",
  ],
} as const;

const SOURCE_PACKET_DATA_MESSAGE =
  "HTTP(S) source packet URLs must not contain username, password, or query data";
const SOURCE_PACKET_DATA_REPAIR =
  "remove username, password, or query data, or use an absolute local packet path";

async function expectRejectedSourcePacket(
  root: string,
  name: string,
  packet: string,
  redactedParts: readonly string[],
): Promise<void> {
  const destination = join(root, name);
  const result = await invoke(
    "--profile",
    "scratch",
    "--destination",
    destination,
    "--source-packet",
    packet,
    "--json",
  );

  expect(result.exitCode).toBe(2);
  for (const value of [packet, ...redactedParts]) {
    expect(result.stdout).not.toContain(value);
    expect(result.stderr).not.toContain(value);
  }
  expect(JSON.parse(result.stderr)).toMatchObject({
    error: {
      code: "invalid_source_packet",
      message: SOURCE_PACKET_DATA_MESSAGE,
      repair: SOURCE_PACKET_DATA_REPAIR,
      retrySafe: true,
    },
    status: "refused",
  });
  expect(existsSync(destination)).toBe(false);
  expect(existsSync(join(destination, "README.md"))).toBe(false);
}

describe("public bootstrap CLI", () => {
  test(
    "shows useful help with no arguments",
    async () => {
      const result = await invoke();

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toContain("--profile scratch");
      expect(result.stdout).toContain("--profile durable");
    },
    processWatchdog(1),
  );

  test(
    "generates scratch without Fallow",
    async () => {
      const root = temporaryRoot();
      const destination = join(root, "scratch-example");
      const packet = "https://example.test/vault/projects/%7Escratch-example/";
      const result = await invoke(
        "--profile",
        "scratch",
        "--destination",
        destination,
        "--source-packet",
        packet,
        "--json",
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toMatchObject({
        profile: "scratch",
        sourcePacket: packet,
        status: "created",
      });
      const files = await listFiles(destination);
      const packageJson = parsePackage(
        await readFile(join(destination, "package.json"), "utf8"),
      );
      expect(packageJson.scripts).not.toHaveProperty("quality:fallow");
      expect(packageJson.devDependencies ?? {}).not.toHaveProperty("fallow");
      expect(files.some((file) => file.toLowerCase().includes("fallow"))).toBe(
        false,
      );
      expect(files).not.toContain("TEMPLATE-SOURCE.md");
      expect(await readFile(join(destination, "README.md"), "utf8")).toContain(
        packet,
      );

      const sentinelDirectory = join(root, "sentinel-bin");
      const sentinelPath = join(sentinelDirectory, "fallow");
      const invocationMarker = join(root, "fallow-invoked");
      await mkdir(sentinelDirectory);
      await writeFile(
        sentinelPath,
        '#!/bin/sh\nprintf "%s\\n" invoked > "$FALLOW_SENTINEL"\nexit 97\n',
      );
      await chmod(sentinelPath, 0o755);
      const runtimeEnv = {
        FALLOW_SENTINEL: invocationMarker,
        PATH: `${sentinelDirectory}:${process.env.PATH ?? ""}`,
      };
      for (const command of [
        ["install", "--frozen-lockfile"],
        ["run", "start", "--", "status"],
        ["run", "check"],
      ]) {
        const commandResult = await runIn(destination, command, runtimeEnv);
        requireSuccess(commandResult, command.join(" "));
      }
      expect(await Bun.file(invocationMarker).exists()).toBe(false);
    },
    processWatchdog(4),
  );

  test(
    "rejects username-only source packets before writing or output",
    async () => {
      const root = temporaryRoot();
      await expectRejectedSourcePacket(
        root,
        "username",
        "https://demo@example.test/vault/projects/example/",
        ["demo"],
      );
    },
    processWatchdog(1),
  );

  test(
    "rejects password-only source packets before writing or output",
    async () => {
      const root = temporaryRoot();
      await expectRejectedSourcePacket(
        root,
        "password",
        "https://:secret@example.test/",
        ["secret"],
      );
    },
    processWatchdog(1),
  );

  test(
    "rejects query source packets before writing or output",
    async () => {
      const root = temporaryRoot();
      await expectRejectedSourcePacket(
        root,
        "query",
        "https://example.test/vault/projects/example/?access=example-only",
        ["access=example-only"],
      );
    },
    processWatchdog(1),
  );

  test(
    "generates and checks durable single-package and optional monorepo variants",
    async () => {
      const root = temporaryRoot();
      for (const [name, extra, variant] of [
        ["durable-single", [], "single-package"],
        ["durable-monorepo", ["--monorepo"], "monorepo"],
      ] as const) {
        const destination = join(root, name);
        const packet = `https://example.test/vault/projects/${name}/`;
        const result = await invoke(
          "--profile",
          "durable",
          "--destination",
          destination,
          "--source-packet",
          packet,
          ...extra,
          "--json",
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          profile: "durable",
          status: "created",
          variant,
        });
        const generatedFiles = await listFiles(destination);
        const packageJson = parsePackage(
          await readFile(join(destination, "package.json"), "utf8"),
        );
        const readme = await readFile(join(destination, "README.md"), "utf8");
        expect(packageJson.name).toBe(name);
        expect(packageJson.packageManager).toBe("bun@1.4.4");
        expect(packageJson.devDependencies["@biomejs/biome"]).toBe("2.6.7");
        expect(packageJson.devDependencies.fallow).toBe("3.43.2");
        if (variant === "monorepo") {
          expect(packageJson.catalog.typescript).toBe("npm:typescript@7.0.2");
          expect(packageJson.catalog["@types/bun"]).toBe("1.4.4");
          expect(packageJson.devDependencies.typescript).toBe(
            "npm:@typescript/typescript6@6.0.2",
          );
        } else {
          expect(packageJson.devDependencies.typescript).toBe(
            "npm:@typescript/typescript6@6.0.2",
          );
          expect(packageJson.devDependencies["@types/bun"]).toBe("1.4.4");
        }
        expect(generatedFiles).not.toContain("TEMPLATE-SOURCE.md");
        expect(readme).toContain(packet);
        expect(readme).not.toContain("__SOURCE_PACKET__");
        expect(readme).not.toContain("profiles/durable");

        expect(
          (await runGit(ROOT, ["-C", destination, "init", "-b", "main"]))
            .exitCode,
        ).toBe(0);
        expect(
          (
            await runGit(ROOT, [
              "-C",
              destination,
              "-c",
              "user.name=Bootstrap Test",
              "-c",
              "user.email=bootstrap@example.invalid",
              "commit",
              "--allow-empty",
              "-m",
              "chore: establish comparison base",
            ])
          ).exitCode,
        ).toBe(0);
        expect(
          (await runIn(destination, ["install", "--frozen-lockfile"], {}))
            .exitCode,
        ).toBe(0);
        const check = await runIn(destination, ["run", "check"], {});
        requireSuccess(check, "durable generated check");
        expect(check.stdout).toContain('"verdict":"pass"');
        if (variant === "monorepo") {
          const testPath = join(destination, "tests/cli.test.ts");
          const original = await readFile(testPath, "utf8");
          await writeFile(
            testPath,
            original +
              '\ntest("root CLI tests are executed", () => { throw new Error("ROOT_CLI_TEST_SENTINEL"); });\n',
          );
          const failed = await runIn(destination, ["run", "test"], {});
          expect(failed.exitCode).not.toBe(0);
          expect(failed.stderr).toContain("ROOT_CLI_TEST_SENTINEL");
          await writeFile(testPath, original);
        }
      }
    },
    processWatchdog(11),
  );

  test(
    "refuses a non-empty destination without changing its bytes",
    async () => {
      const root = temporaryRoot();
      const destination = join(root, "owned");
      const sentinel = join(destination, "keep.txt");
      await mkdir(destination);
      await writeFile(sentinel, "keep these bytes\n");
      const before = createHash("sha256")
        .update(await readFile(sentinel))
        .digest("hex");
      const result = await invoke(
        "--profile",
        "scratch",
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/vault/projects/owned/",
        "--json",
      );
      const after = createHash("sha256")
        .update(await readFile(sentinel))
        .digest("hex");

      expect(result.exitCode).toBe(3);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "refused",
        error: { code: "destination_not_empty", retrySafe: true },
      });
      expect(after).toBe(before);
      expect(await listFiles(destination)).toEqual(["keep.txt"]);
    },
    processWatchdog(1),
  );

  test(
    "rejects the monorepo option for scratch",
    async () => {
      const root = temporaryRoot();
      const result = await invoke(
        "--profile",
        "scratch",
        "--destination",
        join(root, "invalid"),
        "--source-packet",
        "https://example.test/vault/projects/invalid/",
        "--monorepo",
        "--json",
      );

      expect(result.exitCode).toBe(2);
      expect(result.stdout).toBe("");
      expect(JSON.parse(result.stderr)).toMatchObject({
        status: "refused",
        error: { code: "profile_option_mismatch", retrySafe: true },
      });
    },
    processWatchdog(1),
  );

  test(
    "generates independently runnable simple and complex CLI starters",
    async () => {
      const root = temporaryRoot();
      for (const starter of ["simple", "complex"] as const) {
        const destination = join(root, `${starter}-cli`);
        const result = await invoke(
          "--profile",
          "durable",
          "--starter",
          starter,
          "--destination",
          destination,
          "--source-packet",
          `https://example.test/vault/projects/${starter}-cli/`,
          "--json",
        );

        expect(result.exitCode).toBe(0);
        expect(result.stderr).toBe("");
        expect(JSON.parse(result.stdout)).toMatchObject({
          profile: "durable",
          starter,
          status: "created",
          variant: "single-package",
        });
        const files = await listFiles(destination);
        expect(files).toEqual([...STARTER_FILES[starter]].sort());
        expect(
          await readFile(join(destination, ".github/workflows/ci.yml"), "utf8"),
        ).toBe(GENERATED_CI);
        expect(
          await readFile(join(destination, "README.md"), "utf8"),
        ).toContain("https://example.test/vault/projects/");

        expect(
          (await runIn(destination, ["install", "--frozen-lockfile"], {}))
            .exitCode,
        ).toBe(0);
        const machine = await runIn(
          destination,
          ["run", "--silent", "start", "--", "status", "--json"],
          {},
        );
        expect(machine.exitCode).toBe(0);
        expect(machine.stderr).toBe("");
        expect(JSON.parse(machine.stdout)).toMatchObject({
          contractVersion: "2.0.0",
          envelopeVersion: 2,
          result: { outcome: "success", transactionState: "unchanged" },
        });

        const help = await runIn(
          destination,
          ["run", "--silent", "start", "--", "--help"],
          {},
        );
        expect(help.exitCode).toBe(0);
        expect(help.stderr).toBe("");
        expect(help.stdout).toContain("Usage: example");
        if (starter === "complex") expect(help.stdout).toContain("recover");

        const discovery = await runIn(
          destination,
          [
            "run",
            "--silent",
            "start",
            "--",
            "--discover-command",
            "example.status",
            "--json",
          ],
          {},
        );
        expect(discovery.exitCode).toBe(0);
        expect(discovery.stderr).toBe("");
        expect(JSON.parse(discovery.stdout)).toMatchObject({
          result: {
            data: {
              command: { commandIdentity: "example.status" },
              semantics: "possible-outcomes",
            },
          },
        });

        await commitGeneratedFiles(destination, STARTER_FILES[starter]);
        const freshCheckout = join(root, `${starter}-fresh-checkout`);
        requireSuccess(
          await runGit(root, ["clone", "--quiet", destination, freshCheckout]),
          "git clone generated starter",
        );
        expect(existsSync(join(freshCheckout, "node_modules"))).toBe(false);
        expect(
          (await runIn(freshCheckout, ["install", "--frozen-lockfile"], {}))
            .exitCode,
        ).toBe(0);
        requireSuccess(
          await runIn(freshCheckout, ["run", "check"], {}),
          "fresh generated check",
        );
        expect(
          (await runGit(freshCheckout, ["status", "--short"])).stdout,
        ).toBe("");
      }
    },
    processWatchdog(24),
  );

  test(
    "refuses incompatible starter profile combinations before writing",
    async () => {
      const root = temporaryRoot();
      for (const args of [
        ["--profile", "scratch", "--starter", "simple"],
        ["--profile", "durable", "--starter", "complex", "--monorepo"],
      ]) {
        const destination = join(root, `refused-${args.join("-")}`);
        const result = await invoke(
          ...args,
          "--destination",
          destination,
          "--source-packet",
          "https://example.test/vault/projects/refused/",
          "--json",
        );
        expect(result.exitCode).toBe(2);
        expect(existsSync(destination)).toBe(false);
        expect(JSON.parse(result.stderr)).toMatchObject({
          error: { code: "profile_option_mismatch" },
          status: "refused",
        });
      }
    },
    processWatchdog(2),
  );
});
