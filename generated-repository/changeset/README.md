# Changesets

A branch that changes `package.json` or any file under `src/` needs a changeset in this folder.

- Add one: `bun run --bun changeset add --minor __PACKAGE_NAME__ -m "<past-tense summary>"`, then `git add .changeset`.
- No consumer effect: `bun run --bun changeset add --empty`, then `git add .changeset`.
- A `major` changeset needs a later line that begins `Action: ` and tells the reader what to do.
- A `template upgrade` pull request that changes `package.json` or `src/` gets its changeset from `upgrade apply` (`.changeset/template-upgrade-<target7>.md`).

Check before you push: `bun run check:changesets`

## Release

Cut a version pull request on a branch:

1. Check `.changeset/*.md` other than `README.md` first: if none exist, or every pending changeset is empty (no package in its front matter), there is nothing to release; stop here instead of cutting an empty version pull request. Otherwise run `bun run --bun changeset version`; any non-zero exit is a failure to report, never "nothing to release".
2. Add an empty changeset so the branch's own changeset check passes: `bun run --bun changeset add --empty`.
3. Stage `package.json`, `CHANGELOG.md`, the removed `.changeset/*.md` files and the new empty changeset with explicit paths, commit, run `bun run check:changesets`, and open a pull request for Nathan to merge. Version pull requests only update files; never publish or tag.

One-time backfill: run `agent-gates changelog backfill --pull-requests <file> --changelog CHANGELOG.md --package __PACKAGE_NAME__ --changesets-from <n> --json`, confirm `.result.data.changelog` has one `## Earlier changes` heading, and write it to `CHANGELOG.md`.
