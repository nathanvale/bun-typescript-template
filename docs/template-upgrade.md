# Template upgrade

A Template upgrade carries changes made in this template between the commit a generated repository was created from and a newer template commit into that repository while keeping the repository's own edits.

It works by reading `.template.json` (or `.cli-design-template.json` when `.template.json` is absent) from the repository's committed `HEAD`, regenerating the old and new trees with each template commit's own `src/bootstrap.ts`, and merging old-to-new into the repository file by file. When a repository still carries `.cli-design-template.json`, the upgrade removes it and writes `.template.json` with the current fields (`name`, `templateRevision`, `templateDirty`, and `sourcePacket`).

## Commands

Preview an upgrade without writing anything to the repository:

```bash
bun run upgrade plan --repository PATH [--to REF] [--json]
```

Apply an upgrade into an isolated worktree and publish the result on a branch:

```bash
bun run upgrade apply --repository PATH [--to REF] [--no-check] [--json]
```

Recover a failed upgrade worktree into a branch and patch file, then remove it:

```bash
bun run upgrade recover --repository PATH [--to REF] [--json]
```

### Options

- `--repository PATH`: Path to the generated repository root.
- `--to REF`: Target template commit, branch, or tag (default: `HEAD` of this template checkout). The target must descend from the repository's recorded `templateRevision`; downgrades are refused. Both `plan` and `apply` print `Target commit: <sha>`. When targeting `HEAD` while it is behind `origin/main` (checked locally via `git rev-list --count HEAD..origin/main`, without fetching), both print one warning line (`templateHeadNotice` in `--json`) naming the count and repair (`git pull` in the template, or `--to origin/main`).
- `--no-check`: Available with `apply`. Skips `bun install` and `bun run check` in the upgrade worktree before committing.
- `--json`: Prints a single JSON result envelope (`stdout` on completion or conflict/check status, `stderr` on refusal).

### Inputs and refusals

`plan` and `apply` read only committed state (`HEAD:.template.json` — or `HEAD:.cli-design-template.json` when `.template.json` is absent — and `HEAD:package.json`). They never move the repository's kernel Pin: they read `dependencies.agent-cli-kernel` (`#<40-hex>`) from `HEAD:package.json` and regenerate both trees against that Pin. Refusals name an error code and repair step when:

- `--repository` is not a git repository root or has no `HEAD`.
- `HEAD` has neither `.template.json` nor `.cli-design-template.json`.
- `HEAD` has both `.template.json` and `.cli-design-template.json` (`stamp_duplicate`); delete `.cli-design-template.json` and commit the removal.
- The committed stamp has `templateDirty: true`.
- `templateRevision` is not in this template checkout's history or does not descend from the oldest supported base commit (`46e0f66`).
- `--to REF` cannot be resolved or does not descend from `templateRevision`.
- `HEAD:package.json` is missing or its `dependencies.agent-cli-kernel` is not a full 40-character pinned commit (`#<40-hex>`).
- Regenerating either tree with the repository's Pin fails (quoting the bootstrap error and naming moving the Pin as a possible cause).
- No kernel repository is at `KERNEL_REPOSITORY` or beside the template, and the kernel cache cannot fetch the repository's Pin (`kernel_repository_missing`). Clone the kernel repository beside the template, set `KERNEL_REPOSITORY`, or rerun with network access to fill the kernel cache at the path the repair line names.
- The target branch `template-upgrade/<base7>-<target7>` already exists from a different `HEAD`.
- Any ancestor folder of an upgraded path (in the old tree, new tree, or worktree), or `.worktrees` itself, is a symbolic link (`symlink_ancestor`).
- The active upgrade worktree `.worktrees/template-upgrade-<target7>` exists at a different `HEAD` (`worktree_exists_other_head`); run `bun run upgrade recover --repository PATH --to <target7>` and rerun.
- Either `.worktrees/template-upgrade-tmp` or `.worktrees/template-upgrade-<target7>` holds anything not locked by this command with a reason starting `template-upgrade ` (`worktree_not_owned`), such as an unlocked worktree, a worktree locked for another reason, or a plain folder or file; move or remove it after saving any work, then rerun.

If `templateRevision` equals the resolved target commit, `plan` and `apply` exit `0` with status `up-to-date` and write nothing. When the template's Pin at the target (`kernel-pin.json`) differs from the repository's Pin, both print one notice (`pinMoveNotice` in `--json`) naming both Pins and reminding you that a Template upgrade does not move a Pin.

### Where the kernel repository comes from

Bootstrap and a Template upgrade read the kernel from the first of these places that exists:

1. The path in `KERNEL_REPOSITORY`, when it is set.
2. A clone of the kernel repository beside the template checkout. From a worktree, the clone beside the checkout that the worktree shares its objects with also counts.
3. The kernel cache: a bare clone of the remote in `kernel-pin.json`, at `$XDG_CACHE_HOME/my-agent-dojo/bun-typescript-template/agent-cli-kernel.git`. When `XDG_CACHE_HOME` is unset, the kernel cache is at `~/.cache/my-agent-dojo/bun-typescript-template/agent-cli-kernel.git`.

The first run that reaches the kernel cache clones the remote into it. A later run uses the kernel cache without the network while the kernel cache holds the pinned commit. When the pinned commit is missing, the run fetches the remote's branches into the kernel cache and looks again. A Template upgrade looks for the repository's Pin, because it regenerates both trees at that Pin.

Each user has one kernel cache. Every checkout of the template that you run shares your kernel cache, because its path depends only on your `XDG_CACHE_HOME` or your home folder. The kernel repository is public, so the clone and the fetch need no login. The kernel reader checks the kernel cache's content by commit identity, as it checks a clone you name.

### Oldest supported base

The oldest supported base commit is `46e0f66` (`46e0f6659f879b45b68ef64d1d3a72f229b7b3bd`, 21 November 2026). Older template commits required `--profile` in `src/bootstrap.ts` and refuse when regenerated without it, so bases that do not descend from `46e0f66` are refused before regeneration.

Running an older template commit's `src/bootstrap.ts` under a future Bun release or a future kernel layout is untested.

## File owners and merge outcomes

Every file or symbolic link present in the regenerated old or new tree receives an owner label and an outcome. Files that Bootstrap never writes do not appear and are never touched.

### Owner labels

| Label        | Paths                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `generated`  | `.template.json`, `.cli-design-template.json`, `bun.lock`, `.claude/skills/*`                                      |
| `repository` | Owner starting copies listed in `src/recipe.ts`: `README.md`, `src/cli.ts`, `src/commands.ts`, `tests/cli.test.ts` |
| `shared`     | Root `*.json` and `*.toml` settings (including `bunfig.toml`), `.changeset/config.json`, `.gitignore`, `.github/**`, `AGENTS.md` |
| `template`   | All other files Bootstrap writes (`config/*`, `.agents/skills/*`, `.changeset/README.md`, `scripts/*`, `tests/*`, `eslint.config.mjs`) |

### Merge outcomes

| Outcome                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `untouched`             | Old and new trees are identical; nothing changed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `already-applied`       | The repository already matches the new tree.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `take`                  | The repository matched old (or the file is `.template.json`); the new file or symbolic link was copied in.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `delete`                | The repository matched old and the new tree removed the file (or the file is an old `.cli-design-template.json` stamp replaced by `.template.json`); it was removed.                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `regenerate`            | `package.json` changed; the repository's `bun.lock` is kept (never replaced with the template's kernel lockfile) and rebuilt by `bun install` during `apply`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `merge`                 | Both sides changed and merged cleanly (key-level merge for `*.json` preserving repository key order; `git merge-file` for text).                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `template-copy-changed` | A `repository`-owned starting copy changed between the old and new template commits, or a delete-versus-change conflict hit a file that cannot hold text conflict markers (for example, one containing a NUL byte or non-UTF-8 bytes); the repository's file (or deletion) is kept untouched, not counted as a conflict, and the row includes the reason when markers could not be written. `plan` prints the `git diff` of old vs new.                                                                                                                                                                 |
| `conflict`              | Both sides changed the same region or JSON key, or a text merge repeated a JSON member. A text conflict gets `git merge-file` markers (`<<<<<<< ours`). A JSON key conflict marks the whole file instead, with the repository's version as `<<<<<<< ours` and the template's as `>>>>>>> new`, so it cannot pass as resolved. A `*.json` file that does not parse as JSON (for example, one with comments) merges as text. Its whole file is also marked when the text merge repeats a member of one object, either with every `git merge-file` hunk taken from ours or with every hunk taken from new. |
| `conflict-add`          | Added by the template while a different file already exists in the repository; `git merge-file` ran against an empty base.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `conflict-delete`       | Deleted on one side and modified on the other for a text file; conflict markers are written with an empty side noting who deleted it (`>>>>>>> new (deleted by template)` or `<<<<<<< ours (deleted by owner)`). Files that cannot hold text conflict markers (such as files containing a NUL byte) keep the repository's state as `template-copy-changed` with a reason instead.                                                                                                                                                                                                                       |
| `conflict-link`         | A symbolic link disagreed across old, new, and the repository; the repository's entry was kept.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

`plan` prints the target commit, added changesets under `.changeset/` (`major` first, with summary and `Action:`; `changesets` in `--json`), per-file rows, repository-edited `shared` files (`sharedMerges` in `--json`), `package.json` dependency version changes, and the `git diff` for each `template-copy-changed` path. It removes its temporary worktree and exits `0` even with conflicts.

`apply` prints the target commit, step outcomes (`steps` in `--json`), and the same `major`-first changesets (`changesets` in `--json`), which it also writes into the upgrade commit body. If your upgrade pull request changes `package.json` or `src/`, add a changeset on the upgrade branch (`bun run --bun changeset add --patch <name> -m "Upgraded template <base> to <target>"`) so the `Changesets` hosted check passes.

The key-level JSON merge formats merged files with two-space indentation and one array item per line. Because Biome keeps short arrays on one line, `apply` runs the repository's `node_modules/.bin/biome format --write` on key-merged `*.json` files after `bun install` (no other files). If you replace a key-merged file with a symlink, hard link, or folder while resolving a conflict, rerunning skips formatting that path and records the reason in `steps`. If a file becomes a link or another file during formatting, `apply` stops as `check-failed` naming the path. Text-merged `*.json` files keep `git merge-file` output. The `biome format --write` step appears in `steps` only when key-level merge wrote a file; it stops as `check-failed` on error or timeout, and skips when `bun install` did not run (such as `--no-check`) or `node_modules/.bin/biome` is missing.

## Applying, resolving conflicts, and rerunning

`apply` never touches the repository's working tree, current branch, or stash, and never pushes. It works under `.worktrees/` inside the repository:

- Temporary merge worktree: `.worktrees/template-upgrade-tmp`
- Active upgrade worktree: `.worktrees/template-upgrade-<target7>`
- Published branch: `template-upgrade/<base7>-<target7>`

### Worktree lock and recovery

Right after this command creates a worktree (`git worktree add`), it locks it with `git worktree lock --reason "template-upgrade <target commit>" <path>`. Both `.worktrees/template-upgrade-tmp` and `.worktrees/template-upgrade-<target7>` carry that lock (kept through `git worktree move`).

Before removing anything at `.worktrees/template-upgrade-tmp` or `.worktrees/template-upgrade-<target7>`, the command inspects `git worktree list --porcelain` and acts on a worktree only when it is locked with a reason starting `template-upgrade `. Anything else at either path (an unlocked worktree, a worktree locked for another reason, or a plain folder or file) is refused (`worktree_not_owned`) and left untouched.

To clear a failed upgrade worktree without losing its edits, run:

```bash
bun run upgrade recover --repository PATH [--to REF] [--json]
```

`recover` commits the worktree's edits by path onto `template-upgrade/<target7>-failed-<n>` (the lowest unused positive `n`), writes the same diff to `.worktrees/template-upgrade-<target7>-failed-<n>.patch`, unlocks the worktree, removes it with a plain `git worktree remove`, and deletes no branch. It prints the branch, patch path, and rerun command (with `--json`, `action: "recover"`, `status: "recovered"`, `targetCommit`, `worktree`, `branch`, `commit`, `patchPath`, and `rerunCommand`, exiting `0`). It refuses with `worktree_missing` (exit `4`, retry-safe) when no failed worktree exists (including on a second `recover`), `worktree_not_owned` (exit `4`) when the worktree was not created by this tool, and `worktree_patch_failed`, `worktree_unlock_failed`, or `worktree_remove_failed` (exit `1`) on a step failure with no partial removal. After recovery, `upgrade apply` for the same target starts clean.

### Apply statuses and exit codes

| Status                   | Exit | Meaning                                                                                                                                                                                                                                                                         |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up-to-date`             | `0`  | Base and target commits match; nothing written.                                                                                                                                                                                                                                 |
| `already-done`           | `0`  | `template-upgrade/<base7>-<target7>` already exists with `HEAD` as its parent; a leftover upgrade worktree is removed only when it is locked by this command (`template-upgrade `) and clean at the published commit, otherwise it is left untouched and one line explains why. |
| `applied`                | `0`  | Merged, installed and checked (unless `--no-check`), committed as `Upgrade template <base7> to <target7>`, branch created, worktree removed.                                                                                                                                    |
| `conflicts`              | `2`  | Conflicts remain in `.worktrees/template-upgrade-<target7>`.                                                                                                                                                                                                                    |
| `resolution-in-progress` | `5`  | You started editing `.worktrees/template-upgrade-<target7>` but `<<<<<<< ours` markers remain.                                                                                                                                                                                  |
| `gate-adoption-required` | `6`  | Existing repository code violates a gate added or changed by this upgrade (Fallow, ESLint, TypeScript, or Biome); worktree kept with the listed problems, changed gate files, repair steps, and recover command.                                                                |
| `check-failed`           | `1`  | `bun install`, `biome format --write`, `bun run quality:fallow:record-hits`, `bun run check`, or `fallow audit` failed because the upgrade or tool run broke (not existing code against a newly changed gate); worktree kept with resume and recover commands.                   |

### Resolving conflicts and rerunning

1. Open `.worktrees/template-upgrade-<target7>` and resolve each listed conflict (removing all `<<<<<<< ours`, `=======`, and `>>>>>>> new` markers):
   - When the template deleted a file you edited, the file holds your content wrapped with an empty `>>>>>>> new (deleted by template)` side. Remove the markers to keep your file, or delete the file to accept the template's deletion.
   - When you deleted a file the template changed, the file is written with an empty `<<<<<<< ours (deleted by owner)` side and the template's content on the `new` side. Remove the markers to take the template's file, or delete the file to keep it deleted.
2. Run the exact same `bun run upgrade apply --repository PATH [--to REF]` command again.
3. Because the worktree differs from a fresh merge (including when a resolution deletes a conflicted file) and has no remaining markers, `apply` uses your resolved tree (without re-merging or nesting markers), runs `bun install` and `bun run check` (unless `--no-check`), stages only the changed paths by name (including `bun.lock` if `bun install` updated it), commits, creates `template-upgrade/<base7>-<target7>`, and removes the worktree.
4. Rerunning `apply` after completion reports `already-done` and exits `0`.
5. If a run is interrupted at any step before completion, rerunning the same `apply` command converges to the same branch and tree. If `.worktrees/template-upgrade-<target7>` is left over from an older `HEAD`, `apply` refuses and leaves it untouched so your edits are never lost.

### Recording existing Fallow findings

The first Template upgrade that brings the recorded-hits files (`fallow-dead-code-recorded-hits.json`, `fallow-duplicates-recorded-hits.json`, `fallow-health-recorded-hits.json`) runs `bun run quality:fallow:record-hits` itself, after `bun install` and before `bun run check`, and reports it as a step. The repository's existing findings are recorded, so the check fails only on new ones.

When a repository already has committed recorded-hits files and a later Template upgrade changes Fallow or TypeScript settings (`.fallowrc.json`, `tsconfig*.json`, Fallow or TypeScript dependencies, or the Fallow scripts in `package.json`), `apply` runs `bun run quality:fallow:record-hits` once in the worktree:

- If no new finding entries are added (for example, only `analysis_identity.project_config_hash` changed after a `tsconfig.base.json` update), the refreshed recorded-hits files are kept and `bun run check` proceeds normally.
- If new finding entries would be added (for example, `.fallowrc.json` enabled a new gate such as `boundary-violation`), `apply` updates only `analysis_identity` and preserves the repository's previously recorded hits without silently absorbing the new findings. `bun run check` then surfaces the exact existing problems under `gate-adoption-required` (exit `6`) instead of failing on `project_config_hash`.

The recording step runs before `bun run check` once per upgrade worktree. When it passes, the upgrade marks the worktree's Git folder (`git rev-parse --git-path template-upgrade-recorded-hits-done`). A rerun after `check-failed` or `gate-adoption-required` records again only after the check passes. A finding added during the repair still fails the check, and a recorded function that the repair moved is keyed to its new path. Removing the worktree removes the mark.

When the check passes, `apply` runs a push's Fallow audit (`fallow audit --base <HEAD> --quiet`) and stops as `check-failed` with its output when the audit fails.

With `--no-check`, the upgrade records no findings and commits the upgrade branch with empty or unrefreshed recorded-hits files. Before merging, run `bun install` and `bun run quality:fallow:record-hits` in the upgrade worktree or on the upgrade branch and commit the updated recorded-hits files.

### Adopting a gate added or changed by an upgrade

When `bun run check` fails cleanly (without timing out, crashing, or failing tests) only on existing repository code (never on a template-owned or generated file, whether changed or unchanged, and never on a broken template dependency) for a gate whose configuration or script this upgrade changed (`.fallowrc.json`, `eslint.config.mjs`, `config/*.mjs`, `tsconfig*.json`, `biome.json`, or the matching `package.json` script/package), `apply` verifies the findings against the repository's pre-upgrade `HEAD` with only the changed gate files applied. Only when every failing problem is established to predate the changed template files does `apply` stop with status `gate-adoption-required` and exit code `6`, distinct from `check-failed` (exit `1`). Anything it cannot establish stays `check-failed`.

On any failure that keeps a locked worktree (`conflicts`, `resolution-in-progress`, `gate-adoption-required`, `check-failed`), `apply` prints the resume instruction plus `bun run upgrade recover --repository PATH --to <target7>` to save edits and remove the worktree cleanly. For Fallow gate adoption, fixing the listed problems is the default repair; `bun run quality:fallow:record-hits` is noted only for intentionally deferring pre-existing Fallow findings.

Limit: a recorded complex function that gets more complex is not caught. Re-running `bun run quality:fallow:record-hits` after fixing a recorded finding is fine (the file shrinks); recording a new finding is refused by the hosted check on a pull request.
