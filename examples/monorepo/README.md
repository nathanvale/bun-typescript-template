# Monorepo Example (optional)

Self-contained multi-package layout for the durable profile. Not required for
single-package use. Adopt only when the durable profile grows into more than
one package.

Same pinned toolchain and check contract: Bun `1.4.4`, native TypeScript `7.1.0-beta`,
ESLint `10.15.0` with TypeScript `6.0.2` and typescript-eslint `8.73.0`,
Biome `2.6.7` for formatting, Fallow and its semantic companion `3.43.2`, one shared `tsconfig.base.json` inherited in
full (`strict`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`,
`noUncheckedIndexedAccess` all on, not relaxed by any member package). Root lint covers source and tests across all packages. Root CLI tests run
before member tests; members declare `test` and `typecheck`.

CI is optional here too: this example ships no CI workflow, and adopting the
monorepo layout does not by itself require adding one.

## Source packet

`__SOURCE_PACKET__`

Bootstrap substitutes this token with the `--source-packet` value supplied at
generation time.

## Bootstrap

Install Node.js and put it on `PATH` before running the checks. Node.js 24 is
a supported choice. Fallow runs `node` for its type-aware TypeScript analysis.
Run `node -p 'process.versions.bun ? "Bun" : process.version'` to check which
runtime your shell finds. Expect a Node.js version such as `v24.20.0`.

Bootstrap does not initialize Git. Fallow's audit needs a Git comparison base even when all findings are gated. Establish an empty local baseline before the first check so
the generated scaffold remains visible as new work:

```sh
git init -b main
git commit --allow-empty -m "chore: establish comparison base"
bun install --frozen-lockfile
bun run check
```

After the check passes, commit the generated scaffold with your normal Git
identity. Git must already have your user name and email configured.
