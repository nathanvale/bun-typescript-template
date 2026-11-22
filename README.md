# Bun TypeScript repository bootstrap

Create a repository with the kernel at the template's Pin. The bootstrap
copies portable source only; it does not install dependencies, initialize Git,
create a remote, or modify agent/plugin configuration.

The generated repository's `package.json` names the kernel by the template's
pin, and it gets the kernel lockfile and a pointer skill for each kernel skill.
Bootstrap reads the kernel repository beside this checkout, or at
`KERNEL_REPOSITORY`.

## Bootstrap

From this template checkout:

```sh
bun run bootstrap \
  --destination "$HOME/code/example-cli" \
  --source-packet "https://example.test/vault/projects/example-cli/"
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
a generated repository's `package.json` or `bun.lock` installs another version
of a package this repository uses, or lacks one of its overrides.

The TypeScript 6 compatibility wrapper has its own version and delegates to
`@typescript/old`. The alias-specific override pins that underlying API to
6.0.2 as well. Keep the override and Bun-generated version 3 lockfiles together.

Every generated repository has one application CLI. Its commands live in
separate internal files. `bun run admit:cli -- <repository-root>` checks its
entry points across source, manifests, scripts and documented invocations.

Generated `AGENTS.md` gives the exact check and smoke commands.
`.template.json` records source-packet and template provenance,
including whether the source checkout had uncommitted changes.

Bootstrap copies this repository's own lint rule files from `config/`, and the
generated repository turns on the same rules for the same kinds of file,
`no-comments` among them.
`tests/template/toolchain/generated-lint.test.ts` fails when a generated
repository lacks one of those files, holds another copy, or leaves a rule
off. Formatting checks never rewrite files.
