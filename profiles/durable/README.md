# Durable Profile

Bootstrap profile for a maintained product, shared library, or long-lived code
owner. Bootstrap copies the contents of this directory to the generated
repository's root.

## Source packet

`__SOURCE_PACKET__`

Bootstrap substitutes this token with the `--source-packet` value supplied at
generation time.

## Pinned toolchain

- Bun `1.4.4` (`packageManager`, `bunfig.toml` `install.auto = "disable"`)
- Native TypeScript `7.1.0-beta` for compilation, TypeScript `6.0.2` for linting
- ESLint `10.15.0` with typescript-eslint `8.73.0` and its recommended typed preset
- `@types/bun` `1.4.4` (exact devDependency)
- Biome `2.6.7` for formatting only
- Fallow and its semantic companion `3.43.2` (exact)

## Checks this profile includes

`bun run check` runs, in order:

1. `lint`: typed ESLint on source and tests, including repository-local rules
   and the template's rules in `config/`, which refuse comments in code.
2. `format:check`: Biome formatting without writes; lint and assist are disabled.
3. `typecheck`: native TypeScript, inheriting the strict base configuration.
4. `test`: Bun tests, including the repository CLI process tests.
5. `quality:fallow`: complete native semantic evidence and all findings gated.

## CI

This profile ships no CI workflow. CI is optional: adopt it deliberately when
the repository needs one, not automatically because it is durable or has been
promoted from scratch.

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

## Optional monorepo layout

A multi-package layout is available as a separate, self-contained bootstrap
profile. From the template checkout, run `bun run bootstrap --profile durable
--destination PATH --source-packet PATH_OR_URL --monorepo`. It is not required
here and is not shipped as a subdirectory of this repository.
