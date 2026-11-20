import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const folder = ownedFolders();
const imports = `import { movePin } from ${JSON.stringify(join(ROOT, "scripts/pin-move.ts"))};
import type { TrialPassed } from ${JSON.stringify(join(ROOT, "scripts/kernel-trial.ts"))};
`;

async function compile(call: string) {
  const probe = folder("pin-move-compile-");
  writeFileSync(join(probe, "probe.ts"), `${imports}${call}\n`);
  writeFileSync(
    join(probe, "tsconfig.json"),
    JSON.stringify({
      extends: join(ROOT, "tsconfig.base.json"),
      compilerOptions: { typeRoots: [join(ROOT, "node_modules/@types")] },
      files: ["probe.ts"],
    }),
  );
  const run = await spawnBounded(
    [join(ROOT, "node_modules/.bin/tsc"), "--noEmit", "-p", "tsconfig.json"],
    { cwd: probe },
  );
  return {
    exit: run.exit,
    errors: [
      ...run.stdout.matchAll(/probe\.ts\((\d+),\d+\): error (TS\d+)/g),
    ].map(([, line, code]) => `line ${line}: ${code}`),
  };
}

describe("a pin move without a passed kernel trial", () => {
  test(
    "the control: a pin move given a passed kernel trial compiles",
    async () => {
      expect(
        await compile(
          'declare const passed: TrialPassed;\nmovePin(passed, "/template");',
        ),
      ).toEqual({ exit: 0, errors: [] });
    },
    processWatchdog(1),
  );

  test(
    "does not compile when given a plain object with a passed trial's fields",
    async () => {
      expect(
        await compile(
          'export type Unused = TrialPassed;\nmovePin({ kernel: { repository: "/kernel", commit: "0".repeat(40) }, lockfile: new Uint8Array() }, "/template");',
        ),
      ).toEqual({ exit: 2, errors: ["line 4: TS2741"] });
    },
    processWatchdog(1),
  );
});
