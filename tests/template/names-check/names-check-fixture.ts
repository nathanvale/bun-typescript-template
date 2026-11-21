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
} from "../../../scripts/glossary.ts";
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

  return { emptyRepository, folder, namesRepository, outsideRepository };
}
