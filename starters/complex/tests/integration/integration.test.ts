import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const roots: string[] = [];

function invoke(state: string, ...args: string[]) {
  const result = Bun.spawnSync(
    [process.execPath, "run", "src/cli.ts", ...args],
    {
      cwd: ROOT,
      env: { ...process.env, CLI_EXAMPLE_STATE: state },
      stderr: "pipe",
      stdout: "pipe",
    },
  );
  return {
    exitCode: result.exitCode,
    stderr: result.stderr.toString(),
    stdout: result.stdout.toString(),
  };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { force: true, recursive: true })),
  );
});

test("preview preserves state and apply writes exactly once", async () => {
  const root = await mkdtemp(join(tmpdir(), "complex-starter-"));
  roots.push(root);
  const state = join(root, "state.json");
  const preview = invoke(
    state,
    "set",
    "--value",
    "enabled",
    "--preview",
    "--json",
  );
  expect(preview.exitCode).toBe(0);
  expect(await Bun.file(state).exists()).toBe(false);
  expect(JSON.parse(preview.stdout).result.transactionState).toBe("unchanged");

  const apply = invoke(state, "set", "--value", "enabled", "--json");
  expect(apply.exitCode).toBe(0);
  expect(apply.stderr).toBe("");
  expect(JSON.parse(apply.stdout).result.transactionState).toBe("completed");
  expect(JSON.parse(await readFile(state, "utf8"))).toEqual({
    value: "enabled",
  });
});
