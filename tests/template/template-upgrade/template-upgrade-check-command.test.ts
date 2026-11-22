import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git, gitEnv } from "../../support/git-fixture.ts";
import { siblingKernel } from "../../support/kernel-sibling.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

function writeScriptedBun(prefix: string, script: string) {
  const binFolder = folder(prefix);
  const ledger = join(binFolder, "calls.log");
  const bunPath = join(binFolder, "bun");
  writeFileSync(bunPath, script.replace("__LEDGER__", JSON.stringify(ledger)));
  chmodSync(bunPath, 0o755);
  return {
    binFolder,
    ledger,
    env: {
      ...process.env,
      ...gitEnv,
      KERNEL_REPOSITORY: siblingKernel(),
      PATH: `${binFolder}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

function commitTemplateLintChange(templateClone: string): string {
  const eslintPath = join(
    templateClone,
    "generated-repository/settings/eslint.config.mjs",
  );
  writeFileSync(eslintPath, `${readFileSync(eslintPath, "utf8")}\n`);
  const templateRulesPath = join(templateClone, "config/template-rules.mjs");
  writeFileSync(
    templateRulesPath,
    `${readFileSync(templateRulesPath, "utf8")}\n`,
  );
  git(
    templateClone,
    "add",
    "--",
    "generated-repository/settings/eslint.config.mjs",
    "config/template-rules.mjs",
  );
  git(
    templateClone,
    "commit",
    "--quiet",
    "-m",
    "template change without package.json change",
  );
  return git(templateClone, "rev-parse", "HEAD");
}

test(
  "always runs bun install before bun run check even without a package.json change, and commits a bun.lock updated by install",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "no-package-change-app",
    );
    const targetCommit = commitTemplateLintChange(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const { ledger, env } = writeScriptedBun(
      "scripted-bun-no-pkg-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  printf 'updated-by-install\\n' >> bun.lock
  exit 0
fi
if [ "$1" = "run" ] && [ "$2" = "check" ]; then
  if ! grep -q '^updated-by-install$' bun.lock; then
    echo "eslint: command not found" >&2
    exit 127
  fi
  exit 0
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(run.exitCode).toBe(0);
    expect(JSON.parse(run.stdout)).toMatchObject({ status: "applied", branch });
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run check",
    ]);
    expect(git(repo, "show", `${branch}:bun.lock`)).toContain(
      "updated-by-install",
    );
  },
  processWatchdog(4),
);

test(
  "runs bun install and bun run check when --no-check is omitted, and reports check-failed leaving the worktree",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "checked-app",
    );
    const failFlag = join(folder("scripted-bun-flag-"), "fail-check");
    writeFileSync(failFlag, "1\n");
    const { ledger, env } = writeScriptedBun(
      "scripted-bun-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "run" ] && [ "$2" = "check" ] && [ -f ${JSON.stringify(failFlag)} ]; then
  echo "planted check failure" >&2
  exit 1
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const args = [
      "apply",
      "--repository",
      repo,
      "--to",
      targetCommit,
      "--json",
    ];
    const runtime = { templateRoot: templateClone, env };
    const expectedWorktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );

    const failRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(failRun.exitCode).toBe(1);
    expect(JSON.parse(failRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
      worktree: expectedWorktree,
    });
    expect(existsSync(expectedWorktree)).toBe(true);
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
      "run check",
    ]);

    rmSync(failFlag);
    const passRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(passRun.exitCode).toBe(0);
    expect(JSON.parse(passRun.stdout)).toMatchObject({ status: "applied" });
    expect(existsSync(expectedWorktree)).toBe(false);
  },
  processWatchdog(4),
);

test(
  "production entry src/template-upgrade.ts runs as a CLI process for --help and refusals",
  async () => {
    const help = await spawnBounded(
      [process.execPath, "run", "src/template-upgrade.ts", "--help"],
      { cwd: ROOT, processGroup: true },
    );
    expect(help.exit).toBe(0);
    expect(help.stdout).toContain("bun run upgrade plan --repository PATH");

    const nonRepo = folder("cli-non-repo-");
    const refused = await spawnBounded(
      [
        process.execPath,
        "run",
        "src/template-upgrade.ts",
        "plan",
        "--repository",
        nonRepo,
        "--json",
      ],
      { cwd: ROOT, processGroup: true },
    );
    expect(refused.exit).toBe(2);
    expect(refused.stdout).toBe("");
    expect(JSON.parse(refused.stderr)).toMatchObject({
      schemaVersion: 1,
      status: "refused",
      error: { code: "not_git_repository" },
    });
  },
  processWatchdog(2),
);
