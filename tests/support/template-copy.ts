import { cpSync, rmSync } from "node:fs";
import { join } from "node:path";
import { kernelPinFile } from "../../src/kernel-pin.ts";
import { ROOT } from "./bootstrap-cli-fixture.ts";
import {
  commit,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "./git-fixture.ts";
import { spawnBounded } from "./process.ts";

const copied = [
  "src",
  "scripts/change-notes.ts",
  "scripts/process-runner.ts",
  "scripts/kernel-trial.ts",
  "scripts/kernel-trial-command.ts",
  "scripts/pin-move.ts",
  "scripts/pin-move-report.ts",
  "scripts/pin-move-repository.ts",
  "scripts/pin-verification.ts",
  "generated-repository",
  "config",
  "tests/support/test-folder.ts",
  kernelPinFile,
];

export function templateCopy(folder: string, omit: readonly string[] = []) {
  const copy = join(folder, "template");
  for (const path of copied)
    cpSync(join(ROOT, path), join(copy, path), { recursive: true });
  for (const path of omit) rmSync(join(copy, path), { force: true });
  initRepository(copy);
  git(copy, "add", "--all");
  commit(copy, "the template copy", {});
  return copy;
}

export async function callInCopy(
  copy: string,
  module: string,
  exported: string,
  argument: unknown,
  boundMilliseconds?: number,
  env: Readonly<Record<string, string>> = {},
) {
  const script = `const called = (await import(${JSON.stringify(join(copy, module))}))[${JSON.stringify(exported)}];
try {
  process.stdout.write(JSON.stringify({ returned: await called(JSON.parse(process.env.CALL_ARGUMENT)) }));
} catch (error) {
  process.stdout.write(JSON.stringify({ refused: { code: error.code, message: error.message } }));
}`;
  const run = await spawnBounded([process.execPath, "--eval", script], {
    cwd: copy,
    env: {
      ...inherited(),
      ...gitEnv,
      ...env,
      CALL_ARGUMENT: JSON.stringify(argument),
    },
    ...(boundMilliseconds === undefined ? {} : { boundMilliseconds }),
  });
  if (run.exit !== 0)
    throw new Error(
      `The call in the template copy exited ${run.exit}.\n${run.stderr}`,
    );
  const printed: unknown = JSON.parse(run.stdout);
  return printed;
}
