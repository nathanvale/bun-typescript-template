import { expect } from "bun:test";
import { chmodSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join } from "node:path";
import { gitOutput } from "./git-fixture.ts";
import type { streamWrites } from "./stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
  writeScriptedBun,
} from "./template-upgrade-fixture.ts";

export type FolderFactory = (prefix: string) => string;
export type StreamCaptureFactory = ReturnType<typeof streamWrites>;

export interface RefusalPayload {
  readonly status: string;
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly repair: string;
    readonly retrySafe: boolean;
  };
}

export interface RecoverPayload {
  readonly schemaVersion: number;
  readonly action: string;
  readonly status: string;
  readonly targetCommit: string;
  readonly worktree: string;
  readonly branch: string;
  readonly commit: string;
  readonly patchPath: string;
  readonly rerunCommand: string;
}

export function parseRefusal(stderr: string): RefusalPayload {
  return JSON.parse(stderr) as RefusalPayload;
}

export function parseRecover(stdout: string): RecoverPayload {
  return JSON.parse(stdout) as RecoverPayload;
}

export function recoverJsonArgs(repo: string, targetCommit: string): string[] {
  return ["recover", "--repository", repo, "--to", targetCommit, "--json"];
}

export function recoverDiff(repo: string, from: string, to: string): string {
  return gitOutput(
    repo,
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--binary",
    from,
    to,
  );
}

export function writeCustomGit(
  folder: FolderFactory,
  prefix: string,
  buildBody: (realGit: string, ledger: string) => string,
) {
  const binFolder = folder(prefix);
  const ledger = join(binFolder, "git-calls.log");
  const realGit = Bun.which("git") ?? "git";
  const gitPath = join(binFolder, "git");
  writeFileSync(gitPath, buildBody(realGit, ledger));
  chmodSync(gitPath, 0o755);
  return {
    ledger,
    env: {
      ...templateUpgradeEnv(),
      PATH: `${binFolder}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

export function writeScriptedGit(
  folder: FolderFactory,
  prefix: string,
  failCondition: string,
  errorMessage: string,
) {
  return writeCustomGit(
    folder,
    prefix,
    (realGit, ledger) => `#!/bin/sh
echo "$*" >> ${JSON.stringify(ledger)}
if ${failCondition}; then
  echo ${JSON.stringify(errorMessage)} >&2
  exit 1
fi
exec ${JSON.stringify(realGit)} "$@"
`,
  );
}

export async function createFailedApplyWorktree(
  folder: FolderFactory,
  captureStream: StreamCaptureFactory,
  name: string,
  options: { readonly customRepoPath?: string } = {},
) {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateLintChange(templateClone);
  const target7 = targetCommit.slice(0, 7);
  const bootstrappedRepo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    name,
  );
  let repo = bootstrappedRepo;
  if (options.customRepoPath !== undefined) {
    mkdirSync(dirname(options.customRepoPath), { recursive: true });
    renameSync(bootstrappedRepo, options.customRepoPath);
    repo = options.customRepoPath;
  }
  const failCheckBun = writeScriptedBun(
    folder,
    "scripted-bun-recover-fail-",
    `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  echo "planted check failure" >&2
  exit 1
fi
exit 0
`,
  );
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const failedRun = await invokeTemplateUpgradeMain(
    stdout,
    stderr,
    ["apply", "--repository", repo, "--to", targetCommit, "--json"],
    { templateRoot: templateClone, env: failCheckBun.env },
  );
  expect(failedRun.exitCode).toBe(1);
  const failedPayload = JSON.parse(failedRun.stdout) as {
    readonly status: string;
    readonly checkCommandOutput?: string;
  };
  expect(failedPayload.status).toBe("check-failed");
  expect(failedPayload.checkCommandOutput).toContain("planted check failure");
  const targetWorktree = join(
    repo,
    ".worktrees",
    `template-upgrade-${target7}`,
  );
  const branch1 = `template-upgrade/${target7}-failed-1`;
  const patch1 = join(
    repo,
    ".worktrees",
    `template-upgrade-${target7}-failed-1.patch`,
  );
  const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
  const recoverArgs = recoverJsonArgs(repo, targetCommit);
  return {
    templateClone,
    baseCommit,
    targetCommit,
    target7,
    repo,
    targetWorktree,
    branch1,
    patch1,
    recoverArgs,
    stdout,
    stderr,
    failCheckBun,
    runtime,
    runRecover: (env?: Readonly<Record<string, string | undefined>>) =>
      invokeTemplateUpgradeMain(
        stdout,
        stderr,
        recoverArgs,
        env === undefined ? runtime : { templateRoot: templateClone, env },
      ),
  };
}
