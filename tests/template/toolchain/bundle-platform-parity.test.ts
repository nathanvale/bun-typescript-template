import { expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  bundleEntry,
  bundleOutput,
  bundleRepository,
  fixtureBundle,
  fixtureKernelCommit,
  lockResolving,
  runScript,
} from "../../support/bundles-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { processWatchdog } from "../../support/process.ts";

const folder = ownedFolders();

test(
  "check:bundles on this host accepts tests/fixtures/bundle/bundle.txt, the stamped bundle built on macOS",
  async () => {
    const root = bundleRepository(folder("bundles-"), {
      bundles: { [bundleOutput]: bundleEntry },
      kernelAt: fixtureKernelCommit,
      lock: lockResolving(fixtureKernelCommit),
    });
    mkdirSync(dirname(join(root, bundleOutput)), { recursive: true });
    writeFileSync(join(root, bundleOutput), fixtureBundle);
    expect(await runScript(root, "check:bundles")).toEqual({
      exit: 0,
      stdout: "Verified 1 bundle up to date.\n",
      stderr: "",
    });
  },
  processWatchdog(2),
);
