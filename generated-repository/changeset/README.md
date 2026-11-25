# Changesets

A branch that changes `package.json` or any file under `src/` needs a changeset in this folder.

- Add one: `bun run --bun changeset add --minor __PACKAGE_NAME__ -m "<past-tense summary>"`, then `git add .changeset`.
- No consumer effect: `bun run --bun changeset add --empty`, then `git add .changeset`.
- A `major` changeset needs a later line that begins `Action: ` and tells the reader what to do.
- A `template upgrade` pull request that changes `package.json` or `src/` adds a changeset: `bun run --bun changeset add --patch __PACKAGE_NAME__ -m "Upgraded template <base> to <target>"`.

Check before you push: `bun run check:changesets`

## Release

Cut a version pull request on a branch:

1. Run `bun run --bun changeset version`. Exit 1 with no file changed (`git status --porcelain` empty) means nothing to release; any other non-zero exit is a failure.
2. Add an empty changeset so the branch's own changeset check passes: `bun run --bun changeset add --empty`.
3. Stage `package.json`, `CHANGELOG.md`, the removed `.changeset/*.md` files and the new empty changeset with explicit paths, commit, run `bun run check:changesets`, and open a pull request for Nathan to merge. Version pull requests only update files; never publish or tag.

One-time backfill: run `agent-gates changelog earlier --pull-requests <file> --changelog CHANGELOG.md --package __PACKAGE_NAME__ --changesets-from <n> --json`, confirm `.result.data.changelog` has one `## Earlier changes` heading, and write it to `CHANGELOG.md`.
