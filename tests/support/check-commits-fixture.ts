import { copyFileSync, mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { doctorSources, ownedFolders } from "./fixture-files.ts";
import {
  commitIn,
  git,
  gitEnv,
  inherited,
  initRepository,
} from "./git-fixture.ts";
import { type SignalAt, spawnBounded } from "./process.ts";

export const repository = join(import.meta.dir, "../..");
const sources = [
  "scripts/check-commits.ts",
  "scripts/process-runner.ts",
  "src/cli.ts",
  "src/causes.ts",
  ...doctorSources,
  "scripts/repository.ts",
  "repository.json",
];
const { scripts: production } = (await Bun.file(
  join(repository, "package.json"),
).json()) as { scripts: Record<string, string> };
export const markers = {
  typecheck: "test ! -e type-error",
  lint: "test ! -e lint-error",
};

export function manifest(pin: string, scripts: Record<string, string>): string {
  return JSON.stringify({
    packageManager: `bun@${pin}`,
    scripts: {
      "check:commits": production["check:commits"],
      doctor: production.doctor,
      ...scripts,
    },
  });
}

export function linkedCheckout(root: string): string {
  const caller = join(dirname(root), "caller");
  git(root, "worktree", "add", "--quiet", "--detach", caller);
  for (const path of sources) {
    mkdirSync(dirname(join(caller, path)), { recursive: true });
    copyFileSync(join(root, path), join(caller, path));
  }
  symlinkSync(join(repository, "node_modules"), join(caller, "node_modules"));
  return caller;
}

export function verdicts(lines: readonly string[]): string[] {
  return lines.filter((line) => /^(GREEN|RED) /.test(line));
}

export function checkCommitsFixture() {
  const folder = ownedFolders();

  function repositoryAt({ pin = Bun.version, scripts = markers } = {}) {
    const root = join(folder("check-commits-repo-"), "repo");
    for (const path of sources) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      copyFileSync(join(repository, path), join(root, path));
    }
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    initRepository(root);
    const commit = (subject: string, changes: Record<string, string | null>) =>
      commitIn(root, subject, changes);
    const base = commit("base", {
      ".gitignore": "node_modules\n",
      "package.json": manifest(pin, scripts),
    });
    return { root, base, commit };
  }

  async function checkCommits(
    root: string,
    args: string[],
    env: Record<string, string> = {},
    {
      signalAt,
      ownGroup = false,
    }: { signalAt?: SignalAt; ownGroup?: boolean } = {},
  ) {
    const temporary = folder("check-commits-tmp-");
    const entry = [process.execPath, "run", "check:commits", ...args];
    const run = await spawnBounded(
      ownGroup
        ? ["perl", "-e", "setpgrp(0, 0); exec @ARGV or die", ...entry]
        : entry,
      {
        cwd: root,
        env: { ...inherited(), ...gitEnv, TMPDIR: temporary, ...env },
        signalAt,
      },
    );
    return { ...run, temporary, lines: run.stdout.split("\n") };
  }

  return { folder, repositoryAt, checkCommits };
}
