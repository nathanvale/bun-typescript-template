import { expect, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  bootstrapCliFixture,
  invokeIn,
  requireSuccess,
  ROOT,
  runCommand,
  runIn,
} from "../../support/bootstrap-cli-fixture.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import {
  testRunFolderVariable,
  testRunProcessVariable,
} from "../../../scripts/test-run.ts";

const temporaryRoot = bootstrapCliFixture();

async function generated(): Promise<string> {
  const destination = join(temporaryRoot(), "test-run-bootstrap");
  requireSuccess(
    await invokeIn(ROOT, { ...inherited(), ...gitEnv }, [
      "--destination",
      destination,
      "--source-packet",
      "https://example.test/spec",
      "--json",
    ]),
    "bootstrap test run specimen",
  );
  requireSuccess(
    await runIn(destination, ["install", "--frozen-lockfile"], {}),
    "install test run specimen",
  );
  return destination;
}

function checkOutsideTestRun(destination: string) {
  return runCommand(destination, [process.execPath, "run", "check"], {
    ...process.env,
    TMPDIR: temporaryRoot(),
    CI: undefined,
    [testRunFolderVariable]: undefined,
    [testRunProcessVariable]: undefined,
  });
}

async function edited(
  path: string,
  edit: (text: string) => string,
  run: () => Promise<void>,
): Promise<void> {
  const original = await readFile(path, "utf8");
  const changed = edit(original);
  if (changed === original)
    throw new Error(`The edit changed nothing in ${path}.`);
  await writeFile(path, changed);
  try {
    await run();
  } finally {
    await writeFile(path, original);
  }
}

test(
  "a generated repository runs its tests through the test run, and bun run check fails when the test script or bunfig.toml drops it",
  async () => {
    const destination = await generated();
    const passed = await runIn(destination, ["run", "test"], {});
    expect(passed.exitCode).toBe(0);
    expect(passed.stderr).not.toContain("Tests left");

    await edited(
      join(destination, "package.json"),
      (text) =>
        text.replace('"test": "bun scripts/test-run.ts"', '"test": "bun test"'),
      async () => {
        const check = await checkOutsideTestRun(destination);
        expect(check.exitCode).not.toBe(0);
        expect(check.stderr).toContain(
          "bun test started without scripts/test-run.ts",
        );
      },
    );

    await edited(
      join(destination, "bunfig.toml"),
      (text) =>
        text.replace(
          '[test]\npreload = ["./tests/support/test-run-folder.ts"]\n',
          "",
        ),
      async () => {
        const check = await checkOutsideTestRun(destination);
        expect(check.exitCode).not.toBe(0);
        expect(check.stderr).toContain(
          "bun test did not load tests/support/test-run-folder.ts",
        );
      },
    );

    const planted = join(destination, "tests/planted-running.test.ts");
    await writeFile(
      planted,
      'import { test } from "bun:test";\nimport { spawn } from "node:child_process";\ntest("leaves a child running", () => {\n  spawn("sleep", ["306"], { detached: true, stdio: "ignore" }).unref();\n});\n',
    );
    const running = await runIn(destination, ["run", "test"], {});
    expect(running.exitCode).toBe(1);
    expect(running.stderr).toContain(
      "Tests left 1 child process(es) running at teardown, and they were stopped:",
    );
    expect(running.stderr).toContain(": sleep 306");
  },
  processWatchdog(12),
);
