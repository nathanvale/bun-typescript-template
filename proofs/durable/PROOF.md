# Durable Profile — Verification Proof

Bounded owner: `profiles/durable/**`, `examples/monorepo/**`,
`proofs/durable/**` in `bun-typescript-template`, branch `feat/durable-profile`.
No root/shared file was created or edited.

This is profile-source evidence from this lane only: what runs when the
checks execute directly against the committed profile sources inside this
template repository's own worktree, which has a different (older, shared)
git history than any generated destination will have. It is not proof of
what a freshly generated repository produces end to end — the coordinator
and the integration reviewer own that fresh generated-destination
verification.

Toolchain used to run these checks (locally installed, matching the pinned
versions): Bun `1.4.0`, Biome `2.4.15`, TypeScript `7.0.2`, Fallow `3.19.0`.

## Bootstrap does not initialize Git

Bootstrap only copies a profile's files to the generated repository's root.
It does not run `git init` or create a commit. Both `README.md` files record
the exact setup a generated repository needs before its first
`quality:fallow` run, since Fallow's `new-only` audit gate requires a
comparison base:

```sh
git init -b main
bun install --frozen-lockfile
git add <the generated scaffold paths>
git commit -m 'chore: initialize repository'
bun run check
```

`bun install --frozen-lockfile` is why both profiles now commit their
generated `bun.lock` (see "Lockfiles" below) instead of ignoring it.

## `profiles/durable/` — profile-only evidence

Commands, run with an absolute `--cwd`/`-C` path in `profiles/durable/`
inside this worktree (the template repository's own git history — branch
`feat/durable-profile`, base branch `main` at the shared root commit
`a1f4dc5`, not a generated repository's history):

```sh
bun install --cwd /Users/nathanvale/code/.worktrees/bun-typescript-template-durable/profiles/durable
bun run --cwd /Users/nathanvale/code/.worktrees/bun-typescript-template-durable/profiles/durable check
```

Result: `bun install` — 12 installs across 46 packages, exit 0.
`bun run check` — exit 0:

- `biome:check`: `Checked 7 files in ...ms. No fixes applied.`
- `typecheck`: `tsc --noEmit -p tsconfig.json` — no output, exit 0.
- `test`: `bun test` — `1 pass, 0 fail, 1 expect() calls`.
- `quality:fallow` — now the repo-local invocation
  `node_modules/.bin/fallow audit --format json --quiet --type-aware
  --type-aware-require best-effort` (not ambient `PATH` resolution) —
  `"verdict":"pass"`, `dead_code_issues: 0`, `complexity_findings: 0`,
  `duplication_clone_groups: 0`, type-aware `"completeness":"complete"`.

A second, isolated check copied `profiles/durable/` to a fresh temp directory
(no git repo) and ran `bun install` + `biome check` + `tsc --noEmit` +
`bun test` directly: same pass results. `quality:fallow` cannot run there
because Fallow's `audit` command requires a git repository to resolve a base
ref regardless of `--gate`; a temp copy with no `git init` is not evidence
either way for that check, which is why it is proven only against real git
history above (this worktree's), and, separately, will be proven again by the
coordinator/integration reviewer against an actual generated destination
following the exact setup sequence above.

## `examples/monorepo/` — profile-only evidence

Same treatment, run with an absolute `--cwd` path in `examples/monorepo/`
inside this worktree:

```sh
bun install --cwd /Users/nathanvale/code/.worktrees/bun-typescript-template-durable/examples/monorepo
bun run --cwd /Users/nathanvale/code/.worktrees/bun-typescript-template-durable/examples/monorepo check
```

Result: `bun install` — 14 installs across 47 packages, exit 0.
`bun run check` — exit 0:

- `biome:check`: `Checked 8 files in ...ms. No fixes applied.`
- `typecheck`: `bun run --filter '*' typecheck` —
  `__REPOSITORY_NAME__-example-lib typecheck: Exited with code 0`.
- `test`: `bun run --filter '*' test` —
  `__REPOSITORY_NAME__-example-lib test: 1 pass, 0 fail` — `Exited with code 0`.
- `quality:fallow` (repo-local invocation) — `"verdict":"pass"`.

Independent of the durable profile's own check run: each has its own
`package.json`, `tsconfig.base.json`, `biome.jsonc`, `.fallowrc.json`,
`node_modules`, and lockfile; neither install touches the other's tree.

## Strictness

Neither `profiles/durable/tsconfig.base.json` nor
`examples/monorepo/tsconfig.base.json` nor any per-package `tsconfig.json`
under either tree relaxes `strict`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, or `noUncheckedIndexedAccess`. All four are
`true` at the base and inherited as-is everywhere.

## Source-packet token

`README.md` in both `profiles/durable/` and `examples/monorepo/` carries the
literal integration token `__SOURCE_PACKET__` under a "Source packet"
heading; `bootstrap --source-packet PATH_OR_URL` replaces it with the exact
value supplied. `grep -rn '{{SOURCE_PACKET}}'` across `profiles/durable/` and
`examples/monorepo/` returns no matches.

## Repository-name token

`profiles/durable/package.json` and `examples/monorepo/package.json` carry
`"name": "__REPOSITORY_NAME__"`. The monorepo's child package is
`__REPOSITORY_NAME__-example-lib` — unscoped, so it renders to a valid
lowercase unscoped npm name once `__REPOSITORY_NAME__` is substituted with an
actual lowercase repository name (e.g. `my-app` → `my-app-example-lib`).
Confirmed working as-is (with the literal placeholder still in place):
`bun run --filter '*' typecheck` and `test` both resolved and ran the
workspace member under that name with exit 0.

## Lockfiles

`profiles/durable/bun.lock` and `examples/monorepo/bun.lock` are committed
(regenerated after the package-name and script edits above); neither
`.gitignore` excludes `bun.lock` anymore. This is what lets a generated
repository's first `bun install --frozen-lockfile` succeed without first
resolving dependencies from scratch.

## CI

Neither `profiles/durable/` nor `examples/monorepo/` ships a CI workflow.
Both READMEs and `TEMPLATE-SOURCE.md` state CI is a deliberate, separate
decision — not automatic because a repository is durable or was promoted from
scratch.

## Template-source documentation

`TEMPLATE-SOURCE.md` (contributor-facing, not shipped) lives only under
`profiles/durable/`. Neither `README.md` references it or any
`profiles/durable/` path anymore — a generated repository has no sibling
`profiles/durable/` directory to point to. `grep -rn 'TEMPLATE-SOURCE.md'
profiles/durable/README.md examples/monorepo/README.md` and `grep -rn
'profiles/durable' profiles/durable/README.md examples/monorepo/README.md`
both return no matches.
