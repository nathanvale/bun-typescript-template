---
"bun-typescript-template": major
---

Switched the template and generated repositories from `change-notes/` to upstream Changesets (`.changeset/`, `@changesets/cli@3.0.3`, `@changesets/read@1.0.1`, `scripts/check-gated-paths.ts`, and `tests/changeset-action.test.ts`), renamed `changeNotes` to `changesets` in `template upgrade --json` and `pin-move`, and added a `Changesets` pull-request step to the generated hosted check workflow.

Action: Run `bun run upgrade apply --repository PATH` to adopt `.changeset/` and `scripts/check-gated-paths.ts`, convert any existing `change-notes/*.json` files in your repository to `.changeset/<stem>.md`, remove `change-notes/`, and update any scripts reading `changeNotes` from `template upgrade --json` to read `changesets`.
