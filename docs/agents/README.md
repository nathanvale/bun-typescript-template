# Agent Guide

- For CLI kernel behaviour or missing planning records, use the
  [CLI kernel authority and record owners](cli-kernel.md).
- For opening, reviewing, or merging a pull request, use the
  [pull request workflow](pull-requests.md).
- For choosing a test area or reproducing a failed hosted check, use
  [Checks](#checks).

## Checks

Run focused tests with `bun run test:area <area>`. Run it without an area
to list the choices. Run the full suite and timing-sensitive cases on
a hosted check or on the test host named in the brief.

For a new or changed refusal or bound, use the
[test proof guide](../standards/test-proof.md#refusals-and-bounds).

For a red `commits` job, run `bun run check:commits <base>`. It checks each
commit at its own head. For a red `fault-replay` job, run
`bun run fault-replay <id>`.

`bun run doctor` verifies the pinned Bun, the installed toolchain, fallow's
readiness and the machine's load, and names a repair for each failure.

A fault replay gives each planted fault one verdict: KILLED, SURVIVED, STALE,
BROKEN or TIMEOUT. The per-commit check gives each commit GREEN or RED.

The names check runs as a test, as a hook when a file is created, and at
commit.
