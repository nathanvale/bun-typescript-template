import { describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { inherited } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const repository = join(import.meta.dir, "../../..");
const pin = readKernelPin(repository);
const folder = ownedFolders();

const cliSources = [
  "src/cli.ts",
  "src/causes.ts",
  "src/doctor.ts",
  "src/toolchain-resolution.ts",
  "kernel-pin.json",
];

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function copyCliCheckout(
  options: {
    readonly packageManager?: string;
    readonly linkNodeModules?: boolean;
    readonly kernelTag?: string;
    readonly omitKernel?: boolean;
  } = {},
): string {
  const root = folder("doctor-cli-");
  for (const path of cliSources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
  }
  const manifest = {
    name: "bun-typescript-template",
    private: true,
    packageManager: options.packageManager ?? `bun@${Bun.version}`,
    dependencies: {
      "agent-cli-kernel": `github:nathanvale/agent-cli-kernel#${pin.commit}`,
    },
  };
  write(root, "package.json", JSON.stringify(manifest, null, 2));
  if (options.linkNodeModules === true) {
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
  } else if (options.kernelTag !== undefined || options.omitKernel === true) {
    mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
    write(
      root,
      "node_modules/typescript-eslint/package.json",
      '{"name":"typescript-eslint","main":"index.js"}',
    );
    write(
      root,
      "node_modules/typescript-eslint/index.js",
      "module.exports = {};",
    );
    write(
      root,
      "node_modules/typescript/package.json",
      '{"name":"typescript","version":"6.0.2","main":"index.js"}',
    );
    write(
      root,
      "node_modules/typescript/index.js",
      'module.exports = { version: "6.0.2" };',
    );
    write(
      root,
      "node_modules/@typescript/native/package.json",
      '{"version":"7.1.0-beta"}',
    );
    write(
      root,
      "node_modules/fallow-type-aware/package.json",
      '{"name":"fallow-type-aware","version":"3.43.2"}',
    );
    write(
      root,
      "node_modules/fallow-type-aware/node_modules/typescript/package.json",
      '{"version":"7.0.2"}',
    );
    write(
      root,
      "node_modules/.bin/tsc",
      "#!/bin/sh\necho 'Version 7.1.0-beta'\n",
    );
    chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
    write(
      root,
      "node_modules/.bin/fallow",
      '#!/bin/sh\necho \'{"status":"pass","checks":[]}\'\n',
    );
    chmodSync(join(root, "node_modules/.bin/fallow"), 0o755);
    if (options.omitKernel !== true && options.kernelTag !== undefined) {
      const kernelDir = join(root, "node_modules/agent-cli-kernel");
      mkdirSync(kernelDir, { recursive: true });
      for (const entry of readdirSync(
        join(repository, "node_modules/agent-cli-kernel"),
      )) {
        if (entry === ".bun-tag") continue;
        symlinkSync(
          join(repository, "node_modules/agent-cli-kernel", entry),
          join(kernelDir, entry),
        );
      }
      write(root, "node_modules/agent-cli-kernel/.bun-tag", options.kernelTag);
      symlinkSync(
        join(repository, "node_modules/@logtape"),
        join(root, "node_modules/@logtape"),
      );
    }
  }
  return root;
}

async function runCli(
  root: string,
  args: readonly string[],
  stateHome: string,
) {
  const result = await spawnBounded(
    [process.execPath, join(root, "src/cli.ts"), ...args],
    {
      cwd: root,
      env: { ...inherited(), XDG_STATE_HOME: stateHome },
    },
  );
  return {
    exitCode: result.exit,
    stdout: result.stdout,
    stderr: result.stderr,
    lines: result.stdout.split("\n"),
  };
}

function diagnosticsRecords(stateHome: string): unknown[] {
  const dir = join(
    stateHome,
    "my-agent-dojo",
    "bun-typescript-template",
    "diagnostics",
  );
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  return files.flatMap((name) =>
    readFileSync(join(dir, name), "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "")
      .map((line) => JSON.parse(line) as unknown),
  );
}

describe("cli front door and doctor route", () => {
  test(
    "doctor on this checkout exits 0 and --json emits one kernel envelope with results and diagnostics",
    async () => {
      const stateHome = folder("doctor-state-");
      const result = await runCli(repository, ["doctor", "--json"], stateHome);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as {
        readonly result: {
          readonly commandIdentity: string;
          readonly causeCode: string;
          readonly outcome: string;
          readonly effectClass: string;
          readonly exitCode: number;
          readonly data: {
            readonly ready: boolean;
            readonly results: readonly {
              readonly status: string;
              readonly check: string;
              readonly detail: string;
            }[];
          };
        };
        readonly diagnostics?: {
          readonly status: string;
          readonly file: string | null;
        };
      };
      expect(envelope.result.commandIdentity).toBe(
        "bun-typescript-template.doctor",
      );
      expect(envelope.result.causeCode).toBe("SUCCESS_UNCHANGED");
      expect(envelope.result.outcome).toBe("success");
      expect(envelope.result.effectClass).toBe("inspect");
      expect(envelope.result.exitCode).toBe(0);
      expect(envelope.result.data.ready).toBe(true);
      expect(envelope.result.data.results.map((f) => f.check)).toEqual([
        "bun",
        "toolchain",
        "fallow",
        "load",
      ]);
      expect(envelope.diagnostics?.status).toBe("available");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "doctor without --json prints one line per result on this checkout",
    async () => {
      const stateHome = folder("doctor-state-");
      const result = await runCli(repository, ["doctor"], stateHome);

      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.lines).toContain(
        `ok bun: Bun ${Bun.version} matches the toolchain pin.`,
      );
      expect(result.lines).toContain(
        "ok toolchain: node_modules resolves the accepted lint, compiler and semantic backends.",
      );
      expect(result.lines).toContain("ok fallow: fallow doctor passes.");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "doctor refuses a checkout that fails a check with DOMAIN_DOCTOR_CHECK_FAILED, results in the envelope, and a diagnostics event",
    async () => {
      const root = copyCliCheckout({
        packageManager: "bun@0.0.1",
        linkNodeModules: true,
      });
      const stateHome = folder("doctor-state-");
      const result = await runCli(root, ["doctor", "--json"], stateHome);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as {
        readonly result: {
          readonly commandIdentity: string;
          readonly causeCode: string;
          readonly outcome: string;
          readonly exitCode: number;
          readonly data: {
            readonly ready: boolean;
            readonly results: readonly {
              readonly status: string;
              readonly check: string;
              readonly detail: string;
            }[];
          };
        };
      };
      expect(envelope.result.commandIdentity).toBe(
        "bun-typescript-template.doctor",
      );
      expect(envelope.result.causeCode).toBe("DOMAIN_DOCTOR_CHECK_FAILED");
      expect(envelope.result.outcome).toBe("refused");
      expect(envelope.result.exitCode).toBe(3);
      expect(envelope.result.data.ready).toBe(false);
      const bunFinding = envelope.result.data.results.find(
        (result) => result.check === "bun",
      );
      expect(bunFinding?.status).toBe("FAIL");
      expect(bunFinding?.detail).toContain("mise exec bun@0.0.1");
      expect(diagnosticsRecords(stateHome)).toHaveLength(1);
    },
    processWatchdog(1),
  );

  test(
    "--discover-all lists doctor with its identity and effect class, and doctor --help answers",
    async () => {
      const stateHome = folder("doctor-state-");
      const discover = await runCli(
        repository,
        ["--discover-all", "--json"],
        stateHome,
      );
      expect(discover.exitCode).toBe(0);
      expect(discover.stderr).toBe("");
      const envelope = JSON.parse(discover.stdout) as {
        readonly result: {
          readonly data: {
            readonly commands: readonly {
              readonly command: {
                readonly commandIdentity: string;
                readonly effectClass: string;
                readonly route: readonly string[];
              };
            }[];
          };
        };
      };
      const listed = envelope.result.data.commands.find(
        (entry) =>
          entry.command.commandIdentity === "bun-typescript-template.doctor",
      );
      expect(listed?.command).toMatchObject({
        commandIdentity: "bun-typescript-template.doctor",
        effectClass: "inspect",
        route: ["doctor"],
      });

      const help = await runCli(repository, ["doctor", "--help"], stateHome);
      expect(help.exitCode).toBe(0);
      expect(help.stderr).toBe("");
      expect(help.stdout).toContain("bun-typescript-template.doctor");
    },
    processWatchdog(1),
  );

  test(
    "missing install without node_modules prints one stderr line naming bun install --frozen-lockfile and exits non-zero",
    async () => {
      const root = copyCliCheckout({ linkNodeModules: false });
      const stateHome = folder("doctor-state-");
      const result = await runCli(root, ["doctor"], stateHome);

      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toBe("");
      const stderrLines = result.stderr.trimEnd().split("\n");
      expect(stderrLines).toHaveLength(1);
      expect(stderrLines[0]).toContain("bun install --frozen-lockfile");
    },
    processWatchdog(1),
  );

  test(
    "toolchain result fails when node_modules/agent-cli-kernel is not at the Pin commit",
    async () => {
      const root = copyCliCheckout({
        kernelTag: "nathanvale-agent-cli-kernel-0000000",
      });
      const stateHome = folder("doctor-state-");
      const result = await runCli(root, ["doctor", "--json"], stateHome);

      expect(result.exitCode).toBe(3);
      expect(result.stderr).toBe("");
      const envelope = JSON.parse(result.stdout) as {
        readonly result: {
          readonly causeCode: string;
          readonly data: {
            readonly ready: boolean;
            readonly results: readonly {
              readonly status: string;
              readonly check: string;
              readonly detail: string;
            }[];
          };
        };
      };
      expect(envelope.result.causeCode).toBe("DOMAIN_DOCTOR_CHECK_FAILED");
      const toolchain = envelope.result.data.results.find(
        (result) => result.check === "toolchain",
      );
      expect(toolchain?.status).toBe("FAIL");
      expect(toolchain?.detail).toContain("agent-cli-kernel");
      expect(toolchain?.detail).toContain(
        "Repair: bun install --frozen-lockfile.",
      );
    },
    processWatchdog(1),
  );
});
