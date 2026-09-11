# Monorepo Example (optional)

Self-contained multi-package layout for the durable profile. Not required for
single-package use. Adopt only when the durable profile grows into more than
one package.

Same pinned toolchain and check contract: Bun `1.4.0`, TypeScript `7.0.2`,
Biome `2.4.15`, Fallow `3.19.0`, one shared `tsconfig.base.json` inherited in
full (`strict`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess` all on, not relaxed by any member package). Every
workspace member declares `lint` and `test`; TypeScript members also declare
`typecheck`.

CI is optional here too: this example ships no CI workflow, and adopting the
monorepo layout does not by itself require adding one.

## Source packet

`__SOURCE_PACKET__`

Bootstrap substitutes this token with the `--source-packet` value supplied at
generation time.

## Bootstrap

Bootstrap does not initialize Git. Fallow's `new-only` audit gate needs a
comparison base. Establish an empty local baseline before the first check so
the generated scaffold remains visible as new work:

```sh
git init -b main
git commit --allow-empty -m "chore: establish comparison base"
bun install --frozen-lockfile
bun run check
```

After the check passes, commit the generated scaffold with your normal Git
identity. Git must already have your user name and email configured.
