import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const scratchRoots: string[] = [];

interface Invocation {
  exitCode: number;
  stderr: string;
  stdout: string;
}

function runIn(
  cwd: string,
  args: string[],
  env: Record<string, string>,
): Invocation {
  return runCommand(cwd, [process.execPath, ...args], env);
}

function runCommand(
  cwd: string,
  command: string[],
  env: Record<string, string> = {},
): Invocation {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env, NO_COLOR: "1" },
    stderr: "pipe",
    stdout: "pipe",
  });
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

function invoke(...args: string[]): Invocation {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/bootstrap.ts", ...args],
    {
      cwd: ROOT,
      env: { ...process.env, NO_COLOR: "1" },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp("/tmp/bun-typescript-template-test-");
  scratchRoots.push(root);
  return root;
}

async function listFiles(root: string, prefix = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(join(root, prefix), {
    withFileTypes: true,
  })) {
    const path = join(prefix, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFiles(root, path)));
    } else {
      files.push(path);
    }
  }
  return files.sort();
}

afterEach(async () => {
  await Promise.all(
    scratchRoots
      .splice(0)
      .map((root) => rm(root, { force: true, recursive: true })),
  );
});

describe("public bootstrap CLI", () => {
  test("shows useful help with no arguments", () => {
    const result = invoke();

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout).toContain("--profile scratch");
    expect(result.stdout).toContain("--profile durable");
  });

  test("generates scratch without Fallow", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "scratch-example");
    const packet = "https://example.test/vault/projects/scratch-example/";
    const result = invoke(
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
      status: "created",
    });
    const files = await listFiles(destination);
    const packageJson = JSON.parse(
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
      ["run", "start"],
      ["run", "check"],
    ]) {
      const commandResult = runIn(destination, command, runtimeEnv);
      expect(commandResult.exitCode).toBe(0);
    }
    expect(await Bun.file(invocationMarker).exists()).toBe(false);
  });

  test("generates and checks durable single-package and optional monorepo variants", async () => {
    const root = await temporaryRoot();
    for (const [name, extra, variant] of [
      ["durable-single", [], "single-package"],
      ["durable-monorepo", ["--monorepo"], "monorepo"],
    ] as const) {
      const destination = join(root, name);
      const packet = `https://example.test/vault/projects/${name}/`;
      const result = invoke(
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
      const packageJson = JSON.parse(
        await readFile(join(destination, "package.json"), "utf8"),
      );
      const readme = await readFile(join(destination, "README.md"), "utf8");
      expect(packageJson.name).toBe(name);
      expect(packageJson.packageManager).toBe("bun@1.4.0");
      expect(packageJson.devDependencies["@biomejs/biome"]).toBe("2.4.15");
      expect(packageJson.devDependencies.fallow).toBe("3.19.0");
      if (variant === "monorepo") {
        expect(packageJson.catalog.typescript).toBe("7.0.2");
        expect(packageJson.catalog["@types/bun"]).toBe("1.4.0");
        expect(packageJson.devDependencies.typescript).toBe("catalog:");
      } else {
        expect(packageJson.devDependencies.typescript).toBe("7.0.2");
        expect(packageJson.devDependencies["@types/bun"]).toBe("1.4.0");
      }
      expect(generatedFiles).not.toContain("TEMPLATE-SOURCE.md");
      expect(readme).toContain(packet);
      expect(readme).not.toContain("__SOURCE_PACKET__");
      expect(readme).not.toContain("profiles/durable");

      expect(
        runCommand(ROOT, ["git", "-C", destination, "init", "-b", "main"])
          .exitCode,
      ).toBe(0);
      expect(
        runCommand(ROOT, [
          "git",
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
        ]).exitCode,
      ).toBe(0);
      expect(
        runIn(destination, ["install", "--frozen-lockfile"], {}).exitCode,
      ).toBe(0);
      const check = runIn(destination, ["run", "check"], {});
      expect(check.exitCode).toBe(0);
      expect(check.stdout).toContain('"verdict":"pass"');
    }
  }, 120_000);

  test("refuses a non-empty destination without changing its bytes", async () => {
    const root = await temporaryRoot();
    const destination = join(root, "owned");
    const sentinel = join(destination, "keep.txt");
    await mkdir(destination);
    await writeFile(sentinel, "keep these bytes\n");
    const before = createHash("sha256")
      .update(await readFile(sentinel))
      .digest("hex");
    const result = invoke(
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
  });

  test("rejects the monorepo option for scratch", async () => {
    const root = await temporaryRoot();
    const result = invoke(
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
  });

  test("generates independently runnable simple and complex CLI starters", async () => {
    const root = await temporaryRoot();
    for (const starter of ["simple", "complex"] as const) {
      const destination = join(root, `${starter}-cli`);
      const result = invoke(
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
      expect(files).toContain(".github/workflows/ci.yml");
      expect(files).toContain("src/cli.ts");
      expect(files).not.toContain("TEMPLATE-SOURCE.md");
      expect(await readFile(join(destination, "README.md"), "utf8")).toContain(
        "https://example.test/vault/projects/",
      );

      expect(
        runIn(destination, ["install", "--frozen-lockfile"], {}).exitCode,
      ).toBe(0);
      const machine = runIn(
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
      expect(runIn(destination, ["run", "check"], {}).exitCode).toBe(0);
    }
  }, 120_000);

  test("refuses incompatible starter profile combinations before writing", async () => {
    const root = await temporaryRoot();
    for (const args of [
      ["--profile", "scratch", "--starter", "simple"],
      ["--profile", "durable", "--starter", "complex", "--monorepo"],
    ]) {
      const destination = join(root, `refused-${args.join("-")}`);
      const result = invoke(
        ...args,
        "--destination",
        destination,
        "--source-packet",
        "https://example.test/vault/projects/refused/",
        "--json",
      );
      expect(result.exitCode).toBe(2);
      expect(await Bun.file(destination).exists()).toBe(false);
      expect(JSON.parse(result.stderr)).toMatchObject({
        error: { code: "profile_option_mismatch" },
        status: "refused",
      });
    }
  });
});
