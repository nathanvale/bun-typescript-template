import { expect, test } from "bun:test";
import {
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { runJsonFormatStep } from "../../../src/template-upgrade-json-format.ts";
import type { TemplateUpgradeApplyResult } from "../../../src/template-upgrade-report.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  prepareFastInstallBun,
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

const SETTINGS = "generated-repository/settings";
const ONE_ENTRY = '"entry": ["tests/cli.test.ts"]';
const TWO_ENTRIES = '"entry": ["tests/cli.test.ts", "tests/skills.test.ts"]';
const AUDIT_BASELINES =
  '"cssDeep": false,\n    "deadCodeBaseline": "fallow-dead-code-recorded-hits.json",\n    "dupesBaseline": "fallow-duplicates-recorded-hits.json",\n    "healthBaseline": "fallow-health-recorded-hits.json"\n';
const SKILLS_TEST =
  'import { expect, test } from "bun:test";\n\ntest("skills entry runs", () => {\n  expect([1, 2]).toHaveLength(2);\n});\n';
const SPLIT_EXCLUDE =
  '  "exclude": [\n    "node_modules",\n    "dist"\n  ]\n}\n';

const LINKED_BIOME_BUN = `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  mkdir -p node_modules/.bin
  ln -s ${JSON.stringify(join(ROOT, "node_modules/.bin/biome"))} node_modules/.bin/biome
fi
exit 0
`;

function replaced(text: string, from: string, to: string): string {
  if (!text.includes(from)) {
    throw new Error(`fixture text no longer holds ${JSON.stringify(from)}`);
  }
  return text.replace(from, to);
}

function commitSettingsUpgrade(
  templateClone: string,
  targetEdits: Readonly<Record<string, (text: string) => string>>,
): { readonly baseCommit: string; readonly targetCommit: string } {
  const fallowPath = join(templateClone, SETTINGS, ".fallowrc.json");
  const fallowText = readFileSync(fallowPath, "utf8");
  writeFileSync(
    fallowPath,
    replaced(
      replaced(fallowText, AUDIT_BASELINES, '"cssDeep": false\n'),
      '"boundary-violation": "error"',
      '"boundary-violation": "off"',
    ),
  );
  git(templateClone, "add", "--", `${SETTINGS}/.fallowrc.json`);
  git(templateClone, "commit", "--quiet", "-m", "template before audit");
  const baseCommit = git(templateClone, "rev-parse", "HEAD");
  writeFileSync(fallowPath, fallowText);
  for (const [file, edit] of Object.entries(targetEdits)) {
    const path = join(templateClone, SETTINGS, file);
    writeFileSync(path, edit(readFileSync(path, "utf8")));
  }
  git(
    templateClone,
    "add",
    "--",
    `${SETTINGS}/.fallowrc.json`,
    ...Object.keys(targetEdits).map((file) => `${SETTINGS}/${file}`),
  );
  git(templateClone, "commit", "--quiet", "-m", "template adds audit");
  return { baseCommit, targetCommit: git(templateClone, "rev-parse", "HEAD") };
}

async function addSkillsEntry(
  templateClone: string,
  baseCommit: string,
  name: string,
  extra: Readonly<Record<string, string>> = {},
): Promise<string> {
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    name,
  );
  commitIn(repo, "add a skills test entry", {
    ".fallowrc.json": replaced(
      readFileSync(join(repo, ".fallowrc.json"), "utf8"),
      ONE_ENTRY,
      TWO_ENTRIES,
    ),
    "tests/skills.test.ts": SKILLS_TEST,
    "tests/add-on-start-up.test.ts": null,
    "tests/pointer-skills.test.ts": null,
    ...extra,
  });
  return repo;
}

function committedText(repo: string, branch: string, path: string): string {
  return `${git(repo, "show", `${branch}:${path}`)}\n`;
}

test(
  "apply formats the .fallowrc.json its JSON key merge wrote, so a skills-shaped upgrade passes bun run check",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const { baseCommit, targetCommit } = commitSettingsUpgrade(
      templateClone,
      {},
    );
    const repo = await addSkillsEntry(
      templateClone,
      baseCommit,
      "skills-shaped-app",
    );
    const { env } = prepareFastInstallBun(folder, "skills-shaped-bun-");
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );

    const payload = JSON.parse(run.stdout) as TemplateUpgradeApplyResult;
    expect(payload.checkCommandOutput).toBeUndefined();
    expect(run.exitCode).toBe(0);
    expect(payload.status).toBe("applied");
    expect(payload.steps).toContainEqual({
      command: "biome format --write",
      ran: true,
      outcome: "passed",
    });
    const merged = committedText(repo, payload.branch, ".fallowrc.json");
    expect(merged).toContain(TWO_ENTRIES);
    expect(merged).toContain('"deadCodeBaseline"');
    git(repo, "checkout", "--quiet", payload.branch);
    const biome = await spawnBounded(
      [
        join(ROOT, "node_modules/.bin/biome"),
        "format",
        "--write",
        ".fallowrc.json",
      ],
      { cwd: repo, env: { ...inherited(), ...gitEnv, NO_COLOR: "1" } },
    );
    expect(biome.exit).toBe(0);
    expect(readFileSync(join(repo, ".fallowrc.json"), "utf8")).toBe(merged);
  },
  processWatchdog(6),
);

test(
  "apply formats only the JSON its key merge wrote and leaves a text-merged or repository JSON file byte for byte",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const { baseCommit, targetCommit } = commitSettingsUpgrade(templateClone, {
      "tsconfig.json": (text) =>
        replaced(text, '  "exclude": ["node_modules"]\n}\n', SPLIT_EXCLUDE),
    });
    const repoData = '{\n  "items": [\n    "a"\n  ]\n}\n';
    const repo = await addSkillsEntry(
      templateClone,
      baseCommit,
      "control-app",
      {
        "tsconfig.json": replaced(
          readFileSync(join(ROOT, SETTINGS, "tsconfig.json"), "utf8"),
          "{\n",
          "{\n  // kept by the repository\n",
        ),
        "data/items.json": repoData,
      },
    );
    const { env } = writeScriptedBun(folder, "control-bun-", LINKED_BIOME_BUN);
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );

    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as TemplateUpgradeApplyResult;
    expect(payload.rows).toContainEqual({
      path: "tsconfig.json",
      ownerLabel: "shared",
      outcome: "merge",
    });
    expect(committedText(repo, payload.branch, ".fallowrc.json")).toContain(
      TWO_ENTRIES,
    );
    expect(committedText(repo, payload.branch, "tsconfig.json")).toBe(
      replaced(
        readFileSync(join(ROOT, SETTINGS, "tsconfig.json"), "utf8"),
        '{\n  "extends"',
        '{\n  // kept by the repository\n  "extends"',
      ).replace('  "exclude": ["node_modules"]\n}\n', SPLIT_EXCLUDE),
    );
    expect(committedText(repo, payload.branch, "data/items.json")).toBe(
      repoData,
    );
  },
  processWatchdog(4),
);

test(
  "apply stops as check-failed with Biome's output when the JSON format step fails",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const { baseCommit, targetCommit } = commitSettingsUpgrade(
      templateClone,
      {},
    );
    const repo = await addSkillsEntry(templateClone, baseCommit, "refused-app");
    const { ledger, env } = writeScriptedBun(
      folder,
      "refused-bun-",
      `#!/bin/sh
echo "$*" >> __LEDGER__
if [ "$1" = "install" ]; then
  mkdir -p node_modules/.bin
  printf '#!/bin/sh\\necho "biome refused $*"\\nexit 1\\n' > node_modules/.bin/biome
  chmod +x node_modules/.bin/biome
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

    expect(run.exitCode).toBe(1);
    const payload = JSON.parse(run.stdout) as TemplateUpgradeApplyResult;
    expect(payload.status).toBe("check-failed");
    expect(payload.failedStep).toBe("biome format --write");
    expect(payload.checkCommandOutput).toBe(
      "biome refused format --write --no-errors-on-unmatched ./.fallowrc.json",
    );
    expect(payload.steps).toEqual([
      { command: "bun install", ran: true, outcome: "passed" },
      { command: "biome format --write", ran: true, outcome: "failed" },
      {
        command: "bun run check",
        ran: false,
        outcome: "skipped",
        reason: "biome format --write failed",
      },
    ]);
    expect(readFileSync(ledger, "utf8").trim().split("\n")).toEqual([
      "install",
    ]);
  },
  processWatchdog(3),
);

test(
  "apply --no-check reports the JSON format step as skipped with bun install",
  async () => {
    const { templateClone } = cloneTemplateAtHead(folder);
    const { baseCommit, targetCommit } = commitSettingsUpgrade(
      templateClone,
      {},
    );
    const repo = await addSkillsEntry(
      templateClone,
      baseCommit,
      "no-check-app",
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      { templateRoot: templateClone, env: { ...process.env, ...gitEnv } },
    );

    expect(run.exitCode).toBe(0);
    const payload = JSON.parse(run.stdout) as TemplateUpgradeApplyResult;
    expect(payload.steps.slice(0, 2)).toEqual([
      {
        command: "bun install",
        ran: false,
        outcome: "skipped",
        reason: "--no-check",
      },
      {
        command: "biome format --write",
        ran: false,
        outcome: "skipped",
        reason: "--no-check",
      },
    ]);
  },
  processWatchdog(3),
);

const SPLIT_ITEMS = '{\n  "items": [\n    "a"\n  ]\n}\n';

async function rerunAfterOwnerReplacesMergedFallow(
  name: string,
  repositoryFiles: Readonly<Record<string, string>>,
  replace: (mergedPath: string, repo: string) => void,
): Promise<{
  readonly exitCode: number;
  readonly payload: TemplateUpgradeApplyResult;
  readonly repo: string;
}> {
  const { templateClone } = cloneTemplateAtHead(folder);
  const { baseCommit, targetCommit } = commitSettingsUpgrade(templateClone, {
    "tsconfig.json": (text) =>
      replaced(text, '"exclude": ["node_modules"]', '"exclude": ["dist"]'),
  });
  const tsconfig = readFileSync(join(ROOT, SETTINGS, "tsconfig.json"), "utf8");
  const repo = await addSkillsEntry(templateClone, baseCommit, name, {
    ...repositoryFiles,
    "tsconfig.json": replaced(
      tsconfig,
      '"exclude": ["node_modules"]',
      '"exclude": ["coverage"]',
    ),
  });
  const { env } = writeScriptedBun(folder, `${name}-bun-`, LINKED_BIOME_BUN);
  const stdout = captureStream(process.stdout);
  const stderr = captureStream(process.stderr);
  const argv = ["apply", "--repository", repo, "--to", targetCommit, "--json"];
  const first = await invokeTemplateUpgradeMain(stdout, stderr, argv, {
    templateRoot: templateClone,
    env,
  });
  const stopped = JSON.parse(first.stdout) as TemplateUpgradeApplyResult;
  expect(stopped.status).toBe("conflicts");
  expect(stopped.conflicts).toEqual(["tsconfig.json"]);
  expect(stopped.rows).toContainEqual({
    path: ".fallowrc.json",
    ownerLabel: "shared",
    outcome: "merge",
  });
  const worktree = stopped.worktree ?? "";
  writeFileSync(
    join(worktree, "tsconfig.json"),
    replaced(tsconfig, '"exclude": ["node_modules"]', '"exclude": ["dist"]'),
  );
  rmSync(join(worktree, ".fallowrc.json"));
  replace(join(worktree, ".fallowrc.json"), repo);
  const second = await invokeTemplateUpgradeMain(stdout, stderr, argv, {
    templateRoot: templateClone,
    env,
  });
  return {
    exitCode: second.exitCode,
    payload: JSON.parse(second.stdout) as TemplateUpgradeApplyResult,
    repo,
  };
}

test(
  "apply skips a key-merged .fallowrc.json the owner replaced with a link to a tracked JSON file, so the original repository keeps its bytes",
  async () => {
    const { exitCode, payload, repo } =
      await rerunAfterOwnerReplacesMergedFallow(
        "linked-app",
        { "data/settings.json": SPLIT_ITEMS },
        (mergedPath, original) => {
          symlinkSync(join(original, "data/settings.json"), mergedPath);
        },
      );

    expect(readFileSync(join(repo, "data/settings.json"), "utf8")).toBe(
      SPLIT_ITEMS,
    );
    expect(git(repo, "status", "--porcelain=v1")).toBe("");
    expect(exitCode).toBe(0);
    expect(payload.status).toBe("applied");
    expect(payload.steps).toContainEqual({
      command: "biome format --write",
      ran: false,
      outcome: "skipped",
      reason: ".fallowrc.json is a symbolic link",
    });
  },
  processWatchdog(6),
);

test(
  "apply skips a key-merged .fallowrc.json the owner replaced with a hard link to a tracked JSON file, so the original repository keeps its bytes",
  async () => {
    const { exitCode, payload, repo } =
      await rerunAfterOwnerReplacesMergedFallow(
        "hard-linked-app",
        { "data/settings.json": SPLIT_ITEMS },
        (mergedPath, original) => {
          linkSync(join(original, "data/settings.json"), mergedPath);
        },
      );

    expect(readFileSync(join(repo, "data/settings.json"), "utf8")).toBe(
      SPLIT_ITEMS,
    );
    expect(git(repo, "status", "--porcelain=v1")).toBe("");
    expect(exitCode).toBe(0);
    expect(payload.steps).toContainEqual({
      command: "biome format --write",
      ran: false,
      outcome: "skipped",
      reason: ".fallowrc.json is a hard link",
    });
  },
  processWatchdog(6),
);

test(
  "apply skips a key-merged .fallowrc.json the owner replaced with a folder, so the JSON files in it keep their bytes",
  async () => {
    const { exitCode, payload, repo } =
      await rerunAfterOwnerReplacesMergedFallow(
        "folder-app",
        {},
        (mergedPath) => {
          mkdirSync(mergedPath);
          writeFileSync(join(mergedPath, "nested.json"), SPLIT_ITEMS);
        },
      );

    expect(
      committedText(repo, payload.branch, ".fallowrc.json/nested.json"),
    ).toBe(SPLIT_ITEMS);
    expect(exitCode).toBe(0);
    expect(payload.steps).toContainEqual({
      command: "biome format --write",
      ran: false,
      outcome: "skipped",
      reason: ".fallowrc.json is not a regular file",
    });
  },
  processWatchdog(6),
);

test("the JSON format step skips a key-merged path below a linked folder", () => {
  const worktree = folder("linked-folder-worktree-");
  mkdirSync(join(worktree, "real"));
  writeFileSync(join(worktree, "real/settings.json"), SPLIT_ITEMS);
  symlinkSync(join(worktree, "real"), join(worktree, "config"));

  expect(
    runJsonFormatStep(worktree, ["config/settings.json"], process.env),
  ).toEqual({
    ok: true,
    steps: [
      {
        command: "biome format --write",
        ran: false,
        outcome: "skipped",
        reason: "config/settings.json is below symbolic link config",
      },
    ],
  });
});

test("the JSON format step stops when a path it formatted became a hard link while Biome ran", () => {
  const worktree = folder("relinked-worktree-");
  const outside = join(folder("relinked-outside-"), "shared.json");
  writeFileSync(outside, SPLIT_ITEMS);
  writeFileSync(join(worktree, "settings.json"), SPLIT_ITEMS);
  mkdirSync(join(worktree, "node_modules/.bin"), { recursive: true });
  writeFileSync(
    join(worktree, "node_modules/.bin/biome"),
    `#!/bin/sh\nrm "$4"\nln ${JSON.stringify(outside)} "$4"\n`,
    { mode: 0o755 },
  );

  expect(runJsonFormatStep(worktree, ["settings.json"], process.env)).toEqual({
    ok: false,
    result: {
      ok: false,
      exitCode: 0,
      timedOut: false,
      signalCode: null,
      output:
        "settings.json is no longer the regular file with one link that biome format --write was given",
    },
  });
});
