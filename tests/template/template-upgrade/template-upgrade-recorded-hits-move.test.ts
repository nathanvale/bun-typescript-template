import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  prepareFastInstallBun,
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

test(
  "refuses with recorded_hits_would_grow when upgrading a repository with an unrecorded complex function across the first recorded-hits addition",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const { repo } = await createCatalogRepository(
      templateClone,
      "settled-catalog-app",
      "catalog/catalog.ts",
    );
    const { env } = prepareFastInstallBun(folder, "settled-catalog-bun-");
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);
    const worktree = join(
      repo,
      ".worktrees",
      `template-upgrade-${targetCommit.slice(0, 7)}`,
    );
    const branch = `template-upgrade/${BEFORE_LAYOUT_GATE_COMMIT.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const expectedBaseHealth = readFileSync(
      join(
        templateClone,
        "generated-repository/settings/fallow-health-recorded-hits.json",
      ),
    );

    const run = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--to", targetCommit, "--json"],
      { templateRoot: templateClone, env },
    );
    expect(run.exitCode).toBe(4);
    expect(run.stdout).toBe("");
    const refusal = JSON.parse(run.stderr) as {
      readonly status: string;
      readonly error: {
        readonly code: string;
        readonly message: string;
      };
    };
    expect(refusal.status).toBe("refused");
    expect(refusal.error.code).toBe("recorded_hits_would_grow");
    expect(refusal.error.message).toContain("fallow-health-recorded-hits.json");
    expect(refusal.error.message).toContain("catalogScore");
    expect(git(repo, "branch", "--list", branch)).toBe("");
    expect(
      Buffer.compare(
        readFileSync(join(worktree, "fallow-health-recorded-hits.json")),
        expectedBaseHealth,
      ),
    ).toBe(0);
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
