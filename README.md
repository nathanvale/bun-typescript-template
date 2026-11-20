# Bun TypeScript repository bootstrap

Create a repository from one explicit profile. The bootstrap copies portable
source only; it does not install dependencies, initialize Git, create a remote,
or modify agent/plugin configuration.

## Choose a profile

| Profile   | Use it for                                           | Included checks                                                |
| --------- | ---------------------------------------------------- | -------------------------------------------------------------- |
| `scratch` | A contained, dump-and-run experiment                 | TypeScript and focused tests only                              |
| `durable` | Maintained code, reusable tools, or shared libraries | Typed ESLint, TypeScript, tests, formatting, and native Fallow |

The monorepo layout is an optional durable example. It is never part of the
scratch profile.

The durable profile also supplies two CLI starters. `simple` is read-only.
`complex` demonstrates a local configuration change, typed contracts and
Branch Station discovery. Each generated CLI is a standalone project with its
own dependencies, lockfile, checks and CI.

`--kernel` makes a durable CLI on the installed kernel instead. Its
`package.json` names the kernel by the template's pin, and it gets the kernel
lockfile and a pointer skill for each kernel skill. Bootstrap reads the kernel
repository beside this checkout.

## Bootstrap

From this template checkout:

```sh
bun run bootstrap --profile scratch \
  --destination "$HOME/code/scratch/example" \
  --source-packet "https://example.test/vault/projects/example/"

bun run bootstrap --profile durable \
  --destination "$HOME/code/example" \
  --source-packet "https://example.test/vault/projects/example/"

bun run bootstrap --profile durable --starter simple \
  --destination "$HOME/code/example-cli" \
  --source-packet "https://example.test/vault/projects/example-cli/"

bun run bootstrap --profile durable --starter complex \
  --destination "$HOME/code/example-control-cli" \
  --source-packet "https://example.test/vault/projects/example-control-cli/"

bun run bootstrap --profile durable --kernel \
  --destination "$HOME/code/example-kernel-cli" \
  --source-packet "https://example.test/vault/projects/example-kernel-cli/"

bun run bootstrap --profile durable \
  --destination "$HOME/code/example-monorepo" \
  --source-packet "https://example.test/vault/projects/example-monorepo/" \
  --monorepo
```

Use `--json` for a stable machine-readable result. The bootstrap refuses an
existing non-empty destination and preserves its files.

Each generated README owns its repository-root install, run, and check commands.

## Template checks

```sh
bun install --frozen-lockfile
bun run check
```

This repository uses Bun 1.4.4, TypeScript 7.1.0-beta for compilation,
TypeScript 6.0.2 for ESLint 10.15.0 with typescript-eslint 8.73.0, Biome 2.6.7
for formatting only, and native Fallow plus its semantic companion at 3.43.2.
The companion keeps its own TypeScript 7.0.2. Generated repositories get the
same versions: `tests/template/toolchain/generated-toolchain.test.ts` fails when
a recipe folder's `package.json` or `bun.lock` installs another version of a
package this repository uses, or lacks one of its overrides. Generated scratch
repositories intentionally omit Biome, Fallow, CI, hooks, release tooling, and
monorepo structure.

The TypeScript 6 compatibility wrapper has its own version and delegates to
`@typescript/old`. The alias-specific override pins that underlying API to
6.0.2 as well. Keep the override and Bun-generated version 3 lockfiles together;
static admission checks the loaded API, wrapper and native compiler separately.

Every generated repository has one application CLI. Its commands live in
separate internal files. A workspace exposes the root CLI and keeps member
packages as libraries. `bun run admit:cli -- <repository-root>` checks its
entry points across source, manifests, scripts and documented invocations.

Generated `AGENTS.md` gives the exact check and smoke commands.
`.cli-design-template.json` records source-packet and template provenance,
including whether the source checkout had uncommitted changes.

`eslint-rules.mjs` demonstrates one local custom rule. Its ownership rule
prevents domain modules from writing to stdout or stderr. Every durable
recipe also copies this repository's own lint rule files from `config/` and
turns on the same rules for the same kinds of file, `no-comments` among them.
`tests/template/toolchain/generated-lint.test.ts` fails when a generated
repository lacks one of those files, holds another copy, or leaves a rule
off. Formatting checks never rewrite files.
