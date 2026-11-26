import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import { commitIn, git, gitOutput } from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();
const PRE_TEMPLATES_BASE = "a5cf1db8";
const PULL_REQUEST_TEMPLATE_PATH = ".github/pull_request_template.md";
const ISSUE_TEMPLATE_PATH = ".github/ISSUE_TEMPLATE/issue.md";

test(
  "upgrading from a template commit without pull request and issue templates adds both files",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const baseCommit = git(templateClone, "rev-parse", PRE_TEMPLATES_BASE);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "github-templates-app",
    );
    const runtime = {
      templateRoot: templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applied = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applied.exitCode).toBe(0);
    expect(JSON.parse(applied.stdout)).toMatchObject({
      status: "applied",
      branch,
    });
    expect(
      gitOutput(repo, "show", `${branch}:${PULL_REQUEST_TEMPLATE_PATH}`),
    ).toBe(
      readFileSync(
        join(
          ROOT,
          "generated-repository/github-templates/pull_request_template.md",
        ),
        "utf8",
      ),
    );
    expect(gitOutput(repo, "show", `${branch}:${ISSUE_TEMPLATE_PATH}`)).toBe(
      readFileSync(
        join(
          ROOT,
          "generated-repository/github-templates/ISSUE_TEMPLATE/issue.md",
        ),
        "utf8",
      ),
    );
  },
  processWatchdog(4),
);

test(
  "upgrading when the generated repository already has a different pull request template stops with conflict-add and preserves both versions in markers",
  async () => {
    const { templateClone, baseCommit: targetCommit } =
      cloneTemplateAtHead(folder);
    const baseCommit = git(templateClone, "rev-parse", PRE_TEMPLATES_BASE);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "existing-pr-template-app",
    );
    const ownerPullRequestTemplate = "## Custom Summary\n\nOwner notes.\n";
    commitIn(repo, "owner adds custom pull request template", {
      [PULL_REQUEST_TEMPLATE_PATH]: ownerPullRequestTemplate,
    });
    const runtime = {
      templateRoot: templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const applied = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(repo, targetCommit),
      runtime,
    );
    expect(applied.exitCode).toBe(2);
    const payload = JSON.parse(applied.stdout) as {
      status: string;
      conflicts: string[];
      worktree: string;
      rows: { path: string; ownerLabel: string; outcome: string }[];
    };
    expect(payload.status).toBe("conflicts");
    expect(payload.conflicts).toEqual([PULL_REQUEST_TEMPLATE_PATH]);
    const rowByPath = new Map(payload.rows.map((row) => [row.path, row]));
    expect(rowByPath.get(PULL_REQUEST_TEMPLATE_PATH)).toEqual({
      path: PULL_REQUEST_TEMPLATE_PATH,
      ownerLabel: "shared",
      outcome: "conflict-add",
    });
    expect(rowByPath.get(ISSUE_TEMPLATE_PATH)).toEqual({
      path: ISSUE_TEMPLATE_PATH,
      ownerLabel: "shared",
      outcome: "take",
    });
    const marked = readFileSync(
      join(payload.worktree, PULL_REQUEST_TEMPLATE_PATH),
      "utf8",
    );
    expect(marked).toContain("<<<<<<< ours\n");
    expect(marked).toContain("## Custom Summary\n\nOwner notes.\n");
    expect(marked).toContain("=======\n## Summary\n");
    expect(marked).toContain(">>>>>>> new\n");
    expect(
      readFileSync(join(payload.worktree, ISSUE_TEMPLATE_PATH), "utf8"),
    ).toBe(
      readFileSync(
        join(
          ROOT,
          "generated-repository/github-templates/ISSUE_TEMPLATE/issue.md",
        ),
        "utf8",
      ),
    );
  },
  processWatchdog(4),
);
