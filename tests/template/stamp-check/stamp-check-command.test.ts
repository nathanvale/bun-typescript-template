import { describe, expect, test } from "bun:test";
import { appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { spawnBounded } from "../../support/process.ts";
import {
  stampedFolder,
  writeStampRecord,
} from "../../support/stamped-folder-fixture.ts";

const stampCheck = resolve(import.meta.dir, "../../../src/stamp-check.ts");
const owned = ownedFolders();

async function runIn(folder: string) {
  const child = await spawnBounded([process.execPath, "run", stampCheck], {
    cwd: folder,
    processGroup: true,
  });
  return {
    exit: child.exit,
    stderr: child.stderr,
    verdict: JSON.parse(child.stdout) as unknown,
  };
}

describe("the stamp check run as a command in a folder", () => {
  test("prints an intact verdict and exits 0", async () => {
    const folder = owned("stamp-check-command-");
    const record = stampedFolder(folder);
    writeStampRecord(folder, record);
    expect(await runIn(folder)).toEqual({
      exit: 0,
      stderr: "",
      verdict: {
        status: "intact",
        commit: record.kernel.commit,
        addons: ["beta"],
        fileCount: 5,
      },
    });
  });

  test("prints a broken verdict naming the file and exits 1", async () => {
    const folder = owned("stamp-check-command-");
    writeStampRecord(folder, stampedFolder(folder));
    appendFileSync(join(folder, "lib/core/index.ts"), " ");
    expect(await runIn(folder)).toEqual({
      exit: 1,
      stderr: "",
      verdict: {
        status: "broken",
        findings: [
          {
            kind: "modified",
            path: "lib/core/index.ts",
            detail: "its bytes are not the stamped ones.",
          },
        ],
      },
    });
  });

  test("prints an unstamped verdict and exits 1, so a check command cannot pass without its stamp record", async () => {
    const folder = owned("stamp-check-command-");
    stampedFolder(folder);
    expect(await runIn(folder)).toEqual({
      exit: 1,
      stderr: "",
      verdict: { status: "unstamped" },
    });
  });
});
