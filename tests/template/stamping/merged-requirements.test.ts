import { describe, expect, test } from "bun:test";
import { cpSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapWithKernel } from "../../../src/bootstrap.ts";
import {
  mergeRequirements,
  packageFileLists,
  settingsText,
} from "../../../src/merged-requirements.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import { initRepository } from "../../support/git-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import { stampingFixture } from "../../support/stamping-fixture.ts";

const formatter = join(ROOT, "node_modules/.bin/biome");
const run = stampingFixture();
const folder = ownedFolders();
const merged = ["package.json", ".fallowrc.json"];

async function formatterAccepts(cwd: string, files: readonly string[]) {
  const checked = await spawnBounded([formatter, "format", ...files], {
    cwd,
    processGroup: true,
  });
  return checked.exit === 0;
}

function word(length: number): string {
  return "w".repeat(length);
}

describe("the settings the stamp merges requirements into", () => {
  test("stay in the form the generated repository's formatter keeps, and the formatter refuses the plain JSON form", async () => {
    const { destination, request } = run({ addons: ["beta"] });
    await bootstrapWithKernel(request);
    initRepository(destination);
    expect(await formatterAccepts(destination, merged)).toBe(true);
    const deadCode = join(destination, ".fallowrc.json");
    const plain: unknown = JSON.parse(readFileSync(deadCode, "utf8"));
    writeFileSync(deadCode, `${JSON.stringify(plain, null, 2)}\n`);
    expect(await formatterAccepts(destination, merged)).toBe(false);
  });

  test("a list goes on one line while that line fits in 80 columns and one item a line past that, as the formatter does", async () => {
    const settings = folder("settings-text-");
    initRepository(settings);
    cpSync(
      join(ROOT, "generated-repository/settings/biome.json"),
      join(settings, "biome.json"),
    );
    const widths = [61, 62, 63, 64, 65];
    const layouts = widths.map((width) => {
      const lists = {
        followed: { first: [word(width)], last: [word(width)] },
        nested: [[word(width + 6)], { deep: [[], {}, [1, null, false]] }],
      };
      const text = settingsText(lists);
      writeFileSync(join(settings, `width-${width}.json`), text);
      expect(JSON.parse(text)).toEqual(lists);
      return [
        text.includes(`"first": ["${word(width)}"],`),
        text.includes(`"last": ["${word(width)}"]`),
      ];
    });
    expect(layouts).toEqual([
      [true, true],
      [true, true],
      [false, true],
      [false, true],
      [false, false],
    ]);
    expect(
      await formatterAccepts(
        settings,
        widths.map((width) => `width-${width}.json`),
      ),
    ).toBe(true);
  });

  test("a list in package.json goes one item a line however short, as the formatter does there, and the formatter refuses it on one line", async () => {
    const settings = folder("settings-text-");
    initRepository(settings);
    cpSync(
      join(ROOT, "generated-repository/settings/biome.json"),
      join(settings, "biome.json"),
    );
    const packageSettings = { name: "demo", files: ["a"], none: [], no: {} };
    const text = settingsText(packageSettings, packageFileLists);
    expect(text).toBe(
      '{\n  "name": "demo",\n  "files": [\n    "a"\n  ],\n  "none": [],\n  "no": {}\n}\n',
    );
    writeFileSync(join(settings, "package.json"), text);
    expect(await formatterAccepts(settings, ["package.json"])).toBe(true);
    writeFileSync(
      join(settings, "package.json"),
      settingsText(packageSettings),
    );
    expect(await formatterAccepts(settings, ["package.json"])).toBe(false);
  });

  test("merging keeps a list in package.json one item a line and fits a list in the dead-code settings on its line", async () => {
    const settings = folder("settings-merge-");
    write(settings, "package.json", '{ "files": ["a"] }\n');
    write(settings, ".fallowrc.json", '{ "entry": ["x"] }\n');
    const merged = await mergeRequirements(settings, {
      packages: { "left-pad": "1.3.0" },
      deadCodeEntries: ["y"],
    });
    expect({
      merged,
      packageFile: readFileSync(join(settings, "package.json"), "utf8"),
      deadCodeFile: readFileSync(join(settings, ".fallowrc.json"), "utf8"),
    }).toEqual({
      merged: { packages: { "left-pad": "1.3.0" }, deadCodeEntries: ["y"] },
      packageFile:
        '{\n  "files": [\n    "a"\n  ],\n  "dependencies": {\n    "left-pad": "1.3.0"\n  }\n}\n',
      deadCodeFile: '{\n  "entry": ["x", "y"]\n}\n',
    });
  });
});
