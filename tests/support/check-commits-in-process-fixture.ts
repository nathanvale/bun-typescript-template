import { spyOn } from "bun:test";
import {
  copyFileSync,
  existsSync,
  readFileSync,
  realpathSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import type { Active, Run } from "../../scripts/check-commits.ts";
import { kernelPinFile } from "../../src/kernel-pin.ts";
import { ownedFolders } from "./fixture-files.ts";
import { commitIn, git, initRepository } from "./git-fixture.ts";

const repository = join(import.meta.dir, "../..");

const markers = {
  typecheck: "test ! -e type-error",
  lint: "test ! -e lint-error",
};

export const absentFixedPoint = "f".repeat(40);

export async function captured<T>(run: () => T | Promise<T>) {
  const out: string[] = [];
  const err: string[] = [];
  const stdout = spyOn(process.stdout, "write").mockImplementation((chunk) => {
    out.push(String(chunk));
    return true;
  });
  const stderr = spyOn(process.stderr, "write").mockImplementation((chunk) => {
    err.push(String(chunk));
    return true;
  });
  try {
    const value = await run();
    return { value, lines: out.join("").split("\n"), stderr: err.join("") };
  } finally {
    stdout.mockRestore();
    stderr.mockRestore();
  }
}

export async function refusal(
  run: Promise<unknown>,
): Promise<string | undefined> {
  try {
    await run;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return undefined;
}

export function ledgerScript(
  ledger: string,
  step: string,
  test: string,
): string {
  return `echo ${step} >> '${ledger}'; ${test}`;
}

export function ledgered(ledger: string): string[] {
  return existsSync(ledger)
    ? readFileSync(ledger, "utf8").split("\n").filter(Boolean)
    : [];
}

export function createCommitCheckFixture() {
  const folder = ownedFolders();

  function repositoryAt({
    pin = Bun.version,
    scripts = markers,
  }: {
    pin?: string;
    scripts?: Record<string, string>;
  } = {}) {
    const root = join(folder("check-commits-process-repo-"), "repo");
    initRepository(root);
    copyFileSync(join(repository, kernelPinFile), join(root, kernelPinFile));
    symlinkSync(join(repository, "node_modules"), join(root, "node_modules"));
    const commit = (
      subject: string,
      changes: Record<string, string | null>,
    ) => ({
      ...commitIn(root, subject, changes),
      subject,
    });
    const base = commit("base", {
      ".gitignore": "node_modules\n",
      "package.json": JSON.stringify({ packageManager: `bun@${pin}`, scripts }),
    });
    const active: Active = {};
    const run: Run = { root, fixedPoint: absentFixedPoint, active };
    return { root, run, active, base, commit };
  }

  async function inTemporaryFolder<T>(run: (temporary: string) => Promise<T>) {
    const temporary = folder("check-commits-process-tmp-");
    const before = process.env.TMPDIR;
    process.env.TMPDIR = temporary;
    try {
      return await run(temporary);
    } finally {
      if (before === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = before;
    }
  }

  function worktreeAt(root: string, name: string) {
    const dir = join(folder("check-commits-process-tree-"), name);
    git(root, "worktree", "add", "--detach", "--quiet", dir, "HEAD");
    const admin = git(dir, "rev-parse", "--path-format=absolute", "--git-dir");
    return { dir: realpathSync(dir), admin };
  }

  return { folder, repositoryAt, inTemporaryFolder, worktreeAt };
}
