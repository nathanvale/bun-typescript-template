import { expect, test } from "bun:test";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { git, gitFixture } from "./support/git-fixture.ts";

test("gitFixture commits with maintenance.auto false and gc.auto 0", () => {
  const root = gitFixture("git-fixture-");
  try {
    writeFileSync(join(root, "note.txt"), "ok\n");
    git(root, "add", "--", "note.txt");
    git(root, "commit", "--quiet", "-m", "initial");
    expect({
      maintenanceAuto: git(root, "config", "--get", "maintenance.auto"),
      gcAuto: git(root, "config", "--get", "gc.auto"),
    }).toEqual({
      maintenanceAuto: "false",
      gcAuto: "0",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
