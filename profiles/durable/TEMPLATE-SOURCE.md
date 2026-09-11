# Template-Source Notes (not shipped to generated repositories)

This file is for contributors editing this profile inside the
`bun-typescript-template` bootstrap repository. It is **not** copied into a
generated repository — only `README.md` and the code alongside it are.

## Token contract

`README.md` in this profile carries one substitution token:

| Token | Filled by | With |
| --- | --- | --- |
| `__SOURCE_PACKET__` | `bun run bootstrap --profile durable --destination PATH --source-packet PATH_OR_URL` | The exact `--source-packet` value the coordinator passed |

`bootstrap` performs a literal string replacement of `__SOURCE_PACKET__` in
the copied `README.md` with the `--source-packet` argument. No path is
hardcoded in this profile's source — every generated instance carries its own
caller-supplied source packet reference. `bootstrap` must fail rather than
ship the literal `__SOURCE_PACKET__` token if no `--source-packet` value is
supplied.

## Placement guidance this profile follows

This profile implements the "durable repository bootstrap contract" and
"Keep a monorepo layout as an optional example, not the scratch default"
lines of the dotfiles repository's `docs/agents/work-placement.md` (source
packet:
`/Users/nathanvale/code/.worktrees/dotfiles-work-placement/docs/agents/work-placement.md`
at commit `fd065bec`, merged via `nathanvale/dotfiles-private#136`, commit
`9d62eafea447269bb4517f9cf36f0878fb6f313a`). That path only exists in the
dotfiles repository — a generated repository has no reason to reference it,
which is why `README.md` above does not link it.

## Why the run commands have no `cd`

`bootstrap` copies this profile's contents to the generated repository's
root, not to a `profiles/durable/` subdirectory. `README.md` is written as if
it already sits at that root. The same applies to `examples/monorepo/`: it is
a second, independent bootstrap root, not a subdirectory of the durable
profile's output.

## Strictness carries forward in full

`tsconfig.base.json` here is the complete shared base — `strict`,
`verbatimModuleSyntax`, `exactOptionalPropertyTypes`, and
`noUncheckedIndexedAccess` all `true`. This is a fresh template, not a
migration: do not add a per-package relaxation of any of the four, here or in
`examples/monorepo/`, and do not carry one forward from prior dotfiles
history.

## CI is not part of this contract

Neither this profile nor `examples/monorepo/` ships a CI workflow. A
generated repository being durable, or a scratch repository being promoted to
durable, does not by itself require adding one — that stays a deliberate,
separate decision by whoever generates or promotes the repository.
