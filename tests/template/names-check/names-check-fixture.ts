import { afterAll, beforeAll } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  type Environment,
  type NamesCheckResult,
  runNamesCheck,
} from "../../../scripts/check-names.ts";
import {
  type RecordedHit,
  recordedHitsFile,
  recordedUnusedTermsFile,
} from "../../../scripts/glossary.ts";
import { plainWordsFile } from "../../../scripts/plain-words.ts";
import {
  git,
  gitEnv,
  gitResult,
  inherited,
} from "../../support/git-fixture.ts";
import { testFolder } from "../../support/test-folder.ts";
import { publicSurfaceFile } from "../../../scripts/public-surface.ts";

export const glossary = `# Fixture glossary

**Planted fault**:
A deliberate break in a guard.
_Avoid_: mutant, mutation

**Recorded hit**:
A violation listed so that its check passes.
_Avoid_: known hit, allowlist

_Qualify_: host, proof
`;
export const hostRefusal =
  'docs/host.md uses "host" with no qualifier. Repair: add a word that says which host it is.\n';

export const hostHit: RecordedHit = {
  path: "docs/host.md",
  word: "host",
  reason: "fixture",
};

export function put(root: string, path: string, content: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), content);
}

function environmentFor(
  root: string,
  stdin: () => Promise<string> = () => Promise.resolve(""),
  cwd: string = root,
): Environment {
  return { root, cwd, stdin };
}

export function check(
  root: string,
  args: readonly string[],
  stdin?: () => Promise<string>,
  cwd?: string,
): Promise<NamesCheckResult> {
  return runNamesCheck(args, environmentFor(root, stdin, cwd));
}

export function thrownBy(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("expected the call to throw");
}

export const samplePlainWords = JSON.stringify({
  words: [
    { word: "apply", reason: "Approved verb for applying a change." },
    { word: "pattern", reason: "Approved noun for a matching pattern." },
    { word: "src", reason: "Source folder in fixture tests." },
  ],
});

const unknownWordRepairText =
  "Look in the glossary first; if it has a word for this, use it. Otherwise propose the word for the names table in your pull request (the plain-words list or a new glossary entry), for Nathan's decision.";

export function unknownPathLine(path: string, word: string): string {
  return `${path} uses "${word}", which no glossary term uses. Repair: ${unknownWordRepairText} Done when bun run check:names ${path} passes.`;
}

export function avoidPathLine(
  path: string,
  word: string,
  term: string,
): string {
  return `${path} uses "${word}", which GLOSSARY.md lists under Avoid for "${term}". Repair: ${unknownWordRepairText} Done when bun run check:names ${path} passes.`;
}

export function unknownDeclarationLine(
  path: string,
  line: number,
  name: string,
  word: string,
): string {
  return `${path}:${line} public declaration "${name}" uses "${word}", which no glossary term uses. Repair: ${unknownWordRepairText} Done when bun run check:names ${path} passes.`;
}

export function namesCheckFixture() {
  const folders: string[] = [];
  const withheldFromGit = new Map<string, string>();
  const isolatedFromUser = new Map<string, string | undefined>();

  beforeAll(() => {
    const kept = inherited();
    for (const [name, value] of Object.entries(process.env))
      if (!(name in kept) && value !== undefined) {
        withheldFromGit.set(name, value);
        delete process.env[name];
      }
    for (const [name, value] of Object.entries(gitEnv)) {
      isolatedFromUser.set(name, process.env[name]);
      process.env[name] = value;
    }
  });

  afterAll(() => {
    for (const [name, value] of withheldFromGit) process.env[name] = value;
    for (const [name, value] of isolatedFromUser)
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    for (const folder of folders.splice(0))
      rmSync(folder, { recursive: true, force: true });
  });

  function folder(): string {
    const root = testFolder("names-in-process-");
    folders.push(root);
    return root;
  }

  function outsideRepository(): string {
    const root = folder();
    const probe = gitResult(root, "rev-parse", "--show-toplevel");
    if (probe.exitCode === 0)
      throw new Error(
        `${root} sits inside the repository at ${probe.stdout.toString().trim()}, so a case that needs no repository would find it. Repair: point STATE_TEST_DIR at a folder with no repository above it, or unset it. Done when git rev-parse --show-toplevel fails in ${root}.`,
      );
    return root;
  }

  function emptyRepository(): string {
    const root = folder();
    git(root, "init", "--quiet", "--initial-branch=main");
    return root;
  }

  function namesRepository(recorded: readonly RecordedHit[] = []): string {
    const root = emptyRepository();
    put(root, "GLOSSARY.md", glossary);
    put(root, recordedHitsFile, JSON.stringify({ hits: recorded }));
    put(
      root,
      publicSurfaceFile,
      JSON.stringify({ exports: [], consumedExports: [], importers: [] }),
    );
    git(root, "add", "--", "GLOSSARY.md", recordedHitsFile, publicSurfaceFile);
    git(root, "commit", "--quiet", "-m", "rules");
    return root;
  }

  function plainWordsRepository(
    plainJson: string = samplePlainWords,
    extraFiles: Record<string, string> = {},
  ): string {
    const root = namesRepository();
    put(root, plainWordsFile, plainJson);
    put(root, recordedUnusedTermsFile, JSON.stringify({ terms: [] }));
    put(
      root,
      publicSurfaceFile,
      JSON.stringify({
        exports: ["src/*.ts"],
        consumedExports: [],
        importers: [],
      }),
    );
    put(root, "src/planted-fault.ts", "export const plantedFault = 1;\n");
    for (const [path, content] of Object.entries(extraFiles))
      put(root, path, content);
    git(
      root,
      "add",
      "--",
      plainWordsFile,
      recordedUnusedTermsFile,
      publicSurfaceFile,
      "src/planted-fault.ts",
      ...Object.keys(extraFiles),
    );
    git(root, "commit", "--quiet", "-m", "plain words");
    return root;
  }

  return {
    emptyRepository,
    folder,
    namesRepository,
    outsideRepository,
    plainWordsRepository,
  };
}
