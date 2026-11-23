import { expect, test } from "bun:test";
import {
  chmodSync,
  linkSync,
  lstatSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { TemplateUpgradeApplyResult } from "../../../src/template-upgrade-report.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateLintChange,
  invokeTemplateUpgradeMain,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

const SENTINEL_BYTES = "outside both checkouts\n";
const SENTINEL_MODE = 0o640;

function lintFailingBun(lintStep: string) {
  return writeScriptedBun(
    folder,
    "gate-links-bun-",
    `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  mkdir -p node_modules
  exit 0
fi
if [ "$1" = "run" ] && { [ "$2" = "check" ] || [ "$2" = "lint" ]; }; then
  if [ "$2" = "lint" ]; then ${lintStep}; fi
  cat <<'OUT'
src/notes.ts
  2:1  error  Loose source file  repository/no-loose-source-with-subjects

✖ 1 problem (1 error, 0 warnings)
OUT
  exit 1
fi
exit 0
`,
  );
}

function writeSentinel(path: string): void {
  writeFileSync(path, SENTINEL_BYTES);
  chmodSync(path, SENTINEL_MODE);
}

function expectSentinelKept(path: string): void {
  expect(readFileSync(path, "utf8")).toBe(SENTINEL_BYTES);
  expect(lstatSync(path).mode & 0o777).toBe(SENTINEL_MODE);
}

async function lintUpgrade(
  name: string,
  options: {
    readonly ownerChange?: (repo: string) => void;
    readonly lintStep?: (seenConfig: string) => string;
  } = {},
) {
  const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
  const targetCommit = commitTemplateLintChange(templateClone);
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    name,
  );
  options.ownerChange?.(repo);
  const seenConfig = join(folder("gate-links-seen-"), "eslint.config.mjs");
  const { env } = lintFailingBun(
    options.lintStep?.(seenConfig) ??
      `cp eslint.config.mjs ${JSON.stringify(seenConfig)}`,
  );
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const argv = ["apply", "--repository", repo, "--to", targetCommit, "--json"];
  const apply = async () => {
    const run = await invokeTemplateUpgradeMain(stdout, stderr, argv, {
      templateRoot: templateClone,
      env,
    });
    return {
      exitCode: run.exitCode,
      payload: JSON.parse(run.stdout) as TemplateUpgradeApplyResult,
    };
  };
  const templateConfig = git(
    templateClone,
    "show",
    `${targetCommit}:generated-repository/settings/eslint.config.mjs`,
  );
  return { apply, seenConfig, templateConfig };
}

function expectRefusedProbe(
  second: { exitCode: number; payload: TemplateUpgradeApplyResult },
  reason: string,
): void {
  expect(second.exitCode).toBe(1);
  expect(second.payload.status).toBe("check-failed");
  expect(second.payload.failedStep).toBe("bun run check");
  expect(second.payload.checkCommandOutput).toContain(reason);
}

test(
  "the gate check against HEAD copies a plain gate file and still reports gate-adoption-required",
  async () => {
    const { apply, seenConfig, templateConfig } =
      await lintUpgrade("plain-gate-app");

    const first = await apply();

    expect(first.exitCode).toBe(6);
    expect(first.payload).toMatchObject({
      status: "gate-adoption-required",
      gate: "lint",
      gateFiles: ["config/template-rules.mjs", "eslint.config.mjs"],
    });
    expect(readFileSync(seenConfig, "utf8").trimEnd()).toBe(templateConfig);
  },
  processWatchdog(4),
);

test(
  "the gate check against HEAD never writes through a committed gate file that links outside both checkouts",
  async () => {
    const sentinel = join(folder("gate-links-outside-"), "eslint.config.mjs");
    writeSentinel(sentinel);
    const { apply, templateConfig } = await lintUpgrade("linked-gate-app", {
      ownerChange: (repo) => {
        rmSync(join(repo, "eslint.config.mjs"));
        symlinkSync(sentinel, join(repo, "eslint.config.mjs"));
        git(repo, "add", "--", "eslint.config.mjs");
        git(repo, "commit", "--quiet", "-m", "link the lint settings");
      },
    });

    const first = await apply();
    expect(first.payload.conflicts).toEqual(["eslint.config.mjs"]);
    const worktree = first.payload.worktree ?? "";
    rmSync(join(worktree, "eslint.config.mjs"));
    writeFileSync(join(worktree, "eslint.config.mjs"), `${templateConfig}\n`);
    const second = await apply();

    expectSentinelKept(sentinel);
    expectRefusedProbe(second, "eslint.config.mjs is a symbolic link");
  },
  processWatchdog(6),
);

test(
  "the gate check against HEAD never reads a gate file below a worktree folder that links outside both checkouts",
  async () => {
    const outside = folder("gate-links-outside-");
    const sentinel = join(outside, "template-rules.mjs");
    writeSentinel(sentinel);
    const { apply } = await lintUpgrade("linked-folder-app");

    const first = await apply();
    expect(first.exitCode).toBe(6);
    const worktree = first.payload.worktree ?? "";
    rmSync(join(worktree, "config"), { recursive: true });
    symlinkSync(outside, join(worktree, "config"));
    const second = await apply();

    expectSentinelKept(sentinel);
    expectRefusedProbe(
      second,
      "config/template-rules.mjs is below symbolic link config",
    );
  },
  processWatchdog(6),
);

test(
  "the gate check against HEAD never copies a worktree gate file that is a hard link to a file outside both checkouts",
  async () => {
    const sentinel = join(folder("gate-links-outside-"), "eslint.config.mjs");
    writeSentinel(sentinel);
    const { apply } = await lintUpgrade("hard-linked-gate-app");

    const first = await apply();
    expect(first.exitCode).toBe(6);
    const worktree = first.payload.worktree ?? "";
    rmSync(join(worktree, "eslint.config.mjs"));
    linkSync(sentinel, join(worktree, "eslint.config.mjs"));
    const second = await apply();

    expectSentinelKept(sentinel);
    expectRefusedProbe(second, "eslint.config.mjs is a hard link");
  },
  processWatchdog(6),
);

test(
  "the gate check against HEAD stops as check-failed when a gate file it wrote became a hard link while the gate ran",
  async () => {
    const outside = join(folder("gate-links-outside-"), "eslint.config.mjs");
    writeSentinel(outside);
    const { apply } = await lintUpgrade("relinked-gate-app", {
      lintStep: () =>
        `rm eslint.config.mjs; ln ${JSON.stringify(outside)} eslint.config.mjs`,
    });

    const first = await apply();

    expectSentinelKept(outside);
    expectRefusedProbe(
      first,
      "eslint.config.mjs is no longer the regular file with one link",
    );
  },
  processWatchdog(4),
);
