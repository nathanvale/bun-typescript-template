import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { bootstrapWithKernel } from "../../../src/bootstrap.ts";
import { readKernelPin } from "../../../src/kernel-pin.ts";
import { KERNEL_RECIPE, lintsCode } from "../../../src/recipe.ts";
import { listFiles } from "../../support/bootstrap-cli-fixture.ts";
import {
  generatedJson,
  stampingFixture,
} from "../../support/stamping-fixture.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const run = stampingFixture();
const bootstrapModules = [
  "src/bootstrap.ts",
  "src/recipe.ts",
  "src/stamping.ts",
  "src/merged-requirements.ts",
  "src/token-substitution.ts",
];

function sourceOf(path: string): string {
  return readFileSync(join(ROOT, path), "utf8");
}

describe("the kernel row", () => {
  test("copies folders that exist, and writes its own Template provenance values", async () => {
    for (const { from, only } of KERNEL_RECIPE.copies) {
      expect([from, statSync(join(ROOT, from)).isDirectory()]).toEqual([
        from,
        true,
      ]);
      for (const name of only ?? [])
        expect([name, existsSync(join(ROOT, from, name))]).toEqual([
          name,
          true,
        ]);
    }
    expect(lintsCode(KERNEL_RECIPE)).toBe(true);
    const { destination, request } = run();
    await bootstrapWithKernel(request);
    expect(
      generatedJson(destination, ".cli-design-template.json"),
    ).toMatchObject({
      profile: "durable",
      starter: "kernel",
      sourcePacket: "/abs/packets/demo",
      entryPoint: "src/cli.ts",
      commandOwner: "src/commands.ts",
    });
  });

  test("gives a generated repository its settings and application files, with every token substituted", async () => {
    const { destination, request } = run();
    await bootstrapWithKernel(request);
    const own = (await listFiles(destination)).filter(
      (file) => !file.startsWith("lib/") && !file.startsWith("settings/"),
    );
    expect(own).toEqual([
      ".cli-design-template.json",
      ".fallowrc.json",
      ".gitignore",
      ".kernel-stamp.json",
      "AGENTS.md",
      "README.md",
      "biome.json",
      "bunfig.toml",
      "config/anti-slop-bindings.mjs",
      "config/anti-slop-rules.mjs",
      "config/anti-slop-type-rules.mjs",
      "config/payload-rules.mjs",
      "config/platform-rules.mjs",
      "config/template-rules.mjs",
      "eslint.config.mjs",
      "package.json",
      "src/cli.ts",
      "src/commands.ts",
      "stamp-checker.ts",
      "tests/cli.test.ts",
      "tests/support/test-folder.ts",
      "tsconfig.base.json",
      "tsconfig.json",
    ]);
    const withToken = own.filter((file) =>
      /__REPOSITORY_NAME__|__SOURCE_PACKET__/.test(
        readFileSync(join(destination, file), "utf8"),
      ),
    );
    expect(withToken).toEqual([]);
    expect(readFileSync(join(destination, "src/cli.ts"), "utf8")).toContain(
      'cli: "demo-app",',
    );
  });
});

describe("Bootstrap takes kernel paths from the kernel declaration", () => {
  test("no module of Bootstrap names a folder the pinned kernel declares, or its source folder", () => {
    const pin = readKernelPin(ROOT);
    const kernelFolders = [
      "src/kernel",
      "config/kernel",
      "src/addons",
      "kernel/",
      "addons/",
      pin.repository,
    ];
    const named = bootstrapModules.flatMap((path) =>
      kernelFolders
        .filter((folder) => sourceOf(path).includes(folder))
        .map((folder) => `${path} names ${folder}`),
    );
    expect(named).toEqual([]);
  });

  test("the control: the same scan finds the one kernel path the kernel reader holds", () => {
    expect(sourceOf("src/kernel-reader.ts")).toContain("config/kernel");
  });
});

describe("stamping starts no program", () => {
  test("no module of Bootstrap but bootstrap.ts starts a process, and bootstrap.ts starts only git, for Template provenance", () => {
    const starts = /\bBun\s*\.\s*(?:spawnSync|spawn|\$)|child_process/g;
    const started = Object.fromEntries(
      bootstrapModules.map((path) => [
        path,
        sourceOf(path).match(starts) ?? [],
      ]),
    );
    expect(started).toEqual({
      "src/bootstrap.ts": ["Bun.spawnSync"],
      "src/recipe.ts": [],
      "src/stamping.ts": [],
      "src/merged-requirements.ts": [],
      "src/token-substitution.ts": [],
    });
    expect(sourceOf("src/bootstrap.ts")).toContain(
      'Bun.spawnSync(["git", "-C", TEMPLATE_ROOT, ...args], {',
    );
  });
});
