import { afterAll, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { testRunFiles } from "../../support/fixture-files.ts";

const repository = join(import.meta.dir, "../../..");
const projects: string[] = [];

afterAll(() => {
  for (const project of projects) rmSync(project, { recursive: true });
});

function write(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

type PackageManifest = { readonly packageManager?: string };

function linkKernel(root: string): void {
  mkdirSync(join(root, "node_modules"), { recursive: true });
  symlinkSync(
    join(repository, "node_modules/agent-cli-kernel"),
    join(root, "node_modules/agent-cli-kernel"),
  );
  symlinkSync(
    join(repository, "node_modules/@logtape"),
    join(root, "node_modules/@logtape"),
  );
  symlinkSync(
    join(repository, "node_modules/@changesets"),
    join(root, "node_modules/@changesets"),
  );
}

function project(
  manifest: PackageManifest,
  files: Record<string, string> = {},
  withKernel = true,
) {
  const root = mkdtempSync(join(tmpdir(), "doctor-"));
  projects.push(root);
  cpSync(join(repository, "src"), join(root, "src"), { recursive: true });
  cpSync(join(repository, "scripts"), join(root, "scripts"), {
    recursive: true,
  });
  copyFileSync(
    join(repository, "kernel-pin.json"),
    join(root, "kernel-pin.json"),
  );
  write(root, "package.json", JSON.stringify(manifest));
  for (const [path, content] of Object.entries({
    ...testRunFiles(),
    ...files,
  }))
    write(root, path, content);
  if (withKernel) linkKernel(root);
  return root;
}

function installedToolchain(lintVersion: string): Record<string, string> {
  return {
    "node_modules/typescript-eslint/package.json":
      '{"name":"typescript-eslint","main":"index.js"}',
    "node_modules/typescript-eslint/index.js": "module.exports = {};",
    "node_modules/typescript/package.json": `{"name":"typescript","version":"${lintVersion}","main":"index.js"}`,
    "node_modules/typescript/index.js": `module.exports = { version: "${lintVersion}" };`,
    "node_modules/@typescript/native/package.json": '{"version":"7.1.0-beta"}',
    "node_modules/fallow-type-aware/package.json":
      '{"name":"fallow-type-aware","version":"3.43.2"}',
    "node_modules/fallow-type-aware/node_modules/typescript/package.json":
      '{"version":"7.0.2"}',
    "node_modules/.bin/tsc": "#!/bin/sh\necho 'Version 7.1.0-beta'\n",
  };
}

type FallowCheck = {
  readonly id: string;
  readonly status: string;
  readonly message: string;
  readonly remediation?: {
    readonly command: string;
    readonly cwd: string;
    readonly mutating: boolean;
  };
};

type FallowDoctorReport = {
  readonly status: string;
  readonly checks: readonly FallowCheck[];
};

function fallowDoctor(
  report: FallowDoctorReport | string,
  exitCode = 0,
): string {
  const body = typeof report === "string" ? report : JSON.stringify(report);
  return `#!/bin/sh\ncat <<'REPORT'\n${body}\nREPORT\nexit ${exitCode}\n`;
}

const ready = { status: "pass", checks: [] };

function withToolchain(
  lintVersion: string,
  files: Record<string, string> = {},
  fallow: string | null = fallowDoctor(ready),
) {
  const installed = installedToolchain(lintVersion);
  const root = project(
    { packageManager: `bun@${Bun.version}` },
    {
      ...(fallow === null
        ? installed
        : { ...installed, "node_modules/.bin/fallow": fallow }),
      ...files,
    },
  );
  chmodSync(join(root, "node_modules/.bin/tsc"), 0o755);
  if (fallow !== null) chmodSync(join(root, "node_modules/.bin/fallow"), 0o755);
  return root;
}

function run(root: string, script: string, args: string[] = [], cwd = root) {
  const stateHome = join(root, ".xdg-state");
  mkdirSync(stateHome, { recursive: true });
  const result = Bun.spawnSync(
    [process.execPath, join(root, script), ...args],
    {
      cwd,
      env: { ...process.env, XDG_STATE_HOME: stateHome, NO_COLOR: "1" },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
    lines: result.stdout.toString().split("\n"),
  };
}

const doctor = "src/cli.ts";
const doctorArgs = ["doctor"];
const testArea = "scripts/test-area.ts";

describe("doctor", () => {
  function bunRepair(pin: string) {
    const result = run(
      project({ packageManager: `bun@${pin}` }),
      doctor,
      doctorArgs,
    );
    const line = result.lines.find((entry) => entry.startsWith("FAIL bun: "));
    return {
      exitCode: result.exitCode,
      line,
      repair: line?.split("Repair: ")[1],
    };
  }

  test.each([
    ["older than", "99.0.0"],
    ["newer than", "0.0.1"],
  ])(
    "a running Bun %s the pin fails, naming both versions and the repair",
    (_order, pin) => {
      const { exitCode, line } = bunRepair(pin);

      expect(exitCode).toBe(3);
      expect(line).toBe(
        `FAIL bun: found Bun ${Bun.version}, pinned ${pin}. Repair: run each command as mise exec bun@${pin} -- <command>. If mise reports bun@${pin} missing, run mise install bun@${pin} first. In a hosted check, set bun-version: ${pin} on setup-bun.`,
      );
    },
  );

  test.each([
    [
      "the pinned Bun is installed and another is first on PATH",
      "run each command as mise exec bun@0.0.1 -- <command>.",
    ],
    [
      "the pinned Bun is not installed",
      "If mise reports bun@0.0.1 missing, run mise install bun@0.0.1 first.",
    ],
    [
      "the job runs in a hosted check",
      "In a hosted check, set bun-version: 0.0.1 on setup-bun.",
    ],
  ])("the Bun repair covers the case where %s", (_case, route) => {
    expect(bunRepair("0.0.1").repair).toContain(route);
  });

  test("every bun command in the Bun repair runs through the pinned Bun", () => {
    const { repair } = bunRepair("0.0.1");

    expect(repair).not.toContain("new shell");
    expect(repair?.match(/(?<!-- )\bbun (install|run|test|x)\b/g)).toBeNull();
  });

  test("a corepack pin with a hash suffix compares only its version", () => {
    const result = run(
      project({ packageManager: `bun@${Bun.version}+sha512.abc` }),
      doctor,
      doctorArgs,
    );

    expect(result.lines).toContain(
      `ok bun: Bun ${Bun.version} matches the toolchain pin.`,
    );
  });

  test.each([
    ["missing", {}],
    ["malformed", { packageManager: "npm@10.0.0" }],
  ])("a %s pin fails with a repair", (_kind, manifest) => {
    const result = run(project(manifest), doctor, doctorArgs);

    expect(result.exitCode).toBe(3);
    expect(result.lines).toContain(
      'FAIL bun: package.json has no toolchain pin. Repair: add "packageManager": "bun@<version>" to package.json.',
    );
  });

  test("the pinned Bun without node_modules fails with the install repair", () => {
    const result = run(
      project({ packageManager: `bun@${Bun.version}` }, {}, false),
      doctor,
      doctorArgs,
    );

    expect(result.exitCode).toBe(1);
    expect(result.stderr.trimEnd()).toContain(
      "Repair: bun install --frozen-lockfile.",
    );
  });

  test("an empty node_modules fails on one toolchain line ending in the repair", () => {
    const result = run(
      project(
        { packageManager: `bun@${Bun.version}` },
        { "node_modules/.keep": "" },
      ),
      doctor,
      doctorArgs,
    );

    expect(result.exitCode).toBe(3);
    const toolchainLines = result.lines.filter((line) =>
      line.startsWith("FAIL toolchain: "),
    );
    expect(toolchainLines).toHaveLength(1);
    expect(toolchainLines[0]).toEndWith(
      " Repair: bun install --frozen-lockfile.",
    );
  });

  test("a drifted lint backend fails the toolchain check", () => {
    const result = run(withToolchain("6.0.3"), doctor, doctorArgs);

    expect(result.exitCode).toBe(3);
    expect(result.lines).toContain(
      "FAIL toolchain: The installed lint, compiler and semantic backends do not match the accepted toolchain. Repair: bun install --frozen-lockfile.",
    );
  });

  test("the accepted toolchain passes from any working directory", () => {
    const root = withToolchain("6.0.2");
    const result = run(root, doctor, doctorArgs, join(root, "scripts"));

    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain(
      `ok bun: Bun ${Bun.version} matches the toolchain pin.`,
    );
    expect(result.lines).toContain(
      "ok toolchain: node_modules resolves the accepted lint, compiler and semantic backends.",
    );
    expect(result.lines).toContain("ok fallow: fallow doctor passes.");
  });

  test("a fallow doctor warning is reported with its repair and does not fail", () => {
    const report = {
      status: "warn",
      checks: [
        {
          id: "root",
          status: "pass",
          message: "Project root is an accessible directory.",
        },
        {
          id: "cache",
          status: "warn",
          message:
            "Extraction cache would not be reused: cache format version changed",
          remediation: {
            command: "fallow dead-code --quiet",
            cwd: ".",
            mutating: false,
          },
        },
      ],
    };
    const result = run(
      withToolchain("6.0.2", {}, fallowDoctor(report)),
      doctor,
      doctorArgs,
    );

    expect(result.exitCode).toBe(0);
    expect(result.lines).toContain(
      "WARN fallow: cache: Extraction cache would not be reused: cache format version changed. Repair: run fallow dead-code --quiet from the repository root.",
    );
  });

  test("a project fallow doctor calls not ready fails on the failing check", () => {
    const report = {
      status: "fail",
      checks: [
        { id: "cache", status: "warn", message: "Cache is cold." },
        {
          id: "config",
          status: "fail",
          message: "The config file .fallowrc.json could not be parsed.",
        },
      ],
    };
    const result = run(
      withToolchain("6.0.2", {}, fallowDoctor(report, 2)),
      doctor,
      doctorArgs,
    );

    expect(result.exitCode).toBe(3);
    expect(result.lines).toContain(
      "FAIL fallow: config: The config file .fallowrc.json could not be parsed. Repair: run node_modules/.bin/fallow doctor for the details.",
    );
  });

  test("fallow doctor output that is not a readiness report fails", () => {
    const result = run(
      withToolchain("6.0.2", {}, fallowDoctor("error: unknown command", 2)),
      doctor,
      doctorArgs,
    );

    expect(result.exitCode).toBe(3);
    expect(result.lines).toContain(
      "FAIL fallow: fallow doctor exited 2 without a readiness report. Repair: bun install --frozen-lockfile, then run node_modules/.bin/fallow doctor to read its error.",
    );
  });

  test("a run with a FAIL line ends on the line that says when the repair is done", () => {
    const result = run(
      project({ packageManager: `bun@${Bun.version}` }),
      doctor,
      doctorArgs,
    );

    expect(result.exitCode).toBe(3);
    expect(result.lines).toContain("Done when bun run doctor passes.");
  });

  test("a run with no FAIL line does not say when a repair is done", () => {
    const result = run(withToolchain("6.0.2"), doctor, doctorArgs);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("Done when");
  });

  test("an installed toolchain without fallow fails with the install repair", () => {
    const result = run(withToolchain("6.0.2", {}, null), doctor, doctorArgs);

    expect(result.exitCode).toBe(3);
    expect(result.lines).toContain(
      "FAIL fallow: node_modules/.bin/fallow is missing. Repair: bun install --frozen-lockfile.",
    );
  });
});

describe("test:area", () => {
  const declared = [
    { name: "template", folder: "tests", holds: "files" },
    {
      name: "kernel",
      folder: "tests/kernel",
      holds: "files",
      subfolders: true,
    },
  ];
  const description = (testAreas: object[]) =>
    JSON.stringify({
      web: "https://github.com/owner/fixture",
      checkCommitsSince: "0123456789abcdef0123456789abcdef01234567",
      testAreas,
    });
  const probe = {
    "repository.json": description(declared),
    "tests/kernel/probe/probe.test.ts":
      'import { test } from "bun:test";\ntest("chosen case", () => {});\ntest("other case", () => {});\n',
    "tests/kernel/probe-seam.test.ts":
      'import { test } from "bun:test";\ntest("chosen seam case", () => {});\n',
    "tests/first.test.ts":
      'import { test } from "bun:test";\ntest("first root case", () => {});\n',
    "tests/second.test.ts":
      'import { test } from "bun:test";\ntest("second root case", () => {});\n',
  };

  test("an unknown area exits 2 listing the areas found on disk from any working directory", () => {
    const root = withToolchain("6.0.2", probe);
    const result = run(root, testArea, ["nope"], join(root, "scripts"));

    expect(result.exitCode).toBe(2);
    expect(result.stderr).toBe(
      'Usage: bun run test:area <area> [bun test options]. Unknown area "nope". Valid areas: kernel, probe, template.\n',
    );
  });

  test("an area runs only its own folder and passes options to bun test", () => {
    const result = run(withToolchain("6.0.2", probe), testArea, [
      "probe",
      "-t",
      "chosen",
    ]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(" 1 pass\n");
    expect(result.stderr).toContain(" 1 filtered out\n");
    expect(result.stderr).toContain("Ran 1 test across 1 file.");
  });

  test("a declared area that holds no test file fails, naming it, and runs nothing", () => {
    const root = withToolchain("6.0.2", {
      ...probe,
      "repository.json": description([
        ...declared,
        { name: "lost", folder: "tests/lost", holds: "folder" },
      ]),
    });
    const result = run(root, testArea, ["template"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json has test areas with no test file: lost (tests/lost). Repair: restore their tests, or remove them from testAreas.\n",
    );
  });

  test("two declared areas with one name fail, naming both folders, and run nothing", () => {
    const root = withToolchain("6.0.2", {
      ...probe,
      "repository.json": description([
        ...declared,
        { name: "template", folder: "tests/more", holds: "folder" },
      ]),
      "tests/more/more.test.ts":
        'import { test } from "bun:test";\ntest("more case", () => {});\n',
    });

    const result = run(root, testArea, ["kernel"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json gives one test area name to several folders: template (tests, tests/more). Repair: rename an area in testAreas, or a subfolder.\n",
    );
  });

  test("a subfolder named like a declared area fails, naming both folders, and runs nothing", () => {
    const root = withToolchain("6.0.2", {
      ...probe,
      "tests/kernel/template/template.test.ts":
        'import { test } from "bun:test";\ntest("subfolder case", () => {});\n',
    });

    const result = run(root, testArea, ["kernel"]);

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe(
      "repository.json gives one test area name to several folders: template (tests, tests/kernel/template). Repair: rename an area in testAreas, or a subfolder.\n",
    );
  });

  test("an area whose test files sit only in its subfolders is not empty, and each subfolder runs", () => {
    const root = withToolchain("6.0.2", {
      ...probe,
      "repository.json": description([
        ...declared,
        {
          name: "nested",
          folder: "tests/nested",
          holds: "files",
          subfolders: true,
        },
      ]),
      "tests/nested/deep/deep.test.ts":
        'import { test } from "bun:test";\ntest("deep case", () => {});\n',
    });
    const result = run(root, testArea, ["deep"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain("Ran 1 test across 1 file.");
  });

  test("the template area runs only the test files directly under tests", () => {
    const result = run(withToolchain("6.0.2", probe), testArea, ["template"]);

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain(" 2 pass\n");
    expect(result.stderr).toContain("Ran 2 tests across 2 files.");
  });
});
