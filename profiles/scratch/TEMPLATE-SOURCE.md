# Template-Source Notes (not shipped to generated repositories)

This file is for contributors editing this profile inside the
`bun-typescript-template` bootstrap repository. It is **not** copied into a
generated repository. Only `README.md` and the code alongside it are.

## Token contract

`README.md` in this profile carries one substitution token:

| Token | Filled by | With |
| --- | --- | --- |
| `__SOURCE_PACKET__` | `bun run bootstrap --profile scratch --destination PATH --source-packet PATH_OR_URL` | The exact `--source-packet` value the coordinator passed |

`bootstrap` performs a literal string replacement of `__SOURCE_PACKET__` in
the copied `README.md` with the `--source-packet` argument. No path is
hardcoded in this profile's source. Every generated instance carries its own
caller-supplied source packet reference.

## Placement guidance this profile follows

This profile implements the "Scratch profile" contract described in the
dotfiles repository's `docs/agents/work-placement.md` (source packet:
`/Users/nathanvale/code/.worktrees/dotfiles-work-placement/docs/agents/work-placement.md`
at commit `fd065bec`, merged via `nathanvale/dotfiles-private#136`,
commit `9d62eafea447269bb4517f9cf36f0878fb6f313a`). That path only exists in
the dotfiles repository. A generated repository has no reason to reference
it, which is why `README.md` above does not link it.

## Why the run commands have no `cd`

`bootstrap` copies this profile's contents to the generated repository's
root, not to a `profiles/scratch/` subdirectory. `README.md` is written as if
it already sits at that root.
