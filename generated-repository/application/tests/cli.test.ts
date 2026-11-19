import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { testFolder } from "./support/test-folder.ts";

const cli = join(import.meta.dir, "../src/cli.ts");

test("status reports that the command-line tool runs, from any folder", () => {
  const elsewhere = testFolder("cli-");
  try {
    const child = Bun.spawnSync(
      [process.execPath, "run", cli, "status", "--json"],
      { cwd: elsewhere, stdout: "pipe", stderr: "pipe" },
    );
    expect({
      exitCode: child.exitCode,
      stderr: child.stderr.toString(),
    }).toEqual({ exitCode: 0, stderr: "" });
    expect(JSON.parse(child.stdout.toString())).toMatchObject({
      result: {
        commandIdentity: "__REPOSITORY_NAME__.status",
        causeCode: "SUCCESS_UNCHANGED",
        data: { ready: true },
      },
    });
  } finally {
    rmSync(elsewhere, { recursive: true });
  }
});
