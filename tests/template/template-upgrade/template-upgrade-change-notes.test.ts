import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "../../../src/cli-error.ts";
import { parseGitTreeEntries } from "../../../src/git-identities.ts";
import { readTemplateUpgradeChangeNotes } from "../../../src/template-upgrade-change-notes.ts";
import {
  createTemplateUpgradeApplyRun,
  createTemplateUpgradePlanResult,
  skipTemplateUpgradeSteps,
} from "../../../src/template-upgrade-report.ts";
import { templateUpgradeCommitMessage } from "../../../src/template-upgrade-worktree.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  gitOutput,
  initRepository,
} from "../../support/git-fixture.ts";
import { processWatchdog } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  bootstrapGeneratedRepository,
  cloneTemplateAtHead,
  commitTemplateUpgradeChanges,
  invokeTemplateUpgradeMain,
  templateUpgradeEnv,
} from "../../support/template-upgrade-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

interface ChangeNoteJsonEntry {
  readonly file: string;
  readonly note: {
    readonly kind: string;
    readonly breaking: boolean;
    readonly affects: readonly string[];
    readonly summary: string;
    readonly action: string | null;
  };
}

interface PlanWithNotesJson {
  readonly status: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly rows: readonly {
    readonly path: string;
    readonly ownerLabel: string;
    readonly outcome: string;
  }[];
  readonly changeNotes?: readonly ChangeNoteJsonEntry[];
  readonly sharedMerges?: readonly string[];
  readonly templateHeadNotice?: string;
}

interface ApplyWithNotesJson {
  readonly status: string;
  readonly baseCommit: string;
  readonly targetCommit: string;
  readonly branch: string;
  readonly changeNotes?: readonly ChangeNoteJsonEntry[];
  readonly templateHeadNotice?: string;
}

function writeChangeNote(
  templateClone: string,
  file: string,
  note: {
    readonly kind: string;
    readonly breaking: boolean;
    readonly affects: readonly string[];
    readonly summary: string;
    readonly action: string | null;
  },
): string {
  const relativePath = `change-notes/${file}`;
  mkdirSync(join(templateClone, "change-notes"), { recursive: true });
  writeFileSync(
    join(templateClone, relativePath),
    `${JSON.stringify(note, null, 2)}\n`,
  );
  return relativePath;
}

async function setupChangeNotesUpgrade() {
  const { templateClone } = cloneTemplateAtHead(folder);
  const baseNotePath = writeChangeNote(
    templateClone,
    "2026-11-20-base-note.json",
    {
      kind: "added",
      breaking: false,
      affects: ["bootstrap"],
      summary: "Already in base commit.",
      action: null,
    },
  );
  git(templateClone, "add", "--", baseNotePath);
  git(templateClone, "commit", "--quiet", "-m", "base change note");
  const baseCommit = git(templateClone, "rev-parse", "HEAD");

  const repo = await bootstrapGeneratedRepository(
    folder,
    templateClone,
    baseCommit,
    "notes-demo",
  );

  const nonBreakingPath = writeChangeNote(
    templateClone,
    "2026-11-22-added-feature.json",
    {
      kind: "added",
      breaking: false,
      affects: ["generated-repository"],
      summary: "Added upgrade summary output.",
      action: "Review the summary after upgrading.",
    },
  );
  const breakingPath = writeChangeNote(
    templateClone,
    "2026-11-23-breaking-change.json",
    {
      kind: "changed",
      breaking: true,
      affects: ["bootstrap", "generated-repository"],
      summary: "Changed generated lint layout.",
      action: "Update custom lint imports before running check.",
    },
  );
  const rulesPath = join(templateClone, "config/template-rules.mjs");
  writeFileSync(rulesPath, `${readFileSync(rulesPath, "utf8")}\n`);
  git(
    templateClone,
    "add",
    "--",
    nonBreakingPath,
    breakingPath,
    "config/template-rules.mjs",
  );
  git(templateClone, "commit", "--quiet", "-m", "target with change notes");
  const targetCommit = git(templateClone, "rev-parse", "HEAD");

  writeChangeNote(templateClone, "2026-11-24-uncommitted.json", {
    kind: "added",
    breaking: false,
    affects: ["bootstrap"],
    summary: "Uncommitted working tree note must not appear.",
    action: null,
  });

  return {
    templateClone,
    baseCommit,
    targetCommit,
    branch: `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`,
    repo,
  };
}

test(
  "plan and apply list added change notes breaking-first in JSON and text, ignoring working-tree notes, and write them to the commit body",
  async () => {
    const setup = await setupChangeNotesUpgrade();
    const runtime = {
      templateRoot: setup.templateClone,
      env: templateUpgradeEnv(),
    };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "plan",
        "--repository",
        setup.repo,
        "--to",
        setup.targetCommit,
        "--json",
      ],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as PlanWithNotesJson;
    expect(planJson.changeNotes?.map((entry) => entry.file)).toEqual([
      "2026-11-23-breaking-change.json",
      "2026-11-22-added-feature.json",
    ]);
    expect(planJson.changeNotes?.[0]?.note).toMatchObject({
      breaking: true,
      summary: "Changed generated lint layout.",
      action: "Update custom lint imports before running check.",
    });
    expect(planJson.changeNotes?.[1]?.note).toMatchObject({
      breaking: false,
      summary: "Added upgrade summary output.",
      action: "Review the summary after upgrading.",
    });

    const planTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", setup.repo, "--to", setup.targetCommit],
      runtime,
    );
    expect(planTextRun.exitCode).toBe(0);
    expect(planTextRun.stdout).toContain(
      `Target commit: ${setup.targetCommit}`,
    );
    const breakingPos = planTextRun.stdout.indexOf(
      "Changed generated lint layout.",
    );
    const addedPos = planTextRun.stdout.indexOf(
      "Added upgrade summary output.",
    );
    expect(breakingPos).toBeGreaterThan(-1);
    expect(addedPos).toBeGreaterThan(breakingPos);
    expect(planTextRun.stdout).toContain(
      "Action: Update custom lint imports before running check.",
    );
    expect(planTextRun.stdout).toContain(
      "Action: Review the summary after upgrading.",
    );
    expect(planTextRun.stdout).not.toContain("Already in base commit.");
    expect(planTextRun.stdout).not.toContain(
      "Uncommitted working tree note must not appear.",
    );

    const applyJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      runtime,
    );
    expect(applyJsonRun.exitCode).toBe(0);
    const applyJson = JSON.parse(applyJsonRun.stdout) as ApplyWithNotesJson;
    expect(applyJson.changeNotes?.map((entry) => entry.file)).toEqual([
      "2026-11-23-breaking-change.json",
      "2026-11-22-added-feature.json",
    ]);

    const commitBody = gitOutput(
      setup.repo,
      "log",
      "-1",
      "--format=%b",
      setup.branch,
    );
    const bodyBreakingPos = commitBody.indexOf(
      "Changed generated lint layout.",
    );
    const bodyAddedPos = commitBody.indexOf("Added upgrade summary output.");
    expect(bodyBreakingPos).toBeGreaterThan(-1);
    expect(bodyAddedPos).toBeGreaterThan(bodyBreakingPos);
    expect(commitBody).toContain(
      "Action: Update custom lint imports before running check.",
    );
    expect(commitBody).toContain("Action: Review the summary after upgrading.");
    expect(commitBody).not.toContain("Already in base commit.");

    const secondRepo = await bootstrapGeneratedRepository(
      folder,
      setup.templateClone,
      setup.baseCommit,
      "notes-text-demo",
    );
    const applyTextRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      [
        "apply",
        "--repository",
        secondRepo,
        "--to",
        setup.targetCommit,
        "--no-check",
      ],
      runtime,
    );
    expect(applyTextRun.exitCode).toBe(0);
    expect(applyTextRun.stdout).toContain(
      `Target commit: ${setup.targetCommit}`,
    );
    const applyBreakingPos = applyTextRun.stdout.indexOf(
      "Changed generated lint layout.",
    );
    const applyAddedPos = applyTextRun.stdout.indexOf(
      "Added upgrade summary output.",
    );
    expect(applyBreakingPos).toBeGreaterThan(-1);
    expect(applyAddedPos).toBeGreaterThan(applyBreakingPos);
    expect(applyTextRun.stdout).toContain(
      "Action: Update custom lint imports before running check.",
    );
  },
  processWatchdog(4),
);

test(
  "AGENTS.md takes when untouched, merges when repository added a section, and plan names edited shared files that will be merged",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const targetCommit = commitTemplateUpgradeChanges(templateClone);
    const branch = `template-upgrade/${baseCommit.slice(0, 7)}-${targetCommit.slice(0, 7)}`;
    const untouchedRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "agents-untouched",
    );
    const editedRepo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "agents-edited",
    );
    const addedSection =
      "\n## Repository rules\n\nKeep custom gateway routes in src/routes.ts.\n";
    commitIn(editedRepo, "add repository AGENTS section", {
      "AGENTS.md": `${readFileSync(join(editedRepo, "AGENTS.md"), "utf8")}${addedSection}`,
    });

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const untouchedPlan = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", untouchedRepo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(untouchedPlan.exitCode).toBe(0);
    const untouchedJson = JSON.parse(untouchedPlan.stdout) as PlanWithNotesJson;
    expect(untouchedJson.rows.find((row) => row.path === "AGENTS.md")).toEqual({
      path: "AGENTS.md",
      ownerLabel: "shared",
      outcome: "take",
    });
    expect(untouchedJson.sharedMerges).toEqual([]);

    const editedPlanJson = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", editedRepo, "--to", targetCommit, "--json"],
      runtime,
    );
    expect(editedPlanJson.exitCode).toBe(0);
    const editedJson = JSON.parse(editedPlanJson.stdout) as PlanWithNotesJson;
    expect(editedJson.rows.find((row) => row.path === "AGENTS.md")).toEqual({
      path: "AGENTS.md",
      ownerLabel: "shared",
      outcome: "merge",
    });
    expect(editedJson.sharedMerges).toEqual(["AGENTS.md"]);

    const editedPlanText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", editedRepo, "--to", targetCommit],
      runtime,
    );
    expect(editedPlanText.exitCode).toBe(0);
    expect(editedPlanText.stdout).toContain(
      "Shared files edited by this repository (will be merged):",
    );
    expect(editedPlanText.stdout).toContain("  AGENTS.md");

    const applyRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      applyNoCheckJsonArgs(editedRepo, targetCommit),
      runtime,
    );
    expect(applyRun.exitCode).toBe(0);
    const mergedAgents = gitOutput(editedRepo, "show", `${branch}:AGENTS.md`);
    expect(mergedAgents).toContain(`Template source: ${targetCommit}`);
    expect(mergedAgents).toContain("## Repository rules");
    expect(mergedAgents).toContain(
      "Keep custom gateway routes in src/routes.ts.",
    );
  },
  processWatchdog(4),
);

test(
  "defaults --to HEAD, always prints target commit, and warns when template HEAD is behind origin/main",
  async () => {
    const { templateClone, baseCommit } = cloneTemplateAtHead(folder);
    const repo = await bootstrapGeneratedRepository(
      folder,
      templateClone,
      baseCommit,
      "behind-head-demo",
    );
    const headTarget = commitTemplateUpgradeChanges(templateClone);
    git(templateClone, "checkout", "--quiet", "-b", "origin-advance");
    const aheadOne = commitIn(templateClone, "origin ahead 1", {
      "docs/ahead-one.md": "1\n",
    }).sha;
    const aheadTwo = commitIn(templateClone, "origin ahead 2", {
      "docs/ahead-two.md": "2\n",
    }).sha;
    git(templateClone, "update-ref", "refs/remotes/origin/main", aheadTwo);
    git(templateClone, "checkout", "--quiet", "--detach", headTarget);
    expect(aheadOne).not.toBe(aheadTwo);

    const runtime = { templateRoot: templateClone, env: templateUpgradeEnv() };
    const stdout = captureStream(process.stdout);
    const stderr = captureStream(process.stderr);

    const planText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo],
      runtime,
    );
    expect(planText.exitCode).toBe(0);
    expect(planText.stdout).toContain(`Target commit: ${headTarget}`);
    expect(planText.stdout).toContain("2 commits behind origin/main");
    expect(planText.stdout).toContain("git pull");
    expect(planText.stdout).toContain("--to origin/main");

    const planJsonRun = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--json"],
      runtime,
    );
    expect(planJsonRun.exitCode).toBe(0);
    const planJson = JSON.parse(planJsonRun.stdout) as PlanWithNotesJson;
    expect(planJson.targetCommit).toBe(headTarget);
    expect(planJson.templateHeadNotice).toContain(
      "2 commits behind origin/main",
    );
    expect(planJson.templateHeadNotice).toContain("git pull");
    expect(planJson.templateHeadNotice).toContain("--to origin/main");

    const planOriginMain = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["plan", "--repository", repo, "--to", "origin/main", "--json"],
      runtime,
    );
    expect(planOriginMain.exitCode).toBe(0);
    const originMainJson = JSON.parse(
      planOriginMain.stdout,
    ) as PlanWithNotesJson;
    expect(originMainJson.targetCommit).toBe(aheadTwo);
    expect(originMainJson.templateHeadNotice).toBeUndefined();

    const applyText = await invokeTemplateUpgradeMain(
      stdout,
      stderr,
      ["apply", "--repository", repo, "--no-check"],
      runtime,
    );
    expect(applyText.exitCode).toBe(0);
    expect(applyText.stdout).toContain(`Target commit: ${headTarget}`);
    expect(applyText.stdout).toContain("2 commits behind origin/main");
  },
  processWatchdog(4),
);

test("readTemplateUpgradeChangeNotes, commit messages, and report builders handle empty, valid, and malformed notes", () => {
  expect(
    parseGitTreeEntries(
      Buffer.from("100644 blob abc123\tchange-notes/a.json\0"),
    ),
  ).toEqual(new Map([["change-notes/a.json", "100644 blob abc123"]]));
  const repo = folder("change-note-unit-");
  initRepository(repo);
  const first = commitIn(repo, "initial", { "README.md": "# Template\n" }).sha;
  expect(readTemplateUpgradeChangeNotes(repo, first, first, gitEnv)).toEqual(
    [],
  );

  const second = commitIn(repo, "add breaking and non-breaking notes", {
    "change-notes/README.md": "# Change notes\n",
    "change-notes/2026-11-22-non-breaking.json": JSON.stringify({
      kind: "added",
      breaking: false,
      affects: ["bootstrap"],
      summary: "Added report output.",
      action: null,
    }),
    "change-notes/2026-11-23-breaking.json": JSON.stringify({
      kind: "removed",
      breaking: true,
      affects: ["generated-repository"],
      summary: "Removed deprecated stamp.",
      action: "Delete old stamp file.",
    }),
  }).sha;
  const notes = readTemplateUpgradeChangeNotes(repo, first, second, gitEnv);
  expect(notes.map((entry) => entry.file)).toEqual([
    "2026-11-23-breaking.json",
    "2026-11-22-non-breaking.json",
  ]);
  const message = templateUpgradeCommitMessage(first, second, notes);
  expect(message).toContain(
    `Upgrade template ${first.slice(0, 7)} to ${second.slice(0, 7)}\n\nChange notes (2):`,
  );
  expect(message.indexOf("BREAKING (1):")).toBeLessThan(
    message.indexOf("Added (1):"),
  );
  expect(message).toContain("Action: Delete old stamp file.");

  const broken = commitIn(repo, "add invalid note", {
    "change-notes/2026-11-24-broken.json": "{not-json",
  }).sha;
  let refusal: CliError | undefined;
  try {
    readTemplateUpgradeChangeNotes(repo, second, broken, gitEnv);
  } catch (error) {
    if (error instanceof CliError) {
      refusal = error;
    }
  }
  expect(refusal?.code).toBe("change_note_invalid");
  expect(refusal?.message).toContain("invalid JSON");

  const inputs = {
    templateRoot: repo,
    repository: repo,
    repositoryHead: first,
    baseCommit: first,
    targetCommit: second,
    repositoryName: "demo",
    sourcePacket: "/abs/packet",
    repositoryPinnedCommit: "a".repeat(40),
    templatePinnedCommit: "a".repeat(40),
    templateHeadNotice:
      "Warning: template checkout HEAD is 1 commit behind origin/main. Repair: run git pull in the template, or pass --to origin/main.",
  };
  const plan = createTemplateUpgradePlanResult({
    inputs,
    status: "planned",
    rows: [],
    conflicts: [],
    sharedMerges: ["AGENTS.md"],
    dependencyChanges: [],
    templateCopyChanges: [],
    changeNotes: notes,
  });
  expect(plan.sharedMerges).toEqual(["AGENTS.md"]);
  expect(plan.changeNotes).toEqual(notes);
  expect(plan.templateHeadNotice).toContain("1 commit behind origin/main");

  const skipped = skipTemplateUpgradeSteps("--no-check");
  const applyRun = createTemplateUpgradeApplyRun({
    exitCode: 0,
    inputs,
    branch: "template-upgrade/1234567-abcdef0",
    status: "applied",
    changeNotes: notes,
    steps: skipped,
  });
  expect(applyRun.result.steps).toEqual(skipped);
  expect(applyRun.result.changeNotes).toEqual(notes);
  expect(applyRun.result.templateHeadNotice).toContain(
    "1 commit behind origin/main",
  );
});
