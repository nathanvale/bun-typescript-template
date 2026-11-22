# Template upgrade

A Template upgrade carries changes made in this template between the commit a generated repository was created from and a newer template commit into that repository while keeping the repository's own edits.

It works by reading `.cli-design-template.json` from the repository's committed `HEAD`, regenerating the old and new trees with each template commit's own `src/bootstrap.ts`, and merging old-to-new into the repository file by file.

## Commands

Preview an upgrade without writing anything to the repository:

```bash
bun run upgrade plan --repository PATH [--to REF] [--json]
```

Apply an upgrade into an isolated worktree and publish the result on a branch:

```bash
bun run upgrade apply --repository PATH [--to REF] [--no-check] [--json]
```

### Options

- `--repository PATH`: Path to the generated repository root.
- `--to REF`: Target template commit, branch, or tag (default: `HEAD` of this template checkout). The target must descend from the repository's recorded `templateRevision`; downgrades are refused.
- `--no-check`: Available with `apply`. Skips `bun install` and `bun run check` in the upgrade worktree before committing.
- `--json`: Prints a single JSON result envelope (`stdout` on completion or conflict/check status, `stderr` on refusal).

### Inputs and refusals

The command reads only committed state (`HEAD:.cli-design-template.json` and `HEAD:package.json`). It never moves the repository's kernel Pin: it reads the repository's pinned commit from `dependencies.agent-cli-kernel` (`#<40-hex>`) in `HEAD:package.json` and regenerates both the base and target template trees against that Pin. It refuses with an error code and a repair step when:

- `--repository` is not a git repository root or has no `HEAD`.
- `HEAD` has no `.cli-design-template.json`.
- `.cli-design-template.json` has `templateDirty: true`.
- The recorded `templateRevision` is not in this template checkout's history.
- The recorded `templateRevision` is not a descendant of the oldest supported base commit (`46e0f66`).
- `--to REF` cannot be resolved or is not a descendant of `templateRevision`.
- `HEAD:package.json` is missing or its `dependencies.agent-cli-kernel` entry does not carry a full 40-character pinned commit (`#<40-hex>`).
- Regenerating either tree with the repository's Pin fails (quoting the bootstrap error and naming moving the Pin as a possible cause).
- The target branch `template-upgrade/<base7>-<target7>` already exists from a different `HEAD`.
- Any ancestor folder of an upgraded path (in the old tree, new tree, or worktree), or `.worktrees` itself, is a symbolic link (`symlink_ancestor`).
- The active upgrade worktree `.worktrees/template-upgrade-<target7>` already exists at a different `HEAD` (`worktree_exists_other_head`); copy what you need out of it, unlock it with `git worktree unlock`, remove it with `git worktree remove --force`, and rerun.
- Either `.worktrees/template-upgrade-tmp` or `.worktrees/template-upgrade-<target7>` holds anything not locked by this command with a reason starting `template-upgrade ` (`worktree_not_owned`), such as an unlocked worktree, a worktree locked for another reason, or a plain folder or file; move or remove it after saving any work you need, then rerun.

If `templateRevision` equals the resolved target commit, both `plan` and `apply` exit `0` with status `up-to-date` and write nothing. When the template's own Pin at the target (`kernel-pin.json`) differs from the repository's Pin, both `plan` and `apply` print one notice (and include `pinMoveNotice` in `--json` output) reminding you that a Template upgrade does not move the Pin and to move yours separately.

### Oldest supported base

The oldest supported base commit is `46e0f66` (`46e0f6659f879b45b68ef64d1d3a72f229b7b3bd`, 21 November 2026). Older template commits required `--profile` in `src/bootstrap.ts` and refuse when regenerated without it, so bases that do not descend from `46e0f66` are refused before regeneration.

Running an older template commit's `src/bootstrap.ts` under a future Bun release or a future kernel layout is untested.

## File owners and merge outcomes

Every file or symbolic link present in the regenerated old or new tree receives an owner label and an outcome. Files that Bootstrap never writes do not appear and are never touched.

### Owner labels

| Label        | Paths                                                                                                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------ |
| `generated`  | `.cli-design-template.json`, `bun.lock`, `.claude/skills/*`                                                        |
| `repository` | Owner starting copies listed in `src/recipe.ts`: `README.md`, `src/cli.ts`, `src/commands.ts`, `tests/cli.test.ts` |
| `shared`     | Root `*.json` and `*.toml` settings (including `bunfig.toml`), `.gitignore`, `.github/**`, `AGENTS.md`             |
| `template`   | All other files Bootstrap writes (`config/*`, `.agents/skills/*`, `tests/*`, `eslint.config.mjs`)                  |

### Merge outcomes

| Outcome                 | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `untouched`             | Old and new trees are identical; nothing changed.                                                                                                                                                                                                                                                                                                                                                                                       |
| `already`               | The repository already matches the new tree.                                                                                                                                                                                                                                                                                                                                                                                            |
| `take`                  | The repository matched old (or the file is `.cli-design-template.json`); the new file or symbolic link was copied in.                                                                                                                                                                                                                                                                                                                   |
| `delete`                | The repository matched old and the new tree removed the file; it was removed.                                                                                                                                                                                                                                                                                                                                                           |
| `regenerate`            | `package.json` changed; the repository's `bun.lock` is kept (never replaced with the template's kernel lockfile) and rebuilt by `bun install` during `apply`.                                                                                                                                                                                                                                                                           |
| `merge`                 | Both sides changed and merged cleanly (key-level merge for `*.json` preserving repository key order; `git merge-file` for text).                                                                                                                                                                                                                                                                                                        |
| `template-copy-changed` | A `repository`-owned starting copy changed between the old and new template commits, or a delete-versus-change conflict hit a file that cannot hold text conflict markers (for example, one containing a NUL byte or non-UTF-8 bytes); the repository's file (or deletion) is kept untouched, not counted as a conflict, and the row includes the reason when markers could not be written. `plan` prints the `git diff` of old vs new. |
| `conflict`              | Both sides changed the same region or JSON key; `git merge-file` markers (`<<<<<<< ours`) were written.                                                                                                                                                                                                                                                                                                                                 |
| `conflict-add`          | Added by the template while a different file already exists in the repository; `git merge-file` ran against an empty base.                                                                                                                                                                                                                                                                                                              |
| `conflict-delete`       | Deleted on one side and modified on the other for a text file; conflict markers are written with an empty side noting who deleted it (`>>>>>>> new (deleted by template)` or `<<<<<<< ours (deleted by owner)`). Files that cannot hold text conflict markers (such as files containing a NUL byte) keep the repository's state as `template-copy-changed` with a reason instead.                                                       |
| `conflict-link`         | A symbolic link disagreed across old, new, and the repository; the repository's entry was kept.                                                                                                                                                                                                                                                                                                                                         |

`plan` prints the per-file rows, any `package.json` dependency version changes, and the `git diff` between the old and new regenerated copies for every `template-copy-changed` path. It removes its temporary worktree and exits `0` even when conflicts are present.

## Applying, resolving conflicts, and rerunning

`apply` never touches the repository's working tree, current branch, or stash, and never pushes. It works under `.worktrees/` inside the repository:

- Temporary merge worktree: `.worktrees/template-upgrade-tmp`
- Active upgrade worktree: `.worktrees/template-upgrade-<target7>`
- Published branch: `template-upgrade/<base7>-<target7>`

### Worktree lock and manual removal

Right after this command creates a worktree (`git worktree add`), it locks it with `git worktree lock --reason "template-upgrade <target commit>" <path>`. Both `.worktrees/template-upgrade-tmp` and `.worktrees/template-upgrade-<target7>` carry that lock (kept through `git worktree move`).

Before removing anything at `.worktrees/template-upgrade-tmp` or `.worktrees/template-upgrade-<target7>`, the command inspects `git worktree list --porcelain` and removes a worktree only when it is locked with a reason starting `template-upgrade `. Anything else at either path (an unlocked worktree, a worktree locked for another reason, or a plain folder or file) is refused (`worktree_not_owned`) and left untouched.

To remove a leftover upgrade worktree by hand, unlock it first and then remove it:

```bash
git worktree unlock .worktrees/template-upgrade-<target7>
git worktree remove .worktrees/template-upgrade-<target7>
```

Add `--force` to `git worktree remove` if the worktree contains uncommitted changes you no longer need.

### Apply statuses and exit codes

| Status                   | Exit | Meaning                                                                                                                                                                                                                                                                         |
| ------------------------ | ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `up-to-date`             | `0`  | Base and target commits match; nothing written.                                                                                                                                                                                                                                 |
| `already-done`           | `0`  | `template-upgrade/<base7>-<target7>` already exists with `HEAD` as its parent; a leftover upgrade worktree is removed only when it is locked by this command (`template-upgrade `) and clean at the published commit, otherwise it is left untouched and one line explains why. |
| `applied`                | `0`  | Merged, installed and checked (unless `--no-check`), committed as `Upgrade template <base7> to <target7>`, branch created, worktree removed.                                                                                                                                    |
| `conflicts`              | `2`  | Conflicts remain in `.worktrees/template-upgrade-<target7>`.                                                                                                                                                                                                                    |
| `resolution-in-progress` | `5`  | You started editing `.worktrees/template-upgrade-<target7>` but `<<<<<<< ours` markers remain.                                                                                                                                                                                  |
| `check-failed`           | `1`  | `bun install` or `bun run check` failed in `.worktrees/template-upgrade-<target7>`; worktree kept.                                                                                                                                                                              |

### Resolving conflicts and rerunning

1. Open `.worktrees/template-upgrade-<target7>` and resolve each listed conflict (removing all `<<<<<<< ours`, `=======`, and `>>>>>>> new` markers):
   - When the template deleted a file you edited, the file holds your content wrapped with an empty `>>>>>>> new (deleted by template)` side. Remove the markers to keep your file, or delete the file to accept the template's deletion.
   - When you deleted a file the template changed, the file is written with an empty `<<<<<<< ours (deleted by owner)` side and the template's content on the `new` side. Remove the markers to take the template's file, or delete the file to keep it deleted.
2. Run the exact same `bun run upgrade apply --repository PATH [--to REF]` command again.
3. Because the worktree differs from a fresh merge (including when a resolution deletes a conflicted file) and has no remaining markers, `apply` uses your resolved tree (without re-merging or nesting markers), runs `bun install` and `bun run check` (unless `--no-check`), stages only the changed paths by name (including `bun.lock` if `bun install` updated it), commits, creates `template-upgrade/<base7>-<target7>`, and removes the worktree.
4. Rerunning `apply` after completion reports `already-done` and exits `0`.
5. If a run is interrupted at any step before completion, rerunning the same `apply` command converges to the same branch and tree. If `.worktrees/template-upgrade-<target7>` is left over from an older `HEAD`, `apply` refuses and leaves it untouched so your edits are never lost.
