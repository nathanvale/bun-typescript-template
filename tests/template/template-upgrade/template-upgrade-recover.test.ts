import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { formatCommandPath } from "../../../src/template-upgrade-git.ts";
import { templateUpgradeRecover } from "../../../src/template-upgrade-recover.ts";
import { createTemplateUpgradeRecoverResult } from "../../../src/template-upgrade-report.ts";
import { ROOT } from "../../support/bootstrap-cli-fixture.ts";
import { ownedFolders } from "../../support/fixture-files.ts";
import {
  commitIn,
  git,
  gitOutput,
  worktrees,
} from "../../support/git-fixture.ts";
import { processWatchdog, spawnBounded } from "../../support/process.ts";
import { streamWrites } from "../../support/stream-writes.ts";
import {
  applyNoCheckJsonArgs,
  invokeTemplateUpgradeMain,
} from "../../support/template-upgrade-fixture.ts";
import {
  createFailedApplyWorktree,
  parseRecover,
  parseRefusal,
  recoverDiff,
  writeScriptedGit,
} from "../../support/template-upgrade-recover-fixture.ts";

const folder = ownedFolders();
const captureStream = streamWrites();

function collectFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      found.push(...collectFiles(fullPath));
    } else if (entry.isFile()) {
      found.push(fullPath);
    }
  }
  return found;
}

const FORCE_WORKTREE_REMOVE_PATTERN =
  /\bgit\b(?:[^\n;|&\]]{0,120}?)\bworktree\s+remove\b[^\n;|&\]]{0,160}?(?:--force\b|\s-f\b)|(?:--force\b|\s-f\b)[^\n;|&\]]{0,120}?\bgit\b(?:[^\n;|&\]]{0,120}?)\bworktree\s+remove\b/;

function findForceWorktreeRemoveViolations(text: string): string[] {
  const matches: string[] = [];
  for (const line of text.split("\n")) {
    const hit = FORCE_WORKTREE_REMOVE_PATTERN.exec(line);
    if (hit !== null) {
      matches.push(hit[0].trim());
    }
  }
  return matches;
}

test(
  "recovers a real failed upgrade apply worktree into a scrap branch and matching patch without --force or textconv, refuses repeat recover, and lets apply start clean",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-e2e-app",
    );
    const porcelain = gitOutput(setup.repo, "worktree", "list", "--porcelain");
    expect(porcelain).toContain(`worktree ${setup.targetWorktree}`);
    expect(porcelain).toContain(
      `locked template-upgrade ${setup.targetCommit}`,
    );
    const lockPath = git(
      setup.targetWorktree,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "locked",
    );
    expect(readFileSync(lockPath, "utf8").trim()).toBe(
      `template-upgrade ${setup.targetCommit}`,
    );

    writeFileSync(
      join(setup.targetWorktree, "recovery-extra.txt"),
      "untracked recovery note\n",
    );
    writeFileSync(
      join(setup.targetWorktree, ".gitattributes"),
      "*.txt diff=scramble\n",
    );
    git(setup.repo, "config", "diff.scramble.textconv", "printf SCRAMBLED");
    commitIn(setup.repo, "advance head after failed upgrade", {
      "owner-after-failure.txt": "new commit on main\n",
    });

    const hooksDir = folder("recover-hooks-");
    writeFileSync(join(hooksDir, "pre-commit"), "#!/bin/sh\nexit 1\n", {
      mode: 0o755,
    });
    git(setup.repo, "config", "core.hooksPath", hooksDir);

    const blocked = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      setup.runtime,
    );
    expect(blocked.exitCode).toBe(4);
    const blockedErr = parseRefusal(blocked.stderr).error;
    expect(blockedErr.code).toBe("worktree_exists_other_head");
    expect(blockedErr.repair).toContain(
      `bun run upgrade recover --repository ${setup.repo} --to ${setup.target7}`,
    );
    expect(blockedErr.repair).not.toContain("--force");

    const loggingGit = writeScriptedGit(
      folder,
      "git-no-force-check-",
      'printf "%s" "$*" | grep -q "worktree remove.*--force"',
      "forbidden --force on worktree remove",
    );
    const recovered = await setup.runRecover(loggingGit.env);
    expect(recovered.exitCode).toBe(0);
    expect(recovered.stderr).toBe("");
    const payload = parseRecover(recovered.stdout);
    expect(payload).toEqual({
      schemaVersion: 1,
      action: "recover",
      status: "recovered",
      targetCommit: setup.targetCommit,
      worktree: setup.targetWorktree,
      branch: setup.branch1,
      commit: git(setup.repo, "rev-parse", setup.branch1),
      patchPath: setup.patch1,
      rerunCommand: `bun run upgrade apply --repository ${setup.repo} --to ${setup.target7}`,
    });
    expect(existsSync(setup.targetWorktree)).toBe(false);
    expect(existsSync(lockPath)).toBe(false);
    expect(worktrees(setup.repo)).toHaveLength(1);
    expect(git(setup.repo, "show", `${setup.branch1}:recovery-extra.txt`)).toBe(
      "untracked recovery note",
    );
    const patchText = readFileSync(setup.patch1, "utf8");
    expect(patchText).toBe(
      recoverDiff(setup.repo, `${setup.branch1}^`, setup.branch1),
    );
    expect(patchText).toContain("untracked recovery note");
    expect(patchText).not.toContain("SCRAMBLED");
    const gitCalls = readFileSync(loggingGit.ledger, "utf8");
    expect(gitCalls).toContain("--no-textconv");
    expect(gitCalls).toContain(`worktree remove ${setup.targetWorktree}`);
    expect(gitCalls).not.toContain("--force");
    expect(gitOutput(setup.repo, "status", "--porcelain=v1")).toBe("");

    const repeat = await setup.runRecover();
    expect(repeat.exitCode).toBe(4);
    expect(repeat.stdout).toBe("");
    expect(parseRefusal(repeat.stderr)).toMatchObject({
      status: "refused",
      error: { code: "worktree_missing", retrySafe: true },
    });

    git(setup.repo, "config", "--unset", "core.hooksPath");
    const followUp = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      setup.runtime,
    );
    expect(followUp.exitCode).toBe(0);
    expect(JSON.parse(followUp.stdout)).toMatchObject({
      action: "apply",
      status: "applied",
    });
    expect(git(setup.repo, "branch", "--list", setup.branch1)).toBe(
      setup.branch1,
    );
    expect(existsSync(setup.patch1)).toBe(true);
  },
  processWatchdog(6),
);

test(
  "picks lowest unused n across scrap branches and patch files, prints text output, and supports in-process calls",
  async () => {
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-index-app",
    );
    git(setup.repo, "branch", setup.branch1);
    const patch2 = join(
      setup.repo,
      ".worktrees",
      `template-upgrade-${setup.target7}-failed-2.patch`,
    );
    writeFileSync(patch2, "existing patch 2\n");
    git(setup.repo, "branch", `template-upgrade/${setup.target7}-failed-4`);

    const textRun = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      ["recover", "--repository", setup.repo, "--to", setup.targetCommit],
      setup.runtime,
    );
    expect(textRun.exitCode).toBe(0);
    expect(textRun.stderr).toBe("");
    const branch3 = `template-upgrade/${setup.target7}-failed-3`;
    const patch3 = join(
      setup.repo,
      ".worktrees",
      `template-upgrade-${setup.target7}-failed-3.patch`,
    );
    expect(textRun.stdout).toContain(branch3);
    expect(textRun.stdout).toContain(patch3);
    expect(textRun.stdout).toContain(
      `bun run upgrade apply --repository ${setup.repo} --to ${setup.target7}`,
    );
    expect(existsSync(patch3)).toBe(true);
    expect(readFileSync(patch2, "utf8")).toBe("existing patch 2\n");

    git(
      setup.repo,
      "worktree",
      "add",
      "--quiet",
      "--detach",
      setup.targetWorktree,
      "HEAD",
    );
    git(
      setup.repo,
      "worktree",
      "lock",
      "--reason",
      `template-upgrade ${setup.targetCommit}`,
      setup.targetWorktree,
    );
    writeFileSync(
      join(setup.targetWorktree, "in-process.txt"),
      "in-process edit\n",
    );
    const direct = await templateUpgradeRecover({
      templateRoot: setup.templateClone,
      repository: setup.repo,
      targetRef: setup.targetCommit,
      env: setup.runtime.env,
    });
    expect(direct.branch).toBe(`template-upgrade/${setup.target7}-failed-5`);
    expect(direct.patchPath).toBe(
      join(
        setup.repo,
        ".worktrees",
        `template-upgrade-${setup.target7}-failed-5.patch`,
      ),
    );
    expect(createTemplateUpgradeRecoverResult(direct)).toEqual(direct);
  },
  processWatchdog(6),
);

test(
  "quotes repository and worktree paths with spaces and quotes in printed recovery, repair, and rerun commands",
  async () => {
    const quotedRepo = join(
      folder("recover-quoted-"),
      "my repo with 'quote' and space",
    );
    const setup = await createFailedApplyWorktree(
      folder,
      captureStream,
      "recover-quoted-app",
      { customRepoPath: quotedRepo },
    );
    const qRepo = formatCommandPath(setup.repo);
    const qWorktree = formatCommandPath(setup.targetWorktree);
    expect(qRepo).toBe(`'${setup.repo.replaceAll("'", "'\\''")}'`);

    const textFailure = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      ["apply", "--repository", setup.repo, "--to", setup.targetCommit],
      { templateRoot: setup.templateClone, env: setup.failCheckBun.env },
    );
    expect(textFailure.exitCode).toBe(1);
    expect(textFailure.stdout).toContain(
      `bun run upgrade recover --repository ${qRepo} --to ${setup.target7}`,
    );

    commitIn(setup.repo, "advance quoted repo head", {
      "quoted-note.txt": "advanced\n",
    });
    const otherHead = await invokeTemplateUpgradeMain(
      setup.stdout,
      setup.stderr,
      applyNoCheckJsonArgs(setup.repo, setup.targetCommit),
      setup.runtime,
    );
    expect(otherHead.exitCode).toBe(4);
    const otherErr = parseRefusal(otherHead.stderr).error;
    expect(otherErr.code).toBe("worktree_exists_other_head");
    expect(otherErr.repair).toContain(
      `bun run upgrade recover --repository ${qRepo} --to ${setup.target7}`,
    );
    expect(otherErr.repair).toContain(qWorktree);

    const recovered = await setup.runRecover();
    expect(recovered.exitCode).toBe(0);
    expect(parseRecover(recovered.stdout).rerunCommand).toBe(
      `bun run upgrade apply --repository ${qRepo} --to ${setup.target7}`,
    );

    const shellCheck = await spawnBounded(
      ["/bin/sh", "-c", `printf '%s' ${qRepo}`],
      { processGroup: true },
    );
    expect(shellCheck.exit).toBe(0);
    expect(shellCheck.stdout).toBe(setup.repo);

    const missing = await setup.runRecover();
    expect(missing.exitCode).toBe(4);
    const missingErr = parseRefusal(missing.stderr).error;
    expect(missingErr.code).toBe("worktree_missing");
    expect(missingErr.repair).toContain(`git -C ${qRepo} worktree list`);
    expect(missingErr.repair).toContain(
      `bun run upgrade apply --repository ${qRepo} --to ${setup.target7}`,
    );
  },
  processWatchdog(6),
);

test("no repair line or document under src/ or docs/ tells the caller to pass --force to git worktree remove", () => {
  for (const sample of [
    "run git worktree remove --force /tmp/repo/.worktrees/wt",
    "run git -C PATH worktree remove --force PATH",
    "inspect git -C '/tmp/my repo' worktree list, then run git -C '/tmp/my repo' worktree remove -f '/tmp/wt'",
    "pass `--force` to `git -C PATH worktree remove`",
  ]) {
    expect(findForceWorktreeRemoveViolations(sample)).not.toEqual([]);
  }
  for (const sample of [
    "run git -C PATH worktree remove PATH",
    "run git worktree remove /tmp/wt-force-name",
    "inspect git -C '/tmp/my repo' worktree unlock '/tmp/wt' && git -C '/tmp/my repo' worktree remove '/tmp/wt'",
    '["worktree", "remove", "--force", "--force", worktreePath]',
  ]) {
    expect(findForceWorktreeRemoveViolations(sample)).toEqual([]);
  }

  const violations: string[] = [];
  for (const filePath of [
    ...collectFiles(join(ROOT, "src")),
    ...collectFiles(join(ROOT, "docs")),
  ]) {
    for (const hit of findForceWorktreeRemoveViolations(
      readFileSync(filePath, "utf8"),
    )) {
      violations.push(`${filePath}: ${hit}`);
    }
  }
  expect(violations).toEqual([]);
  for (const path of [
    "docs/template-upgrade.md",
    "src/template-upgrade-recover.ts",
    "src/template-upgrade-recover-record.ts",
  ]) {
    expect(readFileSync(join(ROOT, path), "utf8")).not.toContain("--force");
  }
});
