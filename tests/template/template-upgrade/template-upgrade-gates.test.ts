import { expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RECORDED_HITS_FILES } from "../../../src/recipe.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitEnv, inherited } from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  linkTemplateNodeModules,
  prepareFastInstallBun,
  templateUpgradeCalls,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

const PRE_GATE_TEMPLATE_COMMIT = "800ea873324c2654a80912e9c6b311fa2458ef24";

async function createPreGateRepository(options: {
  readonly templateClone: string;
  readonly name: string;
  readonly files: Readonly<Record<string, string>>;
  readonly extraCommand?: {
    readonly importLine: string;
    readonly summaryExpression: string;
  };
}): Promise<string> {
  const repo = await bootstrapGeneratedRepository(
    folder,
    options.templateClone,
    PRE_GATE_TEMPLATE_COMMIT,
    options.name,
  );
  git(
    repo,
    "rm",
    "--quiet",
    "--",
    "tests/add-on-start-up.test.ts",
    "tests/pointer-skills.test.ts",
  );
  const filesToCommit: Record<string, string> = { ...options.files };
  if (options.extraCommand !== undefined) {
    filesToCommit["src/commands.ts"] = commandsWithExtraCall(
      repo,
      options.extraCommand.importLine,
      options.extraCommand.summaryExpression,
    );
  }
  commitIn(repo, "add pre-upgrade repository code", filesToCommit);

  linkTemplateNodeModules(repo);
  try {
    const format = await spawnBounded([process.execPath, "run", "format"], {
      cwd: repo,
      env: { ...inherited(), ...gitEnv, NO_COLOR: "1" },
      processGroup: true,
    });
    if (format.exit !== 0) {
      throw new Error(
        `base format failed (exit ${format.exit}): ${format.stderr}\n${format.stdout}`,
      );
    }
    const record = await spawnBounded(
      [process.execPath, "run", "quality:fallow:record-hits"],
      {
        cwd: repo,
        env: { ...inherited(), ...gitEnv, NO_COLOR: "1" },
        processGroup: true,
      },
    );
    if (record.exit !== 0) {
      throw new Error(
        `base quality:fallow:record-hits failed (exit ${record.exit}): ${record.stderr}\n${record.stdout}`,
      );
    }
    const updatedFiles: Record<string, string> = {};
    for (const file of [
      ...Object.keys(filesToCommit),
      ...RECORDED_HITS_FILES,
    ]) {
      updatedFiles[file] = readFileSync(join(repo, file), "utf8");
    }
    commitIn(repo, "commit formatted code and recorded hits", updatedFiles);
    const baseCheck = await spawnBounded([process.execPath, "run", "check"], {
      cwd: repo,
      env: { ...inherited(), ...gitEnv, NO_COLOR: "1" },
      processGroup: true,
    });
    if (baseCheck.exit !== 0) {
      throw new Error(
        `base check failed (exit ${baseCheck.exit}): ${baseCheck.stderr}\n${baseCheck.stdout}`,
      );
    }
  } finally {
    rmSync(join(repo, "node_modules"), { force: true, recursive: true });
    rmSync(join(repo, ".fallow"), { force: true, recursive: true });
  }
  return repo;
}

function commandsWithExtraCall(
  repoRoot: string,
  importLine: string,
  summaryExpression: string,
): string {
  const originalCommands = readFileSync(
    join(repoRoot, "src/commands.ts"),
    "utf8",
  );
  return [
    importLine,
    originalCommands.replace(
      "data: { ready: true }",
      `data: { ready: true, summary: ${summaryExpression} }`,
    ),
  ].join("\n");
}

test(
  "refuses with recorded_hits_would_grow and restores recorded-hits files when upgrading a wiki-shaped repository across changed Fallow gates would add a boundary violation",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const repo = await createPreGateRepository({
      templateClone,
      name: "wiki-shaped-app",
      extraCommand: {
        importLine: 'import { recordsSummary } from "./commands/records.ts";',
        summaryExpression: 'recordsSummary(["a", "b"])',
      },
      files: {
        "src/wiki/notes.ts":
          "export function noteCount(items: readonly string[]): number {\n  return items.length;\n}\n",
        "src/records/find.ts":
          'import { noteCount } from "../wiki/notes.ts";\n\nexport function findSummary(items: readonly string[]): string {\n  return `records:${noteCount(items)}`;\n}\n',
        "src/commands/records.ts":
          'import { findSummary } from "../records/find.ts";\nimport { noteCount } from "../wiki/notes.ts";\n\nexport function recordsSummary(items: readonly string[]): string {\n  return `${findSummary(items)}/${noteCount(items)}`;\n}\n',
      },
    });
    const baseDeadCodeBytes = readFileSync(
      join(repo, "fallow-dead-code-recorded-hits.json"),
    );
    const { env } = prepareFastInstallBun(folder, "wiki-shaped-bun-");
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const branch = `template-upgrade/${PRE_GATE_TEMPLATE_COMMIT.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(first.exitCode).toBe(4);
    expect(first.stdout).toBe("");
    const refusal = JSON.parse(first.stderr) as {
      readonly status: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
        readonly repair: string;
      };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.error.code).toBe("recorded_hits_would_grow");
    expect(refusal.error.message).toContain(
      "fallow-dead-code-recorded-hits.json",
    );
    expect(refusal.error.message).toContain(
      "boundary-violation:src/records/find.ts:src/wiki/notes.ts",
    );
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(
      Buffer.compare(
        readFileSync(join(worktree, "fallow-dead-code-recorded-hits.json")),
        baseDeadCodeBytes,
      ),
    ).toBe(0);
  },
  processWatchdog(6),
);

test(
  "refreshes stale Fallow recorded hits automatically and lands cleanly when changed Fallow and TypeScript settings produce zero new findings",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const repo = await createPreGateRepository({
      templateClone,
      name: "clean-refresh-app",
      files: {},
    });
    const { ledger, env } = prepareFastInstallBun(folder, "clean-refresh-bun-");
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const branch = `template-upgrade/${PRE_GATE_TEMPLATE_COMMIT.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(first.stderr).toBe("");
    expect(first.exitCode).toBe(0);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "applied",
      branch,
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
        },
        { command: "bun run check", ran: true, outcome: "passed" },
        { command: "fallow audit", ran: true, outcome: "passed" },
      ],
    });
    expect(templateUpgradeCalls(ledger)).toEqual([
      "install",
      "run quality:fallow:record-hits",
      "run check",
    ]);

    const second = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(second.exitCode).toBe(0);
    expect(JSON.parse(second.stdout)).toMatchObject({
      status: "already-done",
      branch,
    });
  },
  processWatchdog(6),
);

test(
  "reports gate-adoption-required for ESLint and TypeScript gates added by an upgrade while keeping broken upgrades as check-failed",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const lintRepo = await createPreGateRepository({
      templateClone,
      name: "loose-src-app",
      extraCommand: {
        importLine: 'import { helperCount } from "./helper.ts";',
        summaryExpression: 'helperCount(["a"])',
      },
      files: {
        "src/notes/rules.ts":
          "export function countNotes(items: readonly string[]): number {\n  return items.length;\n}\n",
        "src/helper.ts":
          'import { countNotes } from "./notes/rules.ts";\n\nexport function helperCount(items: readonly string[]): number {\n  return countNotes(items);\n}\n',
      },
    });
    const lintBun = prepareFastInstallBun(folder, "lint-gate-bun-");
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const lintRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", lintRepo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env: lintBun.env },
    );
    expect(lintRun.exitCode).toBe(6);
    const lintPayload = JSON.parse(lintRun.stdout) as {
      readonly status: string;
      readonly gate?: string;
      readonly gateFiles?: readonly string[];
      readonly gateProblems?: readonly {
        readonly code: string;
        readonly path: string;
      }[];
      readonly gateRepair?: string;
    };
    expect(lintPayload.status).toBe("gate-adoption-required");
    expect(lintPayload.gate).toBe("lint");
    expect(lintPayload.gateFiles).toContain("eslint.config.mjs");
    expect(lintPayload.gateProblems).toMatchObject([
      {
        code: "repository/no-loose-source-with-subjects",
        path: "src/helper.ts",
      },
    ]);
    expect(lintPayload.gateRepair).toContain("ESLint");
    expect(lintPayload.gateRepair).toContain(
      "Move each loose file in src/ into a subject folder (src/<subject>/) or src/shared/.",
    );

    const tsRepo = await createPreGateRepository({
      templateClone,
      name: "unreachable-ts-app",
      extraCommand: {
        importLine: 'import { chooseLabel } from "./label.ts";',
        summaryExpression: "chooseLabel()",
      },
      files: {
        "src/label.ts":
          'export function chooseLabel(): string {\n  return "ok";\n  return "unreachable";\n}\n',
      },
    });
    const tsBun = prepareFastInstallBun(folder, "ts-gate-bun-");
    const tsRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", tsRepo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env: tsBun.env },
    );
    expect(tsRun.exitCode).toBe(6);
    const tsPayload = JSON.parse(tsRun.stdout) as {
      readonly status: string;
      readonly gate?: string;
      readonly gateFiles?: readonly string[];
      readonly gateProblems?: readonly {
        readonly code: string;
        readonly path: string;
      }[];
    };
    expect(tsPayload.status).toBe("gate-adoption-required");
    expect(tsPayload.gate).toBe("typecheck");
    expect(tsPayload.gateFiles).toContain("tsconfig.base.json");
    expect(tsPayload.gateProblems).toMatchObject([
      {
        code: "TS7027",
        path: "src/label.ts",
      },
    ]);

    const { templateClone: brokenTemplate } = cloneTemplateAtHead(folder);
    const helperPath = join(brokenTemplate, "tests/support/test-folder.ts");
    writeFileSync(
      helperPath,
      readFileSync(helperPath, "utf8").replace(
        "export function testFolder(prefix: string",
        "export function testFolder(prefix: string, requiredExtra: number",
      ),
    );
    git(brokenTemplate, "add", "--", "tests/support/test-folder.ts");
    git(
      brokenTemplate,
      "commit",
      "--quiet",
      "-m",
      "change template test helper signature",
    );
    const brokenTarget = git(brokenTemplate, "rev-parse", "HEAD");
    const brokenRepo = await createPreGateRepository({
      templateClone: brokenTemplate,
      name: "changed-signature-app",
      files: {
        "tests/owner.test.ts":
          'import { expect, test } from "bun:test";\nimport { testFolder } from "./support/test-folder.ts";\n\ntest("uses template helper", () => {\n  expect(typeof testFolder("owner-")).toBe("string");\n});\n',
      },
    });
    const brokenBun = prepareFastInstallBun(folder, "removed-export-bun-");
    const brokenRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", brokenRepo, "--to", brokenTarget, "--json"],
      { templateRoot: brokenTemplate, env: brokenBun.env },
    );
    expect(brokenRun.exitCode).toBe(1);
    expect(JSON.parse(brokenRun.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
    });
  },
  processWatchdog(6),
);
