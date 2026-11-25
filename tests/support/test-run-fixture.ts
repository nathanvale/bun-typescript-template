import {
  type TestRunEnvironment,
  testRunFolderVariable,
} from "../../scripts/test-run.ts";
import { testRunFiles, write } from "./fixture-files.ts";

export function outsideTestRun(
  temp: string,
  extra: TestRunEnvironment = {},
): Record<string, string | undefined> {
  return {
    ...process.env,
    STATE_TEST_DIR: undefined,
    TMPDIR: temp,
    TMP: undefined,
    TEMP: undefined,
    CI: undefined,
    npm_lifecycle_event: undefined,
    [testRunFolderVariable]: undefined,
    ...extra,
  };
}

export function testRunSpecimen(
  folder: (prefix: string) => string,
  tests: Readonly<Record<string, string>>,
): string {
  const root = folder("test-run-specimen-");
  for (const [path, text] of Object.entries({ ...testRunFiles(), ...tests }))
    write(root, path, text);
  return root;
}
