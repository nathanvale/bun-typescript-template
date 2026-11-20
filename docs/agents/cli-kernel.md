# CLI Kernel Authority

These sources define the command contract the CLI kernel implements.

- Frozen Command Contract 3 text: `agent-engineering` repository, skill
  `agent-cli-design`, `references/contract-3/`. Cite it by that path. Read
  it at published commit `648f93275717d5b031dd4bb4fc67f80cd9940383`.
- Accepted identity: commit `5693651d19c6fba2430c904688e583266dbe58a0`,
  manifest `c162c9850ca506fd839ce36b2b1a8172f064516b0f229dd34a5678b366b02b9d`.
  A path redaction rewrote that history, so the commit is unpublished;
  `references/contract-3/redaction-2026-11-16.md` on that repository's
  `codex/contract-3-foundation` branch maps each frozen commit to its
  published one and lists the two files that differ.
- Preserve the behaviour at an accepted decision cited in code or tests.
  Each settles a point the frozen text leaves open. Follow the
  [citation convention](../standards/gate-coverage.md#comments) and consult
  the MAG-98 findings ledger under [Coordination context](#coordination-context).

## The kernel repository in tests

- The `pin-move` and `kernel-trial` test areas read the kernel repository
  beside the template, where the hosted check places it at the pinned commit.
- From a worktree of the template, fault replay's included, the tests find
  it beside the main checkout.
- From anywhere else, clone the kernel repository and name its path in
  `KERNEL_REPOSITORY`.

## Coordination context

These private planning records live outside this repository. Your task brief
supplies the parts your task may use. If your task needs a record that the
brief does not supply, report it as missing context with its identity and
planning record owner from this list.

- Foundation specification and Contract 3 decision record, in the
  `my-second-brain-playground` repository:
  `projects/cli-design-skill/specs/contract-3-foundation.md` and
  `projects/cli-design-skill/contract-3-decision-log.md`. Owner: Linear
  MAG-98.
- Scope, open findings, and accepted decisions: Linear MAG-98 and its findings
  ledger. Owner: Linear MAG-98.
- Shared vocabulary: "Agent ecosystem glossary (living)" in Linear. Owner:
  Engineering, through Linear MAG-64.
