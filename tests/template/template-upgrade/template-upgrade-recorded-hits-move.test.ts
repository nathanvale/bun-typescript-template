import { expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
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
  writeScriptedBun,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

const TESTS_READING_INSTALLED_KERNEL = [
  "tests/add-on-start-up.test.ts",
  "tests/pointer-skills.test.ts",
];

const BEFORE_LAYOUT_GATE_COMMIT = "b8f4264dc50b1b673aa3edd0206f7bd9cb646182";

function complexFunction(name: string): string {
  return `export function ${name}(items: readonly string[]): number {
  let total = 0;
  for (const item of items) {
    if (item.length > 0) {
      for (const letter of item) {
        if (letter === "a") {
          total += 1;
        } else if (letter === "b") {
          if (total > 2) {
            total -= 1;
          } else {
            total += 2;
          }
        } else if ((letter === "c" && total > 0) || letter === "d") {
          total += 3;
        }
      }
    } else if (total > 10) {
      total = 0;
    }
  }
  return total;
}
`;
}

async function createCatalogRepository(
  templateClone: string,
  name: string,
  catalogPath: string,
): Promise<{ readonly repo: string; readonly repositoryHead: string }> {
  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    BEFORE_LAYOUT_GATE_COMMIT,
    name,
  );
  const commands = readFileSync(join(repo, "src/commands.ts"), "utf8");
  const { sha } = commitIn(repo, "add catalog", {
    ...Object.fromEntries(
      TESTS_READING_INSTALLED_KERNEL.map((path) => [path, null]),
    ),
    [`src/${catalogPath}`]: complexFunction("catalogScore"),
    "src/notes/notes.ts":
      "export function noteCount(items: readonly string[]): number {\n  return items.length;\n}\n",
    "src/commands.ts": [
      `import { catalogScore } from "./${catalogPath}";`,
      'import { noteCount } from "./notes/notes.ts";',
      commands.replace(
        "data: { ready: true }",
        'data: { ready: true, score: catalogScore(["ab"]) + noteCount([]) }',
      ),
    ].join("\n"),
  });
  return { repo, repositoryHead: sha };
}

async function pushAudit(
  repo: string,
  branch: string,
  base: string,
): Promise<{
  readonly exit: number | null;
  readonly verdict: unknown;
  readonly complexity: readonly string[];
}> {
  const checkout = join(folder("push-audit-"), "checkout");
  git(repo, "worktree", "add", "--quiet", "--detach", checkout, branch);
  linkTemplateNodeModules(checkout);
  const audit = await spawnBounded(
    [
      join(checkout, "node_modules/.bin/fallow"),
      "audit",
      "--base",
      base,
      "--format",
      "json",
      "--quiet",
    ],
    {
      cwd: checkout,
      env: { ...inherited(), ...gitEnv, NO_COLOR: "1" },
      processGroup: true,
    },
  );
  const report = JSON.parse(audit.stdout) as {
    readonly verdict?: unknown;
    readonly complexity?: {
      readonly findings?: readonly {
        readonly path: string;
        readonly name: string;
      }[];
    };
  };
  return {
    exit: audit.exit,
    verdict: report.verdict,
    complexity: (report.complexity?.findings ?? []).map(
      (finding) => `${finding.path} ${finding.name}`,
    ),
  };
}

function recordedHealthKeys(repo: string, branch: string): string[] {
  const hits = JSON.parse(
    git(repo, "show", `${branch}:fallow-health-recorded-hits.json`),
  ) as { readonly identity_finding_counts: Record<string, unknown> };
  return Object.keys(hits.identity_finding_counts);
}

test(
  "an upgrade whose gate-adoption repair moves a recorded complex function records it again at its new path, so the push's Fallow audit passes, and a function added during the repair is not recorded",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const { repo, repositoryHead } = await createCatalogRepository(
      templateClone,
      "moved-catalog-app",
      "catalog.ts",
    );
    const { ledger, env } = prepareFastInstallBun(folder, "moved-catalog-bun-");
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
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const branch = `template-upgrade/${BEFORE_LAYOUT_GATE_COMMIT.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const first = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(first.exitCode).toBe(6);
    expect(JSON.parse(first.stdout)).toMatchObject({
      status: "gate-adoption-required",
      gate: "lint",
      gateProblems: [
        {
          code: "repository/no-loose-source-with-subjects",
          path: "src/catalog.ts",
        },
      ],
    });

    mkdirSync(join(worktree, "src/catalog"));
    renameSync(
      join(worktree, "src/catalog.ts"),
      join(worktree, "src/catalog/catalog.ts"),
    );
    const commandsPath = join(worktree, "src/commands.ts");
    const movedCommands = readFileSync(commandsPath, "utf8").replace(
      '"./catalog.ts"',
      '"./catalog/catalog.ts"',
    );
    writeFileSync(commandsPath, movedCommands);
    const addedPath = join(worktree, "src/catalog/rank.ts");
    writeFileSync(addedPath, complexFunction("catalogRank"));
    writeFileSync(
      commandsPath,
      `import { catalogRank } from "./catalog/rank.ts";\n${movedCommands.replace(
        "noteCount([])",
        "noteCount([]) + catalogRank([])",
      )}`,
    );

    const added = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(added.exitCode).toBe(1);
    expect(JSON.parse(added.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "bun run check",
    });
    expect(
      readFileSync(join(worktree, "fallow-health-recorded-hits.json"), "utf8"),
    ).not.toContain("catalogRank");

    writeFileSync(commandsPath, movedCommands);
    renameSync(addedPath, join(folder("removed-rank-"), "rank.ts"));
    const moved = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      args,
      runtime,
    );
    expect(moved.stderr).toBe("");
    expect(JSON.parse(moved.stdout)).toMatchObject({
      status: "applied",
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        { command: "bun run check", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
          reason: "recorded again after a repair that bun run check passed",
        },
        { command: "fallow audit", ran: true, outcome: "passed" },
      ],
    });
    expect(templateUpgradeCalls(ledger)).toEqual([
      "install",
      "run quality:fallow:record-hits",
      "run check",
      "install",
      "run check",
      "install",
      "run check",
      "run quality:fallow:record-hits",
    ]);
    expect(recordedHealthKeys(repo, branch)).toEqual([
      "src/catalog/catalog.ts\u0000catalogScore",
    ]);
    expect(await pushAudit(repo, branch, repositoryHead)).toEqual({
      exit: 0,
      verdict: "pass",
      complexity: [],
    });
  },
  processWatchdog(8),
);

test(
  "an upgrade where no file moves records its hits once and lands a branch that the push's Fallow audit passes",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const { repo, repositoryHead } = await createCatalogRepository(
      templateClone,
      "settled-catalog-app",
      "catalog/catalog.ts",
    );
    const { ledger, env } = prepareFastInstallBun(
      folder,
      "settled-catalog-bun-",
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const branch = `template-upgrade/${BEFORE_LAYOUT_GATE_COMMIT.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(run.stderr).toBe("");
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "applied",
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
    expect(recordedHealthKeys(repo, branch)).toEqual([
      "src/catalog/catalog.ts\u0000catalogScore",
    ]);
    expect(await pushAudit(repo, branch, repositoryHead)).toEqual({
      exit: 0,
      verdict: "pass",
      complexity: [],
    });
  },
  processWatchdog(6),
);

test(
  "apply stops as check-failed with the audit's output when the push's Fallow audit fails after bun run check passed",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      BEFORE_LAYOUT_GATE_COMMIT,
      "audit-failure-app",
    );
    const repositoryHead = git(repo, "rev-parse", "HEAD");
    const { ledger, env } = writeScriptedBun(
      folder,
      "scripted-bun-audit-",
      `#!/bin/sh
ledger=__LEDGER__
echo "$*" >> "$ledger"
if [ "$1" = "install" ]; then
  mkdir -p node_modules/.bin
  printf '#!/bin/sh\\necho "fallow $*" >> %s\\necho "planted audit finding in src/moved.ts"\\nexit 1\\n' "$ledger" > node_modules/.bin/fallow
  chmod +x node_modules/.bin/fallow
fi
exit 0
`,
    );
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const branch = `template-upgrade/${BEFORE_LAYOUT_GATE_COMMIT.slice(0, 7)}-${targetCommit.slice(0, 7)}`;

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(run.exitCode).toBe(1);
    expect(JSON.parse(run.stdout)).toMatchObject({
      status: "check-failed",
      failedStep: "fallow audit",
      worktree,
      checkCommandOutput: "planted audit finding in src/moved.ts",
      steps: [
        { command: "bun install", ran: true, outcome: "passed" },
        {
          command: "bun run quality:fallow:record-hits",
          ran: true,
          outcome: "passed",
        },
        { command: "bun run check", ran: true, outcome: "passed" },
        { command: "fallow audit", ran: true, outcome: "failed" },
      ],
    });
    expect(readFileSync(ledger, "utf8")).toContain(
      `fallow audit --base ${repositoryHead} --quiet`,
    );
    expect(existsSync(worktree)).toBe(true);
    expect(git(repo, "branch", "--list", branch)).toBe("");
  },
  processWatchdog(4),
);
