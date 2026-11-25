# Pull Requests

- Run the `code-review` skill on the branch before opening the pull
  request, with the review done by a different model from the one that wrote
  the code: a Monash Sol 6.1 worker started with `monash-worker`. Fix what it
  finds.
- Add a changeset under `.changeset/` when a pull request changes a gated path
  (`generated-repository/**`, the copied lint rule files in `config/`,
  `tests/support/test-folder.ts`, `tests/support/test-run-folder.ts`,
  `scripts/test-run.ts`, `kernel-pin.json`, `src/recipe.ts`,
  `src/bootstrap.ts`, `src/bootstrap-arguments.ts`,
  `src/token-substitution.ts`, or `src/kernel-pin.ts`): run
  `bun run --bun changeset add --minor bun-typescript-template -m "<summary>"`
  (or `--empty` when there is no consumer effect), include a later `Action: `
  line on every `major` changeset, and run `bun run check:changesets`. See
  [.changeset/README.md](../../.changeset/README.md).
- Open the pull request ready for review, never as a draft.
- Write its body with the `pr` skill.
- Drive the open pull request with the Babysit playbook in pstack's
  `poteto-mode` skill.
- Bring the branch up to date by merging `main` into it. Never rebase or
  force-push.
- Do not wait on CodeRabbit; it may not review. Copilot reviews each pull
  request once when it opens. A complex pull request gets up to three
  Copilot reviews, one after each round of fixes, at Balanced effort when it
  is really complex; the repository default stays at Lite. While Copilot has
  no review quota, add one review in its place before merge: a fresh Fable
  5.2 agent for a complex pull request, or one more Sol 6.1 worker for any
  other. Ask the coordinator before dropping that review once the quota
  returns.
- Only the pull request's author pushes to its branch. Leave the review
  bots' fix buttons, such as CodeRabbit's "Fix comments", unticked.
- Answer every review thread. Commit each fix, then run the
  [repo-gardener](../../.agents/skills/repo-gardener/SKILL.md) Sow job on
  a clean tree for each finding about code, tests, check commands, or
  gates. Commit what Sow writes. Route instruction wording to the
  document's owner. Push the fixes as one batch.
- Only the coordinator merges, with a merge commit, when all of these hold:
  every required hosted check is green at the current head; no review
  thread is open; an agent that did not write the pull request, on a different model
  (a Monash Sol 6.1 worker), has checked it against its acceptance and passed
  it at the current head, or such an agent, one that did not write those
  commits, has rechecked every commit after the checked head; and it changes no README design,
  layout, structure or length, no version, tag, release or publication, and
  needs no admin bypass. Any other pull request waits for the operator.
  GitHub protects `main` from direct pushes.
