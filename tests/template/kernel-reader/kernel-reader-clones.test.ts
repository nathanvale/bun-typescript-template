import { describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readKernel } from "../../../src/kernel-reader.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  git,
  gitEnv,
  gitResult,
  inherited,
} from "../../support/git-fixture.ts";
import { listedFiles } from "../../support/git-object-fixture.ts";
import {
  timed,
  whileGitHangs,
  withToolsFirst,
} from "../../support/hung-git.ts";
import { refusalOf, refused, repairs } from "../../support/kernel-refusal.ts";
import {
  declarationPathIn,
  firstLayout,
  kernelRepository,
} from "../../support/kernel-repository-fixture.ts";
import { processWatchdog } from "../../support/process.ts";

const folder = ownedFolders();
const path = declarationPathIn(firstLayout);

function partialClone(filter: string) {
  const origin = folder("kernel-reader-clones-");
  const commit = kernelRepository(origin);
  git(origin, "config", "uploadpack.allowFilter", "true");
  const repository = join(folder("kernel-reader-clones-"), "partial");
  git(
    origin,
    "clone",
    "--quiet",
    "--bare",
    "--no-local",
    `--filter=${filter}`,
    origin,
    repository,
  );
  return { origin, repository, commit };
}

describe("the kernel reader, given a partial clone", () => {
  test("refuses one that lacks the commit's files, and does not fetch them as plain git then does", () => {
    const { origin, repository, commit } = partialClone("blob:none");
    const declaration =
      listedFiles(origin, commit).find((file) => file.path === path)?.blob ??
      "";
    expect(refusalOf(() => readKernel({ repository, commit }, path))).toEqual(
      refused(
        "kernel_commit_missing",
        `Commit ${commit} is in the git repository at ${repository}, and its file object ${declaration} is not.`,
        repairs.commit,
      ),
    );
    expect(readKernel({ repository: origin, commit }, path).commit).toBe(
      commit,
    );
    expect(gitResult(repository, "cat-file", "-e", declaration).exitCode).toBe(
      0,
    );
  });

  test("refuses one that lacks the commit's list of files", () => {
    const { repository, commit } = partialClone("tree:0");
    const refusal = refusalOf(() => readKernel({ repository, commit }, path));
    expect(refusal.message).toStartWith(
      `Commit ${commit} is in the git repository at ${repository}, and its list of files is not: git says "`,
    );
    expect(refusal.message).toEndWith(` Repair: ${repairs.commit}`);
    expect({ code: refusal.code, repair: refusal.repair }).toEqual({
      code: "kernel_commit_missing",
      repair: repairs.commit,
    });
  });
});

describe("the kernel reader keeps git to the repository it was given", () => {
  test("when the caller's environment names another repository, as a git hook's does", () => {
    const repository = folder("kernel-reader-clones-");
    const commit = kernelRepository(repository);
    const other = folder("kernel-reader-clones-");
    const otherCommit = kernelRepository(other, [
      { path: "README.md", bytes: "Another repository.\n" },
    ]);
    const held = process.env.GIT_DIR;
    process.env.GIT_DIR = join(other, ".git");
    try {
      const plainGit = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
        cwd: repository,
        env: { ...inherited(), ...gitEnv, GIT_DIR: process.env.GIT_DIR },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 4_000,
        killSignal: "SIGKILL",
      });
      expect(plainGit.stdout.toString().trim()).toBe(otherCommit);
      expect(readKernel({ repository, commit }, path).commit).toBe(commit);
    } finally {
      if (held === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = held;
    }
  });

  test(
    "and stops a git that never answers at its bound, naming the command, the repository and the repair",
    async () => {
      const repository = folder("kernel-reader-clones-");
      const commit = kernelRepository(repository);
      const { value, milliseconds } = await whileGitHangs(
        folder("kernel-reader-clones-"),
        () =>
          timed(() => {
            try {
              readKernel({ repository, commit }, path);
            } catch (error) {
              return error instanceof Error ? error.message : String(error);
            }
            return "The read finished.";
          }),
      );
      expect(milliseconds).toBeGreaterThanOrEqual(4_000 - 100);
      expect(milliseconds).toBeLessThan(4_000 + 1_500);
      expect(value).toBe(
        `git rev-parse did not finish within 4000 ms in ${repository}. Repair: run it by hand there to see where it waits, then run this again.`,
      );
    },
    processWatchdog(1),
  );
});

describe("the kernel reader starts no remote helper", () => {
  test("a partial clone whose promisor is a none:: remote does not run git-remote-none, which git runs when the allowlist names none", async () => {
    const { repository, commit } = partialClone("blob:none");
    git(repository, "config", "remote.origin.url", "none::kernel");
    const bin = folder("kernel-reader-clones-");
    const ran = join(bin, "helper-ran");
    writeFileSync(
      join(bin, "git-remote-none"),
      `#!/bin/sh\ntouch '${ran}'\nexit 1\n`,
      { mode: 0o755 },
    );
    await withToolsFirst(bin, () => {
      expect(
        refusalOf(() => readKernel({ repository, commit }, path)).code,
      ).toBe("kernel_commit_missing");
      expect(existsSync(ran)).toBe(false);
      const control = Bun.spawnSync(
        ["git", "cat-file", "-p", `${commit}:${path}`],
        {
          cwd: repository,
          env: { ...inherited(), ...gitEnv, GIT_ALLOW_PROTOCOL: "none" },
          stdout: "pipe",
          stderr: "pipe",
          timeout: 4_000,
          killSignal: "SIGKILL",
        },
      );
      expect(control.exitCode).not.toBe(0);
      expect(existsSync(ran)).toBe(true);
    });
  });
});
