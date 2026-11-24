# Changesets

A branch that changes `package.json` or any file under `src/` needs a changeset in this folder.

- Add one: `bun run --bun changeset add --minor __REPOSITORY_NAME__ -m "<past-tense summary>"`, then `git add .changeset`.
- No consumer effect: `bun run --bun changeset add --empty`, then `git add .changeset`.
- A `major` changeset needs a later line that begins `Action: ` and tells the reader what to do.
- A `template upgrade` pull request that changes `package.json` or `src/` adds a changeset: `bun run --bun changeset add --patch __REPOSITORY_NAME__ -m "Upgraded template <base> to <target>"`.

Check before you push: `bun run check:changesets`
