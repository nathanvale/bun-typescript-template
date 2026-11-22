import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { delimiter, dirname, join } from "node:path";
import {
  type RecordedHit,
  recordedHitsFile,
} from "../../../scripts/glossary.ts";
import { write } from "../../support/fixture-files.ts";
import { gitEnv, inherited } from "../../support/git-fixture.ts";
import { spawnBounded } from "../../support/process.ts";
import { testFolder } from "../../support/test-folder.ts";
import { publicSurfaceFile } from "../../../scripts/public-surface.ts";

export const repository = join(import.meta.dir, "../../..");

const glossary = `# Fixture glossary

**Planted fault**:
A deliberate break in a guard.
_Avoid_: mutant, mutation

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

_Qualify_: host, proof
`;
export const fileSizeRecordedHitsPath = "scripts/file-size-recorded-hits.json";
export const fileSizeHits = {
  standing: "tests/planted-faults/fault-records.json",
  glossary: "tests/template/glossary/glossary.test.ts",
  integration: "tests/template/integration/integration.test.ts",
} as const;
const fileSizeRecordedHits = JSON.stringify({
  [fileSizeHits.standing]: {
    lifetime: "standing",
    reason: "Fixture: a standing recorded hit.",
  },
  [fileSizeHits.glossary]: {
    lifetime: "temporary",
    reason: "Fixture: a temporary recorded hit.",
  },
  [fileSizeHits.integration]: {
    lifetime: "temporary",
    reason: "Fixture: a second temporary recorded hit.",
  },
});
const sources = [
  "scripts/check-names.ts",
  "scripts/check-file-size.ts",
  "scripts/glossary.ts",
  "scripts/glossary-additions.ts",
  "scripts/public-surface.ts",
  "scripts/public-declarations.ts",
  "scripts/staged-texts.ts",
  "scripts/surface-match.ts",
  "scripts/glossary-map.ts",
  "scripts/glossary-ownership.ts",
  "scripts/name-moves.ts",
  "scripts/name-words.ts",
  "scripts/plain-words.ts",
  "scripts/process-runner.ts",
  "scripts/repository.ts",
  ".claude/settings.json",
  ".claude/hooks/names-check.sh",
  ".codex/hooks.json",
  ".codex/hooks/names-check.sh",
  ".githooks/pre-commit",
];
const folders: string[] = [];
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };

export function removeFixtureTrees(): void {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true });
}

export function writeRecordedHits(
  root: string,
  recorded: readonly RecordedHit[],
): void {
  write(root, recordedHitsFile, JSON.stringify({ hits: recorded }));
}

export function emptyFolder(): string {
  const folder = testFolder("names-tree-");
  folders.push(folder);
  return folder;
}

export function fixtureTree(recorded: readonly RecordedHit[] = []): string {
  const root = join(emptyFolder(), "tree");
  for (const path of sources) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    copyFileSync(join(repository, path), join(root, path));
    chmodSync(join(root, path), statSync(join(repository, path)).mode);
  }
  write(root, "GLOSSARY.md", glossary);
  write(root, fileSizeRecordedHitsPath, fileSizeRecordedHits);
  writeRecordedHits(root, recorded);
  write(
    root,
    publicSurfaceFile,
    JSON.stringify({ exports: [], consumedExports: [], importers: [] }),
  );
  write(
    root,
    "package.json",
    JSON.stringify({
      scripts: {
        "check:names": production["check:names"],
        "check:file-size": production["check:file-size"],
      },
    }),
  );
  return root;
}

export function runInFixture(
  argv: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> = {},
) {
  return spawnBounded(argv, {
    cwd,
    env: {
      ...inherited(),
      ...gitEnv,
      PATH: `${dirname(process.execPath)}${delimiter}${process.env.PATH ?? ""}`,
      ...env,
    },
  });
}

export function gitOutcome(root: string, ...args: string[]) {
  return runInFixture(["git", ...args], root);
}

export async function runFixtureGit(
  root: string,
  ...args: string[]
): Promise<void> {
  const { exit, stderr } = await gitOutcome(root, ...args);
  if (exit !== 0) throw new Error(`git ${args.join(" ")}: ${stderr}`);
}

export async function fixtureRepository(
  recorded: readonly RecordedHit[] = [],
): Promise<string> {
  const root = fixtureTree(recorded);
  await runFixtureGit(root, "init", "--quiet", "--initial-branch=main");
  await runFixtureGit(
    root,
    "add",
    "--",
    "GLOSSARY.md",
    recordedHitsFile,
    fileSizeRecordedHitsPath,
    publicSurfaceFile,
  );
  await runFixtureGit(root, "commit", "--quiet", "-m", "rules");
  return root;
}

export function checkNames(root: string, args: readonly string[]) {
  return runInFixture(
    [process.execPath, "run", "--silent", "check:names", ...args],
    root,
  );
}

export function checkNamesFrom(
  root: string,
  folder: string,
  args: readonly string[],
) {
  return runInFixture(
    [process.execPath, join(root, "scripts/check-names.ts"), ...args],
    folder,
  );
}

type HookEntry = {
  readonly matcher: string;
  readonly hooks: readonly { readonly command: string }[];
};

export function hookCommands(
  root: string,
  settings: string,
  matcher: string,
): string[] {
  const { hooks } = JSON.parse(readFileSync(join(root, settings), "utf8")) as {
    hooks: { PreToolUse: readonly HookEntry[] };
  };
  return hooks.PreToolUse.filter((entry) => entry.matcher === matcher).flatMap(
    (entry) => entry.hooks.map((hook) => hook.command),
  );
}

export function runHook(
  command: string,
  call: unknown,
  { cwd, projectFolder }: { cwd: string; projectFolder: string },
) {
  const input = join(emptyFolder(), "tool-call.json");
  writeFileSync(input, typeof call === "string" ? call : JSON.stringify(call));
  return runInFixture(["/bin/sh", "-c", `( ${command} ) < "$TOOL_CALL"`], cwd, {
    TOOL_CALL: input,
    CLAUDE_PROJECT_DIR: projectFolder,
  });
}
