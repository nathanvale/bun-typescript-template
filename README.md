# Bun TypeScript repository bootstrap

Create a repository from one explicit profile. The bootstrap copies portable
source only; it does not install dependencies, initialize Git, create a remote,
or modify agent/plugin configuration.

## Choose a profile

| Profile | Use it for | Included checks |
| --- | --- | --- |
| `scratch` | A contained, dump-and-run experiment | TypeScript and focused tests only |
| `durable` | Maintained code, reusable tools, or shared libraries | TypeScript, tests, Biome, and native Fallow |

The monorepo layout is an optional durable example. It is never part of the
scratch profile.

The durable profile also supplies two CLI starters. `simple` is read-only.
`complex` demonstrates a local configuration change, typed contracts and
Branch Station discovery. Each generated CLI is a standalone project with its
own dependencies, lockfile, checks and CI.

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

This repository follows the durable toolchain proven in the dotfiles workspace:
Bun 1.4.0, TypeScript 7.0.2, Biome 2.4.15, and native Fallow 3.19.0. Generated
scratch repositories intentionally omit Biome, Fallow, CI, hooks, release
tooling, and monorepo structure.
