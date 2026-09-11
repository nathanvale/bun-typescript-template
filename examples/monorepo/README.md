# Monorepo Example (optional)

Self-contained multi-package layout for the durable profile. Not required for
single-package use — adopt only when the durable profile grows into more than
one package.

Same pinned toolchain and check contract as `profiles/durable/`: Bun `1.4.0`,
TypeScript `7.0.2`, Biome `2.4.15`, Fallow `3.19.0`, one shared
`tsconfig.base.json` inherited in full (`strict`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` all on, not relaxed
by any member package). Every workspace member declares `lint` and `test`;
TypeScript members also declare `typecheck`.

CI is optional here too: this example ships no CI workflow, and adopting the
monorepo layout does not by itself require adding one.

## Source packet

`{{SOURCE_PACKET}}`

Bootstrap substitutes this token with the `--source-packet` value supplied at
generation time; see `profiles/durable/TEMPLATE-SOURCE.md` for the token
contract (this example follows the same contract).

## Bootstrap

Run from the generated repository root (this directory, once copied):

```sh
bun install
bun run check
```
