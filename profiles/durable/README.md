# Durable Profile

Bootstrap profile for a maintained product, shared library, or long-lived code
owner. Bootstrap copies the contents of this directory to the generated
repository's root.

## Source packet

`__SOURCE_PACKET__`

Bootstrap substitutes this token with the `--source-packet` value supplied at
generation time.

## Pinned toolchain

- Bun `1.4.0` (`packageManager`, `bunfig.toml` `install.auto = "disable"`)
- TypeScript `7.0.2` (exact devDependency)
- `@types/bun` `1.4.0` (exact devDependency)
- Biome `2.4.15` (exact)
- Fallow `3.19.0` (exact; TypeScript and Fallow move as a pinned pair)

## Checks this profile includes

`bun run check` runs, in order:

1. `biome:check` — `biome check --diagnostic-level=error .`
2. `typecheck` — `tsc --noEmit -p tsconfig.json`. The full `tsconfig.base.json`
   is inherited as-is: `strict`, `verbatimModuleSyntax`,
   `exactOptionalPropertyTypes`, and `noUncheckedIndexedAccess` are all on and
   are not relaxed anywhere in this profile.
3. `test` — `bun test`
4. `quality:fallow` — `node_modules/.bin/fallow audit --format json --quiet
   --type-aware --type-aware-require best-effort` (gate follows the audit
   `verdict`; a type-aware incompleteness is advisory, not blocking)

## CI

This profile ships no CI workflow. CI is optional: adopt it deliberately when
the repository needs one, not automatically because it is durable or has been
promoted from scratch.

## Bootstrap

Bootstrap does not initialize Git. Fallow's `new-only` audit gate needs a
comparison base, so initialize one before the first check, from the generated
repository's root (this directory, once copied):

```sh
git init -b main
bun install --frozen-lockfile
git add <the generated scaffold paths>
git commit -m 'chore: initialize repository'
bun run check
```

## Optional monorepo layout

A multi-package layout is available as a separate, self-contained example
under `examples/monorepo/` — not required here. Adopt it only when this
profile grows into more than one package.
