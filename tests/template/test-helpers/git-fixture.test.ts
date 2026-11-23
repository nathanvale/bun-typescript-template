import { expect, test } from "bun:test";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commit, git, initRepository } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import {
  bootstrapRow,
  kernelRowFixture,
} from "../../support/recipe-fixture.ts";

const folder = ownedFolders();
const run = kernelRowFixture();

test("the template git fixture commits with maintenance.auto false and gc.auto 0", () => {
  const repo = join(folder("git-fixture-"), "repo");
  initRepository(repo);
  commit(repo, "initial", { "note.txt": "ok\n" });
  expect({
    maintenanceAuto: git(repo, "config", "--get", "maintenance.auto"),
    gcAuto: git(repo, "config", "--get", "gc.auto"),
  }).toEqual({
    maintenanceAuto: "false",
    gcAuto: "0",
  });
});

test(
  "the shipped git fixture test passes in a bootstrapped generated repository",
  async () => {
    const { destination, request } = run();
    await bootstrapRow(request);
    const result = await spawnBounded(
      [process.execPath, "test", "tests/git-fixture.test.ts"],
      { cwd: destination, processGroup: true },
    );
    expect({
      exit: result.exit,
      passed: result.stderr.includes("\n 1 pass\n 0 fail\n"),
    }).toEqual({ exit: 0, passed: true });
  },
  processWatchdog(1),
);
