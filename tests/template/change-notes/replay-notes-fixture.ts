import type { ChangeNote } from "../../../scripts/change-notes.ts";

export type StudyNote = {
  readonly pr: number;
  readonly cut: 1 | 2 | 3;
  readonly file: string;
  readonly note: ChangeNote;
};

export type StudyCut = {
  readonly cut: 1 | 2 | 3;
  readonly date: string;
  readonly lead: string;
  readonly expectedVersion: string;
};

export const studyCuts: readonly StudyCut[] = [
  {
    cut: 1,
    date: "2026-11-20",
    lead: "Bootstrap moves to one shape: every generated repository now uses the installed kernel at the template's Pin, and the old profiles and starters are gone.",
    expectedVersion: "0.2.0",
  },
  {
    cut: 2,
    date: "2026-11-21",
    lead: "Generated repositories get the verify-cli pointer skill at the newer kernel Pin, and the old check:write script alias is removed.",
    expectedVersion: "0.3.0",
  },
  {
    cut: 3,
    date: "2026-11-21",
    lead: "Generated repositories now include a GitHub hosted check and ignore .worktrees/, and the kernel Pin brings interactive menus and default commands.",
    expectedVersion: "0.3.1",
  },
];

export const studyNotes: readonly StudyNote[] = [
  {
    pr: 123,
    cut: 1,
    file: "2026-11-20-pin-move-fetch-remote-tip.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Fixed the template maintainer pin-move script to fetch the remote kernel tip before checking ancestry; no effect on Bootstrap or generated repositories.",
      action: null,
    },
  },
  {
    pr: 125,
    cut: 1,
    file: "2026-11-20-template-pointer-fixes.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Updated template-repository docs, agent instructions, and glossary pointers after the kernel split with no effect on shipped files.",
      action: null,
    },
  },
  {
    pr: 126,
    cut: 1,
    file: "2026-11-20-flaky-pin-verification-test.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Fixed pin-verification flake by sharing the remote tip fetch helper and disabling background git maintenance during fetches; template tooling only.",
      action: null,
    },
  },
  {
    pr: 124,
    cut: 1,
    file: "2026-11-20-readme-names-kernel-row.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Documented the --kernel Bootstrap option in the template README with no runtime or generated-repository change.",
      action: null,
    },
  },
  {
    pr: 127,
    cut: 1,
    file: "2026-11-20-fix-glossary-checks.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Tightened the template repository's own glossary and names-check hooks and scripts; no effect on generated repositories.",
      action: null,
    },
  },
  {
    pr: 128,
    cut: 1,
    file: "2026-11-20-split-glossary-preparation.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Prepared template glossary ownership metadata and shared-tool-words export for transferring kernel terms to agent-cli-kernel.",
      action: null,
    },
  },
  {
    pr: 129,
    cut: 1,
    file: "2026-11-20-split-glossary-cleanup.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Removed 14 kernel-owned glossary entries from the template glossary after agent-cli-kernel accepted ownership.",
      action: null,
    },
  },
  {
    pr: 130,
    cut: 1,
    file: "2026-11-20-comment-cleanup.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Removed redundant inline comments across template sources (including Bootstrap and recipe modules), scripts, and tests with no behaviour change.",
      action: null,
    },
  },
  {
    pr: 131,
    cut: 1,
    file: "2026-11-20-remove-old-starters.json",
    note: {
      kind: "removed",
      breaking: true,
      affects: ["bootstrap", "generated-repository", "lint-rules"],
      summary:
        "Removed old profiles, CLI starters, monorepo shape, and the --profile, --starter, --monorepo, and --kernel Bootstrap flags so Bootstrap generates only the kernel-pinned shape; turned on repository/no-locale-compare and repository/no-in-operator for scripts/ and added scripts/ to generated tsconfig.json.",
      action:
        "Remove --profile, --starter, --monorepo, and --kernel from Bootstrap calls, drop profile/starter/variant reads from .cli-design-template.json or --json consumers, update refusal checks to recipe_source_missing and recipe_source_wrong_type, and in existing generated repositories add scripts/ to tsconfig.json and the scripts/ typed-lint block to eslint.config.mjs.",
    },
  },
  {
    pr: 132,
    cut: 1,
    file: "2026-11-20-readme-one-shape.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Updated the template README to match the single kernel-pinned Bootstrap shape after removing old starters.",
      action: null,
    },
  },
  {
    pr: 133,
    cut: 1,
    file: "2026-11-20-glossary-text-fixes.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Shortened template glossary definitions and moved mechanics into docs/ with no effect on shipped template files.",
      action: null,
    },
  },
  {
    pr: 134,
    cut: 2,
    file: "2026-11-21-ready-template-for-remote-dev.json",
    note: {
      kind: "added",
      breaking: false,
      affects: ["kernel-pin", "generated-repository", "bootstrap"],
      summary:
        "Moved the template's kernel Pin from 9d5d5a81 to c0845947 (bringing verify-cli) and added the .agents/skills/verify-cli/SKILL.md pointer skill (symlinked into .claude/skills/verify-cli) to generated repositories.",
      action:
        "In existing generated repositories, update agent-cli-kernel to commit c0845947d44cd2b18f2a08685902f3f6efa38115 in package.json, run bun install to refresh bun.lock, copy .agents/skills/verify-cli/SKILL.md, and create symlink .claude/skills/verify-cli -> ../../.agents/skills/verify-cli.",
    },
  },
  {
    pr: 135,
    cut: 2,
    file: "2026-11-21-tooling-names.json",
    note: {
      kind: "removed",
      breaking: true,
      affects: ["generated-repository"],
      summary:
        "Removed the check:write script alias from generated repositories' package.json (callers use format directly).",
      action:
        "Remove check:write from package.json in existing generated repositories and replace any script, hook, or workflow calls to bun run check:write with bun run format.",
    },
  },
  {
    pr: 136,
    cut: 2,
    file: "2026-11-21-code-name-fixes.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Renamed template-internal symbols (NamesCheckResult, GitFile, KernelRoot) and recipe test fixture paths with no effect on Bootstrap or generated repositories.",
      action: null,
    },
  },
  {
    pr: 137,
    cut: 2,
    file: "2026-11-21-names-check-test-area.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Moved the template's internal naming test folder to tests/template/names-check/ with no effect on shipped files.",
      action: null,
    },
  },
  {
    pr: 138,
    cut: 2,
    file: "2026-11-21-symbol-gate.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Added the template-internal symbol gate to check:names and renamed internal identifiers (Copy -> RecipeCopy, project -> repositoryRoot) in src/recipe.ts and src/bootstrap.ts with no consumer effect.",
      action: null,
    },
  },
  {
    pr: 139,
    cut: 2,
    file: "2026-11-21-symbol-gate-test-watchdogs.json",
    note: {
      kind: "none",
      breaking: false,
      affects: [],
      summary:
        "Added explicit processWatchdog timeouts to template symbol-gate tests with no shipped-file change.",
      action: null,
    },
  },
  {
    pr: 140,
    cut: 3,
    file: "2026-11-21-bootstrap-generates-hosted-check.json",
    note: {
      kind: "added",
      breaking: false,
      affects: ["bootstrap", "generated-repository"],
      summary:
        "Added .github/workflows/ci.yml (Hosted check running bun install --frozen-lockfile and bun run check on PRs and pushes to main) to Bootstrap's generated-repository recipe.",
      action:
        "Copy .github/workflows/ci.yml into existing generated repositories that were bootstrapped without a GitHub Actions hosted check.",
    },
  },
  {
    pr: 141,
    cut: 3,
    file: "2026-11-21-generated-gitignore-worktrees.json",
    note: {
      kind: "fixed",
      breaking: false,
      affects: ["generated-repository"],
      summary:
        "Added .worktrees/ to generated-repository/settings/.gitignore so local git worktrees are ignored without relying on a personal global exclude file.",
      action:
        "Add .worktrees/ to .gitignore in existing generated repositories.",
    },
  },
  {
    pr: 142,
    cut: 3,
    file: "2026-11-21-pin-move-menu-default-command.json",
    note: {
      kind: "added",
      breaking: false,
      affects: ["kernel-pin", "generated-repository"],
      summary:
        "Moved the template's kernel Pin from c0845947 to 426e5db (bringing defaultCommand, the menu add-on, and the Author skill's changing-commands guide), refreshed the agent-cli-kernel pointer skill, and added menu start-up tests to generated repositories.",
      action:
        "In existing generated repositories, update agent-cli-kernel to commit 426e5db in package.json, regenerate bun.lock, refresh .agents/skills/agent-cli-kernel/SKILL.md, and optionally add menu start-up cases to tests/add-on-start-up.test.ts.",
    },
  },
];
