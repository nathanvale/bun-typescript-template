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

- The `pin-move`, `kernel-trial`, `bootstrap` and `toolchain` test areas, and
  `bun run bootstrap`, read the kernel repository beside the template, where
  the hosted check places it at the pinned commit.
- From a worktree of the template, fault replay's included, the tests find
  it beside the main checkout.
- From anywhere else, Bootstrap, a Template upgrade, and the tests that find
  the kernel through `findSiblingKernel` use the kernel cache at
  `$XDG_CACHE_HOME/my-agent-dojo/bun-typescript-template/agent-cli-kernel.git` (or under
  `~/.cache`), cloned from the pin's remote. The pin move, Pin verification
  and the kernel trial do not; for those, clone the kernel repository and
  name its path in `KERNEL_REPOSITORY`. The lookup order is in
  [Template upgrade](../template-upgrade.md#where-the-kernel-repository-comes-from).

## The template's pin

- The template's pin is `kernel-pin.json`. It names the kernel repository,
  its remote, one full commit, the branch that commit must stay reachable
  from, and the carry-out identity no pin may precede.
- A generated repository's pin is one dependency line in its `package.json`:
  `"agent-cli-kernel": "github:nathanvale/agent-cli-kernel#<full 40-character commit>"`.
  The kernel's glossary defines Pin.

## Pin verification

- For a red `pin-verification` job, run `bun run pin-verification` with the
  kernel repository beside the template. Its refusal names its code and its
  repair.

## Moving the pin and reading the kernel

- A pin move needs a passed kernel trial. When the pin names a kernel branch,
  the new commit must be reachable from it.
- The kernel reader reads the kernel's files from git objects at one commit,
  never from a working tree. Its seam takes a local path to a kernel
  repository and one full commit. Its adapters are the sibling repository, any
  local clone, and a test stand-in.

## The kernel trial on any commit

- To try a kernel commit without moving the pin, run
  `bun run kernel-trial <full kernel commit>`. The kernel repository's hosted
  check runs it on the head commit of each kernel pull request, as advice
  only.

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
