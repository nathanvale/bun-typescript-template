import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../..");

test("the generated Fallow ignore list names only the starter kit's own rule files and two recorded-size scripts, each by exact path, so a repository's own file is never hidden from its health check", () => {
  const settings = JSON.parse(
    readFileSync(
      join(ROOT, "generated-repository/settings/.fallowrc.json"),
      "utf8",
    ),
  ) as { ignorePatterns?: unknown };
  expect(settings.ignorePatterns).toEqual([
    "config/anti-slop-bindings.mjs",
    "config/anti-slop-rules.mjs",
    "config/anti-slop-type-rules.mjs",
    "config/payload-rules.mjs",
    "config/platform-rules.mjs",
    "config/template-rules.mjs",
    "scripts/check-recorded-health-sizes.ts",
    "scripts/fallow-health-at-base-settings.ts",
  ]);
  for (const pattern of settings.ignorePatterns as string[])
    expect(pattern).not.toMatch(/[*?[\]{}!]/);
});
