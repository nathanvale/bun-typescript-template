# Pull Requests

- Run the `code-review` skill on the branch before opening the pull
  request, with the review done by a different model from the one that wrote
  the code (a Monash Sol 6.1 worker). Fix what it finds.
- Open the pull request ready for review, never as a draft. Write its body
  with the `pr` skill.
- Drive the open pull request with pstack's Babysit playbook. Merge `main`
  into the branch to bring it up to date. Never rebase or force-push.
- Do not rely on CodeRabbit or Copilot. Either may review, and neither is
  required by GitHub's merge gate.
- Only the pull request's author pushes to its branch. Leave the review
  bots' fix buttons, such as CodeRabbit's "Fix comments", unticked.
- Answer every review thread. Commit each fix, then run the
  [repo-gardener](../../.agents/skills/repo-gardener/SKILL.md) Sow job on
  a clean tree for each finding about code, tests, check commands, or
  gates. Commit what Sow writes. Route instruction wording to the
  document's owner. Push the fixes as one batch.
- Only the coordinator merges, with a merge commit, when all of these hold:
  every required hosted check is green at the current head; no review
  thread is open; an agent that did not write the pull request has checked
  it against its acceptance and passed it; and it changes no README design,
  layout, structure or length, no version, tag, release or publication, and
  needs no admin bypass. Any other pull request waits for the operator.
  GitHub protects `main` from direct pushes.
