import { expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { CHANGE_NOTES_FOLDER } from "../../../scripts/change-notes.ts";
import {
  nextTemplateVersion,
  STARTING_TEMPLATE_VERSION,
  TEMPLATE_VERSIONS_FOLDER,
} from "../../../scripts/template-version-parse.ts";
import {
  cutTemplateVersion,
  defaultGitReader,
  type GitReadCommand,
  type GitReader,
} from "../../../scripts/template-version.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commit,
  git,
  gitEnv,
  initRepository,
} from "../../support/git-fixture.ts";
import { withEnvironment } from "../../support/recipe-fixture.ts";
import { studyCuts, studyNotes } from "./replay-notes-fixture.ts";

const folder = ownedFolders();
const readOnlySubcommands = new Set([
  "for-each-ref",
  "ls-tree",
  "diff",
  "cat-file",
]);

function inGitEnv<T>(run: () => T): Promise<T> {
  return withEnvironment(gitEnv, () => Promise.resolve(run()));
}

function recordingReader(): {
  readonly calls: {
    readonly command: GitReadCommand;
    readonly args: readonly string[];
  }[];
  readonly reader: GitReader;
} {
  const calls: {
    readonly command: GitReadCommand;
    readonly args: readonly string[];
  }[] = [];
  const reader: GitReader = (root, command, args) => {
    calls.push({ command, args });
    return defaultGitReader(root, command, args);
  };
  return { calls, reader };
}

async function replayStudyCuts(): Promise<{
  readonly repo: string;
  readonly replayedVersions: readonly string[];
  readonly generatedTexts: ReadonlyMap<string, string>;
}> {
  const repo = join(folder("template-version-replay-"), "repo");
  initRepository(repo);
  commit(repo, "init", {
    [`${CHANGE_NOTES_FOLDER}/README.md`]: "# Change notes\n",
  });

  const replayedVersions: string[] = [];
  const generatedTexts = new Map<string, string>();

  await inGitEnv(() => {
    for (const cutInfo of studyCuts) {
      for (const item of studyNotes.filter((n) => n.cut === cutInfo.cut)) {
        commit(repo, `PR #${item.pr}`, {
          [`${CHANGE_NOTES_FOLDER}/${item.file}`]: `${JSON.stringify(item.note, null, 2)}\n`,
        });
      }

      const recorder = recordingReader();
      const cut = cutTemplateVersion({
        root: repo,
        lead: cutInfo.lead,
        date: cutInfo.date,
        runGit: recorder.reader,
      });
      expect(cut.version).toBe(cutInfo.expectedVersion);
      expect(cut.written).toBe(true);
      expect(cut.relativePath).toBe(
        `${TEMPLATE_VERSIONS_FOLDER}/v${cutInfo.expectedVersion}.md`,
      );
      for (const call of recorder.calls)
        expect(readOnlySubcommands.has(call.command)).toBe(true);

      replayedVersions.push(cut.version);
      generatedTexts.set(cut.version, cut.text);

      commit(repo, `Cut template version ${cut.version}`, {
        [cut.relativePath]: cut.text,
      });
      git(repo, "tag", `v${cut.version}`);
    }
  });

  return { repo, replayedVersions, generatedTexts };
}

test("replays all 20 template study notes across the 3 cuts with read-only git and keeps every note", async () => {
  const { repo, replayedVersions, generatedTexts } = await replayStudyCuts();

  expect(replayedVersions).toEqual(["0.2.0", "0.3.0", "0.3.1"]);

  const remainingNotes = readdirSync(join(repo, CHANGE_NOTES_FOLDER)).filter(
    (name) => name.endsWith(".json"),
  );
  expect(remainingNotes.length).toBe(20);

  const v020 = generatedTexts.get("0.2.0") ?? "";
  expect(v020).toContain("# Template version 0.2.0 (2026-11-20)");
  expect(v020).toContain("10 internal changes omitted");
  expect(v020).toContain("## Breaking Changes");
  expect(v020).toContain("2026-11-20-remove-old-starters.json");
  expect(v020).toContain("recipe_source_missing");
});

test("replayed cuts v0.3.0 and v0.3.1 match the cold-test content and omit internal notes", async () => {
  const { generatedTexts } = await replayStudyCuts();

  const v030 = generatedTexts.get("0.3.0") ?? "";
  expect(v030).toContain("# Template version 0.3.0 (2026-11-21)");
  expect(v030).toContain("4 internal changes omitted");
  expect(v030).toContain("c0845947d44cd2b18f2a08685902f3f6efa38115");
  expect(v030).toContain("bun install");
  expect(v030).toContain(".agents/skills/verify-cli/SKILL.md");
  expect(v030).toContain(
    ".claude/skills/verify-cli -> ../../.agents/skills/verify-cli",
  );
  expect(v030).toContain("Remove check:write from package.json");
  expect(v030).toContain("bun run format");
  expect(v030).not.toContain("symbol-gate");
  expect(v030).not.toContain("code-name-fixes");
  expect(v030).not.toContain("names-check-test-area");

  const v031 = generatedTexts.get("0.3.1") ?? "";
  expect(v031).toContain("# Template version 0.3.1 (2026-11-21)");
  expect(v031).toContain("## Added");
  expect(v031).toContain("## Fixed");
  expect(v031).toContain(".github/workflows/ci.yml");
  expect(v031).toContain("426e5db");
  expect(v031).toContain(".worktrees/");
});

test("per-consumer-PR replay of the 20 study notes matches the 0.x caret trajectory", () => {
  let current = STARTING_TEMPLATE_VERSION;
  const trajectory: string[] = [];
  for (const item of studyNotes) {
    const next = nextTemplateVersion(current, [item.note]);
    if (next !== undefined) {
      current = next;
      trajectory.push(`#${item.pr}->${current}`);
    }
  }
  expect(trajectory).toEqual([
    "#131->0.2.0",
    "#134->0.2.1",
    "#135->0.3.0",
    "#140->0.3.1",
    "#141->0.3.2",
    "#142->0.3.3",
  ]);
});
