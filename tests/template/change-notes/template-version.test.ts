import { expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import {
  CHANGE_NOTES_FOLDER,
  type ChangeNote,
} from "../../../scripts/change-notes.ts";
import { TEMPLATE_VERSIONS_FOLDER } from "../../../scripts/template-version-parse.ts";
import {
  cutTemplateVersion,
  defaultGitReader,
  type GitReadCommand,
  type GitReader,
  latestTemplateVersionTag,
  readChangeNotesSince,
  runTemplateVersion,
} from "../../../scripts/template-version.ts";
import { ownedFolders, write } from "../../support/fixture-files.ts";
import {
  commit,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { withEnvironment } from "../../support/recipe-fixture.ts";

const ROOT = resolve(import.meta.dir, "../../..");
const folder = ownedFolders();

const readOnlySubcommands = new Set([
  "for-each-ref",
  "ls-tree",
  "diff",
  "cat-file",
]);

function note(overrides: Partial<ChangeNote> = {}): ChangeNote {
  return {
    kind: "added",
    breaking: false,
    affects: ["bootstrap"],
    summary: "Added template capability.",
    action: null,
    ...overrides,
  };
}

function inGitEnv<T>(run: () => T): Promise<T> {
  return withEnvironment(gitEnv, () => Promise.resolve(run()));
}

function makeRepository(initialNotes: Record<string, string> = {}): string {
  const repo = join(folder("template-version-"), "repo");
  initRepository(repo);
  commit(repo, "init", {
    [`${CHANGE_NOTES_FOLDER}/README.md`]: "# Change notes\n",
    ...initialNotes,
  });
  return repo;
}

function makeAddedCiRepository(): {
  readonly repo: string;
  readonly noteRel: string;
} {
  const noteRel = `${CHANGE_NOTES_FOLDER}/2026-11-22-added-ci.json`;
  const repo = makeRepository({
    [noteRel]: JSON.stringify(
      note({
        kind: "added",
        breaking: false,
        affects: ["bootstrap", "generated-repository"],
        summary: "Added hosted check workflow to generated repositories.",
        action: "Copy .github/workflows/ci.yml into existing repositories.",
      }),
    ),
  });
  return { repo, noteRel };
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

function makeGitRecorderStub(stubFolder: string): {
  readonly binDir: string;
  readonly logFile: string;
} {
  const realGit = Bun.which("git");
  if (realGit === null) throw new Error("git binary not found on PATH.");
  const binDir = join(stubFolder, "bin");
  const logFile = join(stubFolder, "git-calls.log");
  write(
    binDir,
    "git",
    [
      "#!/bin/sh",
      `printf '%s\\n' "$*" >> ${JSON.stringify(logFile)}`,
      `exec ${JSON.stringify(realGit)} "$@"`,
      "",
    ].join("\n"),
  );
  chmodSync(join(binDir, "git"), 0o755);
  return { binDir, logFile };
}

test("requires --lead and refuses invalid CLI arguments with exit code 2", async () => {
  const repo = makeRepository();
  await inGitEnv(() => {
    const missingLead = runTemplateVersion(["--root", repo], repo);
    expect(missingLead.code).toBe(2);
    expect(missingLead.stderr).toContain('Missing required flag "--lead"');

    const flagAsLead = runTemplateVersion(
      ["--lead", "--print", "--root", repo],
      repo,
    );
    expect(flagAsLead.code).toBe(2);
    expect(flagAsLead.stderr).toContain('Missing value for "--lead"');

    const unknown = runTemplateVersion(
      ["--lead", "Summary.", "--unknown", "--root", repo],
      repo,
    );
    expect(unknown.code).toBe(2);
    expect(unknown.stderr).toContain('Unknown argument "--unknown"');

    const duplicatePrint = runTemplateVersion(
      ["--lead", "Summary.", "--print", "--print", "--root", repo],
      repo,
    );
    expect(duplicatePrint.code).toBe(2);
    expect(duplicatePrint.stderr).toContain('Duplicate flag "--print"');

    const blankLead = runTemplateVersion(
      ["--lead", "   ", "--root", repo],
      repo,
    );
    expect(blankLead.code).toBe(1);
    expect(blankLead.stderr).toContain("Lead sentence is required.");
  });
});

test("refuses when there are no notes or only kind none notes since the last tag", async () => {
  const repo = makeRepository({
    [`${CHANGE_NOTES_FOLDER}/2026-11-20-internal.json`]: JSON.stringify(
      note({
        kind: "none",
        breaking: false,
        affects: [],
        summary: "Internal refactor.",
        action: null,
      }),
    ),
  });

  await inGitEnv(() => {
    const noneOnly = runTemplateVersion(
      ["--lead", "Should not cut.", "--date", "2026-11-20", "--root", repo],
      repo,
    );
    expect(noneOnly.code).toBe(1);
    expect(noneOnly.stderr).toContain(
      'Only internal (kind: "none") change notes (1)',
    );
    expect(existsSync(join(repo, TEMPLATE_VERSIONS_FOLDER))).toBe(false);

    git(repo, "tag", "v0.1.0");
    const noNew = runTemplateVersion(
      ["--lead", "No new notes.", "--date", "2026-11-20", "--root", repo],
      repo,
    );
    expect(noNew.code).toBe(1);
    expect(noNew.stderr).toContain("No new change notes found since v0.1.0");
  });
});

test("prints without writing in --print mode and leaves notes intact", async () => {
  const { repo, noteRel } = makeAddedCiRepository();
  await inGitEnv(() => {
    const recorder = recordingReader();
    const printed = runTemplateVersion(
      [
        "--lead",
        "Generated repositories now include a GitHub hosted check.",
        "--date",
        "2026-11-22",
        "--print",
        "--root",
        repo,
      ],
      repo,
      recorder.reader,
    );
    expect(printed.code).toBe(0);
    expect(printed.stderr).toBe("");
    expect(printed.stdout).toContain("# Template version 0.1.1 (2026-11-22)");
    expect(existsSync(join(repo, TEMPLATE_VERSIONS_FOLDER))).toBe(false);
    expect(existsSync(join(repo, noteRel))).toBe(true);
    expect(recorder.calls.length).toBeGreaterThan(0);
    for (const call of recorder.calls)
      expect(readOnlySubcommands.has(call.command)).toBe(true);
  });
});

test("writes only the version file in write mode, deletes no note, and runs only read-only git commands", async () => {
  const { repo, noteRel } = makeAddedCiRepository();
  const baseArgs = [
    "--lead",
    "Generated repositories now include a GitHub hosted check.",
    "--date",
    "2026-11-22",
    "--root",
    repo,
  ];
  await inGitEnv(() => {
    const headBefore = git(repo, "rev-parse", "HEAD");
    const tagsBefore = git(repo, "tag", "-l");
    const recorder = recordingReader();
    const printed = runTemplateVersion(
      [...baseArgs, "--print"],
      repo,
      recorder.reader,
    );
    const written = runTemplateVersion(baseArgs, repo, recorder.reader);
    expect(written.code).toBe(0);
    expect(written.stdout).toContain(
      "Wrote template-versions/v0.1.1.md (0.1.0 -> 0.1.1",
    );
    expect(
      readFileSync(join(repo, TEMPLATE_VERSIONS_FOLDER, "v0.1.1.md"), "utf8"),
    ).toBe(printed.stdout);
    expect(existsSync(join(repo, noteRel))).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "tag", "-l")).toBe(tagsBefore);
    for (const call of recorder.calls)
      expect(readOnlySubcommands.has(call.command)).toBe(true);
  });
});

test("refuses to overwrite an existing template version file", async () => {
  const { repo } = makeAddedCiRepository();
  await inGitEnv(() => {
    const first = runTemplateVersion(
      ["--lead", "First run.", "--date", "2026-11-22", "--root", repo],
      repo,
    );
    expect(first.code).toBe(0);

    const overwriteAttempt = runTemplateVersion(
      ["--lead", "Duplicate run.", "--date", "2026-11-22", "--root", repo],
      repo,
    );
    expect(overwriteAttempt.code).toBe(1);
    expect(overwriteAttempt.stderr).toContain(
      "template-versions/v0.1.1.md already exists",
    );
  });
});

test("refuses symlinked notes in HEAD", async () => {
  const linkRepo = makeRepository();
  write(linkRepo, "outside.json", JSON.stringify(note()));
  symlinkSync(
    "../outside.json",
    join(linkRepo, CHANGE_NOTES_FOLDER, "2026-11-22-linked.json"),
  );
  git(
    linkRepo,
    "add",
    "outside.json",
    `${CHANGE_NOTES_FOLDER}/2026-11-22-linked.json`,
  );
  git(linkRepo, "commit", "--quiet", "-m", "symlink note");

  await inGitEnv(() => {
    expect(() =>
      readChangeNotesSince(linkRepo, undefined, defaultGitReader),
    ).toThrow("must be a plain file in HEAD");
  });
});

test("refuses non-UTF-8 notes in HEAD", async () => {
  const badBytesRepo = makeRepository();
  writeFileSync(
    join(badBytesRepo, CHANGE_NOTES_FOLDER, "2026-11-22-bytes.json"),
    new Uint8Array([0xff, 0xfe]),
  );
  git(badBytesRepo, "add", `${CHANGE_NOTES_FOLDER}/2026-11-22-bytes.json`);
  git(badBytesRepo, "commit", "--quiet", "-m", "bad bytes");

  await inGitEnv(() => {
    expect(() =>
      readChangeNotesSince(badBytesRepo, undefined, defaultGitReader),
    ).toThrow("is not valid UTF-8 text");
  });
});

test("refuses a symlinked template-versions folder", async () => {
  const symlinkFolderRepo = makeRepository({
    [`${CHANGE_NOTES_FOLDER}/2026-11-22-valid.json`]: JSON.stringify(note()),
  });
  const outsideDir = folder("outside-versions-");
  symlinkSync(outsideDir, join(symlinkFolderRepo, TEMPLATE_VERSIONS_FOLDER));

  await inGitEnv(() => {
    expect(() =>
      cutTemplateVersion({
        root: symlinkFolderRepo,
        lead: "Should refuse symlink folder.",
        date: "2026-11-22",
      }),
    ).toThrow("template-versions must be a plain folder");
  });
});

test("ignores non-version tags and tags on unmerged branches when finding the latest version tag", async () => {
  const repo = makeRepository({
    [`${CHANGE_NOTES_FOLDER}/2026-11-20-first.json`]: JSON.stringify(note()),
  });
  git(repo, "tag", "glossary-split-20261120");
  git(repo, "tag", "v0.2.0");

  git(repo, "checkout", "-b", "side-branch");
  commit(repo, "side commit", {
    [`${CHANGE_NOTES_FOLDER}/2026-11-21-side.json`]: JSON.stringify(note()),
  });
  git(repo, "tag", "v0.9.0");

  git(repo, "checkout", "main");
  commit(repo, "main commit", {
    [`${CHANGE_NOTES_FOLDER}/2026-11-21-second.json`]: JSON.stringify(note()),
  });
  git(repo, "tag", "v0.10.0");
  commit(repo, "main commit after v0.10.0", {
    [`${CHANGE_NOTES_FOLDER}/2026-11-22-third.json`]: JSON.stringify(note()),
  });

  await inGitEnv(() => {
    const latest = latestTemplateVersionTag(repo);
    expect(latest).toEqual({ tag: "v0.10.0", version: "0.10.0" });
    const added = readChangeNotesSince(repo, latest?.tag);
    expect(added.map((entry) => entry.file)).toEqual(["2026-11-22-third.json"]);
  });
});

test(
  "runs the production CLI entry and executes zero git write commands",
  async () => {
    const repo = makeRepository({
      [`${CHANGE_NOTES_FOLDER}/2026-11-22-cli.json`]: JSON.stringify(
        note({
          kind: "fixed",
          affects: ["generated-repository"],
          summary: "Fixed generated .gitignore.",
          action: "Add .worktrees/ to .gitignore.",
        }),
      ),
    });
    const stub = makeGitRecorderStub(folder("git-stub-"));
    const headBefore = git(repo, "rev-parse", "HEAD");
    const tagsBefore = git(repo, "tag", "-l");
    const baseEnv = inherited();
    const run = await spawnBounded(
      [
        process.execPath,
        "run",
        join(ROOT, "scripts/template-version.ts"),
        "--lead",
        "Generated repositories ignore .worktrees/ by default.",
        "--date",
        "2026-11-22",
        "--root",
        repo,
      ],
      {
        cwd: ROOT,
        env: {
          ...baseEnv,
          ...gitEnv,
          PATH: `${stub.binDir}${delimiter}${baseEnv.PATH ?? ""}`,
        },
        processGroup: true,
      },
    );

    expect(run.exit).toBe(0);
    expect(run.stderr).toBe("");
    expect(run.stdout).toContain(
      "Wrote template-versions/v0.1.1.md (0.1.0 -> 0.1.1",
    );
    expect(git(repo, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repo, "tag", "-l")).toBe(tagsBefore);

    const recordedLines = readFileSync(stub.logFile, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line !== "");
    expect(recordedLines.length).toBeGreaterThan(0);
    for (const line of recordedLines) {
      const [subcommand = ""] = line.split(" ");
      expect(readOnlySubcommands.has(subcommand)).toBe(true);
    }
  },
  processWatchdog(1),
);
