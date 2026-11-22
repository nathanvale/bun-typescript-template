import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { processWatchdog } from "../../support/process.ts";
import {
  emptyFolder,
  fixtureTree,
  runFixtureGit,
  hookCommands,
  removeFixtureTrees,
  repository,
  runHook,
} from "./fixture-tree.ts";
import { write } from "../../support/fixture-files.ts";

const claudeSettings = ".claude/settings.json";
const codexSettings = ".codex/hooks.json";
const silent = { stdout: "", stderr: "", exit: 0 };
const fixtureGlossaryRefuses = {
  mutationNotes:
    'docs/mutation-notes.md uses "mutation", which GLOSSARY.md lists under Avoid for "Planted fault". Repair: Look in the glossary first; rename it with "Planted fault".',
  hostFile:
    'src/host.ts uses "host" with no qualifier. Repair: Look in the glossary first; add a word that says which host it is.',
  allowlistFolder:
    'src/allowlist uses "allowlist", which GLOSSARY.md lists under Avoid for "Recorded hit". Repair: Look in the glossary first; rename it with "Recorded hit".',
};

afterAll(removeFixtureTrees);

async function gitTree(): Promise<string> {
  const tree = fixtureTree();
  await runFixtureGit(tree, "init", "--quiet", "--initial-branch=main");
  return tree;
}

function writeCall(filePath: string, cwd: string) {
  return {
    session_id: "fixture",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
    permission_mode: "default",
    hook_event_name: "PreToolUse",
    tool_name: "Write",
    tool_input: { file_path: filePath, content: "notes\n" },
    tool_use_id: "toolu_fixture",
  };
}

function beforeWrite(tree: string, filePath: string, cwd = tree) {
  const [command = ""] = hookCommands(tree, claudeSettings, "Write");
  return runHook(command, writeCall(filePath, cwd), {
    cwd,
    projectFolder: tree,
  });
}

function patchCall(patch: string, cwd: string) {
  return {
    session_id: "fixture",
    transcript_path: join(cwd, "transcript.jsonl"),
    cwd,
    hook_event_name: "PreToolUse",
    model: "fixture",
    turn_id: "turn_fixture",
    permission_mode: "default",
    tool_name: "apply_patch",
    tool_input: { command: patch },
    tool_use_id: "call_fixture",
  };
}

function beforePatch(tree: string, hunks: readonly string[], cwd = tree) {
  const [command = ""] = hookCommands(tree, codexSettings, "^apply_patch$");
  const patch = ["*** Begin Patch", ...hunks, "*** End Patch"].join("\n");
  return runHook(command, patchCall(patch, cwd), { cwd, projectFolder: tree });
}

test("NG.live Codex runs an executable names check hook before each apply_patch", () => {
  const [command = ""] = hookCommands(
    repository,
    codexSettings,
    "^apply_patch$",
  );
  const script = /\.codex\/hooks\/[\w-]+\.sh/.exec(command)?.[0] ?? "";
  expect(script).toBe(".codex/hooks/names-check.sh");
  expect(statSync(join(repository, script)).mode & 0o111).not.toBe(0);
});

test("the Codex names check hook is the Claude Code one, byte for byte", () => {
  expect(
    readFileSync(join(repository, ".codex/hooks/names-check.sh"), "utf8"),
  ).toBe(
    readFileSync(join(repository, ".claude/hooks/names-check.sh"), "utf8"),
  );
});

test(
  "NG.e a patch that adds a file with a refused name stops apply_patch with exit 2, judged from the session's folder",
  async () => {
    const tree = await gitTree();
    mkdirSync(join(tree, "docs"));
    expect(
      await beforePatch(
        tree,
        ["*** Add File: mutation-notes.md", "+notes"],
        join(tree, "docs"),
      ),
    ).toEqual({
      stdout: "",
      stderr: `${fixtureGlossaryRefuses.mutationNotes}\n`,
      exit: 2,
    });
  },
  processWatchdog(2),
);

test(
  "NG.f a patch that moves a file to a refused name stops apply_patch with exit 2",
  async () => {
    const tree = await gitTree();
    write(tree, "src/test-host.ts", "export {};\n");
    expect(
      await beforePatch(tree, [
        "*** Update File: src/test-host.ts",
        `*** Move to: ${join(tree, "src/host.ts")}`,
        "@@",
        "-export {};",
        "+export const moved = true;",
      ]),
    ).toEqual({
      stdout: "",
      stderr: `${fixtureGlossaryRefuses.hostFile}\n`,
      exit: 2,
    });
  },
  processWatchdog(2),
);

test(
  "a patch that updates, deletes and cleanly adds files passes in silence",
  async () => {
    const tree = await gitTree();
    write(tree, "docs/mutation-notes.md", "notes\n");
    write(tree, "src/host.ts", "export {};\n");
    expect(
      await beforePatch(tree, [
        "*** Add File: docs/planted-fault-notes.md",
        "+*** Add File: docs/allowlist.md",
        "*** Delete File: src/host.ts",
        "*** Update File: docs/mutation-notes.md",
        "@@",
        " *** Move to: docs/allowlist.md",
        "-notes",
        "+note",
      ]),
    ).toEqual(silent);
  },
  processWatchdog(2),
);

test("NG.live Claude Code runs an executable names check hook before each Write", () => {
  const [command = ""] = hookCommands(repository, claudeSettings, "Write");
  const script = /\.claude\/hooks\/[\w-]+\.sh/.exec(command)?.[0] ?? "";
  expect(script).toBe(".claude/hooks/names-check.sh");
  expect(statSync(join(repository, script)).mode & 0o111).not.toBe(0);
});

test(
  "NG.a a new file whose name is refused stops the Write with exit 2 and the problem line",
  async () => {
    const tree = await gitTree();
    expect(
      await beforeWrite(tree, join(tree, "docs/mutation-notes.md")),
    ).toEqual({
      stdout: "",
      stderr: `${fixtureGlossaryRefuses.mutationNotes}\n`,
      exit: 2,
    });
  },
  processWatchdog(2),
);

test(
  "a Write to a file that already exists is an edit, and passes in silence",
  async () => {
    const tree = await gitTree();
    write(tree, "docs/mutation-notes.md", "notes\n");
    expect(
      await beforeWrite(tree, join(tree, "docs/mutation-notes.md")),
    ).toEqual(silent);
  },
  processWatchdog(2),
);

test(
  "a new file with a clean name passes in silence",
  async () => {
    const tree = await gitTree();
    expect(
      await beforeWrite(tree, join(tree, "docs/planted-fault-notes.md")),
    ).toEqual(silent);
  },
  processWatchdog(2),
);

test(
  "a new file in a tree with no names check is outside the repository, and passes in silence",
  async () => {
    const tree = await gitTree();
    const elsewhere = emptyFolder();
    await runFixtureGit(elsewhere, "init", "--quiet", "--initial-branch=main");
    expect(
      await beforeWrite(tree, join(elsewhere, "docs/mutation-notes.md")),
    ).toEqual(silent);
  },
  processWatchdog(3),
);

test(
  "NG.b a new folder on the path is judged, and a folder that exists is not",
  async () => {
    const tree = await gitTree();
    mkdirSync(join(tree, "docs/proof"), { recursive: true });
    expect(
      await beforeWrite(tree, join(tree, "docs/proof/planted-fault-notes.md")),
    ).toEqual(silent);
    expect(
      await beforeWrite(tree, join(tree, "src/allowlist/index.ts")),
    ).toEqual({
      stdout: "",
      stderr: `${fixtureGlossaryRefuses.allowlistFolder}\n`,
      exit: 2,
    });
  },
  processWatchdog(3),
);

test(
  "NG.c a tool call the gate cannot read stops the call with exit 2 and a notice",
  async () => {
    const tree = await gitTree();
    const [command = ""] = hookCommands(tree, claudeSettings, "Write");
    const call = { tool_name: "Bash", tool_input: { command: "ls" } };
    expect(
      await runHook(command, call, { cwd: tree, projectFolder: tree }),
    ).toEqual({
      stdout: "",
      stderr: [
        "--tool-call reads a Write call's file_path and an apply_patch call's command, not a Bash call. Repair: wire the names check hook to those two tools.",
        "names check hook: check:names --tool-call exited 2 (cause above), so the names this tool call creates went unchecked and the call is stopped. Repair: fix the cause above, or run bun run check:names <path> for each path it creates. Done when that command passes.",
        "",
      ].join("\n"),
      exit: 2,
    });
  },
  processWatchdog(2),
);

test(
  "NG.g a Write call with no file_path stops the call with exit 2, naming the missing field",
  async () => {
    const tree = await gitTree();
    const [command = ""] = hookCommands(tree, claudeSettings, "Write");
    const call = { tool_name: "Write", tool_input: {} };
    expect(
      await runHook(command, call, { cwd: tree, projectFolder: tree }),
    ).toEqual({
      stdout: "",
      stderr: [
        "--tool-call got a Write call whose tool_input has no string file_path, so it cannot tell which names the call creates. Repair: pass the tool call as the hook receives it.",
        "names check hook: check:names --tool-call exited 2 (cause above), so the names this tool call creates went unchecked and the call is stopped. Repair: fix the cause above, or run bun run check:names <path> for each path it creates. Done when that command passes.",
        "",
      ].join("\n"),
      exit: 2,
    });
  },
  processWatchdog(2),
);

const brokenCheckNotice =
  "names check hook: check:names --tool-call exited 2 (cause above), so the names this tool call creates went unchecked and the call is stopped. Repair: fix the cause above, or run bun run check:names <path> for each path it creates. Done when that command passes.";

test(
  "NG.h a Write in this repository whose GLOSSARY.md is missing stops with exit 2 and the repair, where a foreign repository passes",
  async () => {
    const tree = await gitTree();
    rmSync(join(tree, "GLOSSARY.md"));
    const [command = ""] = hookCommands(tree, claudeSettings, "Write");
    const from = { cwd: tree, projectFolder: tree };
    expect(
      await runHook(
        command,
        writeCall(join(tree, "docs/mutation-notes.md"), tree),
        from,
      ),
    ).toEqual({
      stdout: "",
      stderr: `names check: ${tree} has no GLOSSARY.md or no tests/template/names-check/recorded-hits.json, so it cannot judge the names this call creates. Repair: restore both with git restore GLOSSARY.md tests/template/names-check/recorded-hits.json.\n${brokenCheckNotice}\n`,
      exit: 2,
    });
    const elsewhere = emptyFolder();
    await runFixtureGit(elsewhere, "init", "--quiet", "--initial-branch=main");
    expect(
      await runHook(
        command,
        writeCall(join(elsewhere, "docs/mutation-notes.md"), tree),
        from,
      ),
    ).toEqual(silent);
  },
  processWatchdog(3),
);

test(
  "NG.i a malformed tool call payload stops the Write with exit 2",
  async () => {
    const tree = await gitTree();
    const [command = ""] = hookCommands(tree, claudeSettings, "Write");
    const outcome = await runHook(command, "{ not json", {
      cwd: tree,
      projectFolder: tree,
    });
    expect(outcome.exit).toBe(2);
    expect(outcome.stderr).toEndWith(`${brokenCheckNotice}\n`);
  },
  processWatchdog(2),
);

test(
  "NG.d from a nested folder of a git worktree, a new file is judged by the glossary of the tree that owns it",
  async () => {
    const main = await gitTree();
    await runFixtureGit(main, "add", "--", ".");
    await runFixtureGit(main, "commit", "--quiet", "-m", "base");
    await runFixtureGit(main, "worktree", "add", "--quiet", ".worktrees/other");
    const other = join(main, ".worktrees/other");
    write(
      other,
      "GLOSSARY.md",
      "**Fixture**:\nA made-up input.\n_Avoid_: specimen\n",
    );
    mkdirSync(join(other, "docs"));
    const nowhere = join(emptyFolder(), "missing");
    const [command = ""] = hookCommands(other, claudeSettings, "Write");
    const from = { cwd: join(other, "docs"), projectFolder: nowhere };
    expect(
      await runHook(
        command,
        writeCall(join(other, "docs/mutation-notes.md"), from.cwd),
        from,
      ),
    ).toEqual(silent);
    expect(
      await runHook(
        command,
        writeCall(join(other, "docs/specimen.md"), from.cwd),
        from,
      ),
    ).toEqual({
      stdout: "",
      stderr:
        'docs/specimen.md uses "specimen", which GLOSSARY.md lists under Avoid for "Fixture". Repair: Look in the glossary first; rename it with "Fixture".\n',
      exit: 2,
    });
    expect(
      await beforeWrite(main, join(other, "docs/specimen.md")),
    ).toMatchObject({ exit: 2 });
  },
  processWatchdog(7),
);
