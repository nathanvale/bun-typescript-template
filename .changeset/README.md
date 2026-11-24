# Changesets

A branch that changes any gated path needs a changeset in this folder. Gated paths are `generated-repository/**`, `kernel-pin.json`, the six copied lint rule files under `config/`, `tests/support/test-folder.ts`, `src/bootstrap.ts`, `src/bootstrap-arguments.ts`, `src/kernel-pin.ts`, `src/recipe.ts`, and `src/token-substitution.ts`.

- Add a changeset: `bun run --bun changeset add --minor bun-typescript-template -m "<past-tense summary>"`, then run `git add .changeset`.
- Record a gated change with no consumer effect: `bun run --bun changeset add --empty`, then run `git add .changeset`.
- Include a later line starting with `Action: ` in every `major` changeset to tell the reader what to do.

Run `bun run check:changesets` before you push.
