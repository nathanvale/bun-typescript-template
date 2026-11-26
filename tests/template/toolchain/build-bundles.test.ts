import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
const usage = "Usage: bun scripts/build-bundles.ts [--check]\n";

function runDirect(root: string, args: readonly string[] = []) {
  return spawnBounded([process.execPath, "scripts/build-bundles.ts", ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    processGroup: true,
  });
}

function setBundles(root: string, value: unknown): void {
  const path = join(root, "package.json");
  const manifest: unknown = JSON.parse(readFileSync(path, "utf8"));
  writeFileSync(
    path,
    `${JSON.stringify({ ...Object(manifest), bundles: value }, null, 2)}\n`,
  );
}

function expectFailure(
  run: {
    readonly exit: number;
    readonly stdout: string;
    readonly stderr: string;
  },
  message: string,
) {
  expect({ exit: run.exit, stdout: run.stdout }).toEqual({
    exit: 2,
    stdout: "",
  });
  expect(run.stderr).toStartWith(`build-bundles: ${message}`);
  expect(run.stderr).toContain("Repair: ");
}

const badBundles: ReadonlyArray<readonly [string, unknown]> = [
  ["a string", bundleOutput],
  ["an array", [bundleOutput, bundleEntry]],
  ["an entry that is not a string", { [bundleOutput]: 1 }],
  ["an output that climbs out", { "../escape.mjs": bundleEntry }],
  ["an output inside a climb", { "tools/../../escape.mjs": bundleEntry }],
  ["an absolute output", { "/escape.mjs": bundleEntry }],
  ["an output with a backslash", { "tools\\escape.mjs": bundleEntry }],
  ["an output with a NUL", { "tools/escape\u0000.mjs": bundleEntry }],
  ["an output not ending .mjs", { "tools/greeting/dist/cli.js": bundleEntry }],
  ["an entry not ending .ts", { [bundleOutput]: "tools/greeting/src/main.js" }],
  ["an entry that climbs out", { [bundleOutput]: "../main.ts" }],
];

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

  test(
    "refuses every bundles list that is not plain relative .mjs outputs to .ts entries, and writes nothing",
    async () => {
      const parent = folder("bundles-");
      const root = bundleRepository(join(parent, "repo"));
      for (const [label, value] of badBundles) {
        setBundles(root, value);
        const run = await runScript(root, "build:bundles");
        expect({ label, exit: run.exit, stdout: run.stdout }).toEqual({
          label,
          exit: 2,
          stdout: "",
        });
        expect(run.stderr).toStartWith(
          'build-bundles: package.json "bundles" is not an object from output .mjs paths to entry .ts paths',
        );
        expect({ label, parent: readdirSync(parent) }).toEqual({
          label,
          parent: ["repo"],
        });
        expect(existsSync(join(root, "tools/greeting/dist"))).toBe(false);
        expect(existsSync(join(root, "escape.mjs"))).toBe(false);
      }
    },
    processWatchdog(badBundles.length),
  );

  test(
    "refuses a package.json that is not valid JSON or cannot be read",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      writeFileSync(join(root, "package.json"), "{");
      expectFailure(
        await runDirect(root),
        "package.json cannot be read as JSON: ",
      );
      rmSync(join(root, "package.json"));
      mkdirSync(join(root, "package.json"));
      expectFailure(
        await runDirect(root, ["--check"]),
        "package.json cannot be read as JSON: ",
      );
      expect(existsSync(join(root, bundleOutput))).toBe(false);
    },
    processWatchdog(2),
  );

  test(
    "refuses bundle_kernel_mismatch when package.json pins agent-cli-kernel to anything but a full commit",
    async () => {
      for (const pins of [pinnedCommit.slice(0, 7), "main"]) {
        const root = bundleRepository(folder("bundles-"), { bundles, pins });
        expectRefusal(
          await runScript(root, "build:bundles"),
          "bundle_kernel_mismatch",
          'package.json does not pin dependencies["agent-cli-kernel"] to a full 40-character commit',
        );
        expect(existsSync(join(root, bundleOutput))).toBe(false);
      }
    },
    processWatchdog(2),
  );

  test(
    "refuses an entry that Bun.build cannot bundle into exactly one file",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      writeFileSync(join(root, bundleEntry), "export const = ;\n");
      const broken = await runScript(root, "build:bundles");
      expectFailure(
        broken,
        `Bun.build cannot bundle ${bundleEntry} into one file: `,
      );
      expect(broken.stderr).toContain("Expected identifier");
      writeFileSync(join(root, "tools/greeting/src/logo.png"), "png");
      writeFileSync(
        join(root, bundleEntry),
        'import logo from "./logo.png";\nconsole.log(logo);\n',
      );
      const split = await runScript(root, "build:bundles");
      expectFailure(
        split,
        `Bun.build cannot bundle ${bundleEntry} into one file: 2 outputs.`,
      );
      expect(existsSync(join(root, bundleOutput))).toBe(false);
    },
    processWatchdog(2),
  );

  test(
    "refuses an output path that is a folder or a link, and leaves the link's target unchanged",
    async () => {
      const parent = folder("bundles-");
      const root = bundleRepository(join(parent, "repo"), { bundles });
      const output = join(root, bundleOutput);
      mkdirSync(output, { recursive: true });
      expectFailure(
        await runScript(root, "build:bundles"),
        `${bundleOutput} is not a regular file.`,
      );
      rmSync(output, { recursive: true });
      const target = join(parent, "target.mjs");
      writeFileSync(target, "kept\n");
      symlinkSync(target, output);
      expectFailure(
        await runScript(root, "build:bundles"),
        `${bundleOutput} is not a regular file.`,
      );
      expect(readFileSync(target, "utf8")).toBe("kept\n");
    },
    processWatchdog(2),
  );

  test(
    "refuses any argument but a lone --check with the usage line, and writes nothing",
    async () => {
      const root = bundleRepository(folder("bundles-"), { bundles });
      for (const args of [
        ["--bogus"],
        ["--check", "--check"],
        ["--check", "x"],
      ])
        expect(await runDirect(root, args)).toEqual({
          exit: 2,
          stdout: "",
          stderr: usage,
        });
      expect(existsSync(join(root, bundleOutput))).toBe(false);
    },
    processWatchdog(3),
  );
});
