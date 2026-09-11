# Durable Profile — Verification Proof

Bounded owner: `profiles/durable/**`, `examples/monorepo/**`,
`proofs/durable/**` in `bun-typescript-template`, branch `feat/durable-profile`.
No root/shared file was created or edited; the repository root has no files
outside these three trees plus the pre-existing empty initial commit.

Toolchain used to run these checks (locally installed, matching the pinned
versions): Bun `1.4.0`, Biome `2.4.15`, TypeScript `7.0.2`, Fallow `3.19.0`.

## `profiles/durable/`

Commands, run with an absolute `cd` in `profiles/durable/` inside this
worktree (real git repo, branch `feat/durable-profile`, base branch `main` at
the shared empty root commit `a1f4dc5`):

```sh
bun install
bun run check
```

Result: `bun install` — 12 packages installed, exit 0. `bun run check` — exit
0:

- `biome:check`: `Checked 7 files in 11ms. No fixes applied.`
- `typecheck`: `tsc --noEmit -p tsconfig.json` — no output, exit 0.
- `test`: `bun test` — `1 pass, 0 fail, 1 expect() calls`.
- `quality:fallow`: `fallow audit --format json --quiet --type-aware
  --type-aware-require best-effort` — `"verdict":"pass"`,
  `"changed_files_count":11`, `"base_ref":"main"`,
  `dead_code_issues: 0`, `complexity_findings: 0`, `duplication_clone_groups: 0`,
  type-aware `"completeness":"complete"`.

A second, isolated check copied `profiles/durable/` to a fresh temp directory
(no git repo) and ran `bun install` + `biome check` + `tsc --noEmit` +
`bun test` directly: same pass results (biome 7 files clean, typecheck silent,
1 test pass). `quality:fallow` cannot run there because Fallow's `audit`
command requires a git repository to resolve a base ref regardless of
`--gate`; that check is proven against the real worktree git history above
instead, which is the actual environment a generated repository has (bootstrap
initializes git before a caller would run `bun run check`).

## `examples/monorepo/`

Same commands, run with an absolute `cd` in `examples/monorepo/` inside this
worktree:

```sh
bun install
bun run check
```

Result: `bun install` — 12 packages installed, exit 0. `bun run check` — exit
0:

- `biome:check`: `Checked 8 files in 13ms. No fixes applied.`
- `typecheck`: `bun run --filter '*' typecheck` — `@example/example-lib
  typecheck: Exited with code 0`.
- `test`: `bun run --filter '*' test` — `@example/example-lib test: 1 pass, 0
  fail` — `Exited with code 0`.
- `quality:fallow`: `"verdict":"pass"`.

The monorepo example is independent of the durable profile's own check run:
each has its own `package.json`, `tsconfig.base.json`, `biome.jsonc`,
`.fallowrc.json`, `node_modules`, and lockfile; neither install touches the
other's tree.

## Strictness

Neither `profiles/durable/tsconfig.base.json` nor
`examples/monorepo/tsconfig.base.json` nor any per-package `tsconfig.json`
under either tree relaxes `strict`, `verbatimModuleSyntax`,
`exactOptionalPropertyTypes`, or `noUncheckedIndexedAccess`. All four are
`true` at the base and inherited as-is everywhere.

## Source-packet / token contract

`README.md` in both `profiles/durable/` and `examples/monorepo/` carries the
literal token `{{SOURCE_PACKET}}` under a "Source packet" heading.
`profiles/durable/TEMPLATE-SOURCE.md` records the contract: a bootstrap
command of the shape `bun run bootstrap --profile durable --destination PATH
--source-packet PATH_OR_URL` replaces `{{SOURCE_PACKET}}` in the copied
`README.md` with the exact `--source-packet` value; bootstrap must fail
rather than ship the literal token unfilled. `TEMPLATE-SOURCE.md` is
contributor-facing template-source documentation, distinct from `README.md`
(the file a generated repository's own users see), matching the naming and
structure already established by the sibling `profiles/scratch/` lane
(commit `6eba391` on `feat/scratch-profile`, visible via this shared
repository's object store) so the eventual bootstrap tool can rely on one
consistent `TEMPLATE-SOURCE.md` convention across profiles.

## CI

Neither `profiles/durable/` nor `examples/monorepo/` ships a CI workflow.
Both READMEs and `TEMPLATE-SOURCE.md` state CI is a deliberate, separate
decision — not automatic because a repository is durable or was promoted from
scratch.

## Local generated artifacts (not committed)

`bun install` in both directories produced `node_modules/` and `bun.lock`.
Both are excluded by each directory's own `.gitignore` and confirmed absent
from `git status --short` (only `?? examples/` and `?? profiles/` appear,
before staging). A generated repository is expected to run its own
`bun install` and get its own fresh lockfile rather than inherit the
template's.
