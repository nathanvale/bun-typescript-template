import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testRunFolderVariable } from "../../scripts/test-run.ts";

export function testFolder(prefix: string): string {
  const parent =
    process.env[testRunFolderVariable] ||
    process.env.STATE_TEST_DIR ||
    tmpdir();
  return realpathSync.native(mkdtempSync(join(parent, prefix)));
}
