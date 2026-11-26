import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  bundleEntry,
  bundleOutput,
  bundleRepository,
  pinnedCommit,
  runScript,
} from "../../support/bundles-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { trialBase } from "../../support/kernel-sibling.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";

const folder = ownedFolders();
const bundles = { [bundleOutput]: bundleEntry };
const stamp = `// bundle: agent-cli-kernel@${pinnedCommit} bun@${Bun.version}`;
const rebuild =
  "Repair: run bun install --frozen-lockfile, then bun run build:bundles.";

function expectRefusal(
  run: {
    readonly exit: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  code: string,
  names: string,
) {
  expect({ exit: run.exit, stdout: run.stdout }).toEqual({
    exit: 1,
    stdout: "",
  });
  expect(run.stderr).toStartWith(`${code}: `);
  expect(run.stderr).toContain(names);
  expect(run.stderr).toContain("\nRepair: ");
}

describe("build:bundles", () => {
  test(
    "writes a bundle whose line 2 is the kernel commit and Bun version stamp, and a second run changes nothing",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      const first = await runScript(root, "build:bundles");
      expect({ exit: first.exit, stderr: first.stderr }).toEqual({
        exit: 0,
        stderr: "",
      });
      const written = readFileSync(join(root, bundleOutput));
      expect(written.toString("utf8").split("\n").slice(0, 2)).toEqual([
        "// @bun",
        stamp,
      ]);
      const elsewhere = folder("bundle-run-");
      writeFileSync(join(elsewhere, "cli.mjs"), written);
      const ran = await spawnBounded([process.execPath, "cli.mjs"], {
        cwd: elsewhere,
        env: { PATH: process.env.PATH, XDG_STATE_HOME: "/state" },
        processGroup: true,
      });
      expect(ran).toEqual({
        exit: 0,
        stdout: "Hello, bundle. /state\n",
        stderr: "",
      });
      const second = await runScript(root, "build:bundles");
      expect(second).toEqual({
        exit: 0,
        stdout: "Built 1 bundle; rewrote none.\n",
        stderr: "",
      });
      expect(readFileSync(join(root, bundleOutput)).equals(written)).toBe(true);
    },
    processWatchdog(4),
  );

  test(
    "regenerate runs build:bundles",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      const run = await runScript(root, "regenerate");
      expect(run.exit).toBe(0);
      expect(
        readFileSync(join(root, bundleOutput), "utf8").split("\n")[1],
      ).toBe(stamp);
    },
    processWatchdog(2),
  );
});

describe("check:bundles", () => {
  test(
    "passes on fresh bundles and refuses bundle_stale naming the path after a one-byte edit",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      expect((await runScript(root, "build:bundles")).exit).toBe(0);
      expect(await runScript(root, "check:bundles")).toEqual({
        exit: 0,
        stdout: "Verified 1 bundle up to date.\n",
        stderr: "",
      });
      const path = join(root, bundleOutput);
      const edited = readFileSync(path, "utf8").replace("Hello", "Jello");
      writeFileSync(path, edited);
      const stale = await runScript(root, "check:bundles");
      expectRefusal(stale, "bundle_stale", `Stale bundles: ${bundleOutput}.`);
      expect(stale.stderr).toContain(rebuild);
      expect(readFileSync(path, "utf8")).toBe(edited);
    },
    processWatchdog(4),
  );

  test(
    "refuses bundle_stale naming a missing output and writes nothing",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      const stale = await runScript(root, "check:bundles");
      expectRefusal(
        stale,
        "bundle_stale",
        `Stale bundles: ${bundleOutput} (missing).`,
      );
      expect(stale.stderr).toContain(rebuild);
      expect(existsSync(join(root, bundleOutput))).toBe(false);
    },
    processWatchdog(2),
  );
});

describe("build-bundles refusals", () => {
  test(
    "refuses bundle_kernel_mismatch when package.json pins another commit than bun.lock resolves",
    async () => {
      const root = bundleRepository(folder("bundles-"), {
        bundles,
        pins: trialBase,
      });
      for (const script of ["build:bundles", "check:bundles"] as const)
        expectRefusal(
          await runScript(root, script),
          "bundle_kernel_mismatch",
          `pins agent-cli-kernel at ${trialBase}, and bun.lock resolves ${pinnedCommit.slice(0, 7)}.`,
        );
      expect(existsSync(join(root, bundleOutput))).toBe(false);
    },
    processWatchdog(3),
  );

  test(
    "refuses bundle_entry_missing for a listed entry that does not exist",
    async () => {
      const absent = "tools/absent/src/main.ts";
      const root = bundleRepository(folder("bundles-"), {
        bundles: { ...bundles, "tools/absent/dist/cli.mjs": absent },
      });
      for (const script of ["build:bundles", "check:bundles"] as const)
        expectRefusal(
          await runScript(root, script),
          "bundle_entry_missing",
          `No entry file at ${absent}.`,
        );
      expect(existsSync(join(root, bundleOutput))).toBe(false);
    },
    processWatchdog(3),
  );

  test(
    "with no bundles key, both scripts exit 0 and write nothing, even with no bun.lock",
    async () => {
      const root = bundleRepository(folder("bundles-"));
      rmSync(join(root, "bun.lock"));
      for (const script of ["build:bundles", "check:bundles"] as const)
        expect(await runScript(root, script)).toEqual({
          exit: 0,
          stdout: "No bundles are listed in package.json.\n",
          stderr: "",
        });
      expect(existsSync(join(root, "tools/greeting/dist"))).toBe(false);
    },
    processWatchdog(3),
  );
});
