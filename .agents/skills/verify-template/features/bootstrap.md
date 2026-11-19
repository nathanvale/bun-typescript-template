# Bootstrap

Bootstrap creates a generated repository from one explicit profile, records
where it came from, and leaves a repository whose own check command passes
out of the box. It refuses a request it cannot honour safely and leaves every
existing byte in place.

## Sub-features

- `bootstrap-help` prints the usage, profiles and safety line.
- `bootstrap-durable` creates a durable single-package repository.
- `bootstrap-scratch` creates a scratch repository.
- `bootstrap-monorepo` creates the durable monorepo example.
- `bootstrap-provenance` writes `.cli-design-template.json` and `AGENTS.md`
  naming the template commit and the source packet.
- `bootstrap-ready` lets the generated repository install, pass its check
  command and run its CLI.
- `bootstrap-refuse-destination` refuses a non-empty destination or one inside
  the template.
- `bootstrap-refuse-request` refuses a missing flag, an unknown profile, a
  relative source packet, or a profile and layout that do not combine.
- `bootstrap-refuse-archive` refuses to run from a copy with no git history.

## How to get to it (user POV)

- Run `bun run bootstrap <flags>` from a git clone of the template, as the
  template README shows.
- Add `--json` for one machine-readable line on stdout (success) or stderr
  (refusal).

## Driving it with session.sh

Preconditions:

- A launched run; `doctor` passes.
- `$run/work/generated/` holds no folder named in these recipes.
- Before running the checks for either durable layout, follow its Node.js
  setup instructions in the
  [single-package README](../../../../profiles/durable/README.md#bootstrap) or
  [monorepo README](../../../../examples/monorepo/README.md#bootstrap).

- **Help.** Record `bootstrap-help` in `template`:
  `bun run bootstrap --help`. Exit 0; stdout starts
  `Create a Bun TypeScript repository from an explicit profile.` and ends with
  `An existing non-empty destination is refused and never overwritten.`
- **Green, durable.** Record `bootstrap-durable` in `template`:
  `bun run bootstrap --profile durable --destination $run/work/generated/durable --source-packet $packet --json`.
  Exit 0; stdout is one JSON line with `"status":"created"`,
  `"profile":"durable"`, `"variant":"single-package"` and a `generatedFiles`
  count.
- **Green, scratch and monorepo.** Record `bootstrap-scratch` in `template`:
  `bun run bootstrap --profile scratch --destination $run/work/generated/scratch --source-packet $packet`,
  and `bootstrap-monorepo` in `template`:
  `bun run bootstrap --profile durable --monorepo --destination $run/work/generated/monorepo --source-packet $packet`.
  Exit 0; stdout reads `Created scratch single-package repository at <path>`
  and `Created durable monorepo repository at <path>`.
- **Provenance.** Record `bootstrap-provenance` in `generated/durable`:
  `cat .cli-design-template.json AGENTS.md`. `templateRevision` and
  `Template source:` equal the launched commit, `templateDirty` is `false`,
  and `sourcePacket` equals `$packet`.
- **Green, ready.** In `generated/durable`, record `bootstrap-base`:
  `git init -q -b main && git commit -q --allow-empty -m "chore: establish comparison base"`,
  then `bootstrap-install`: `bun install --frozen-lockfile`, then
  `bootstrap-check`: `bun run check`, then `bootstrap-smoke`:
  `bun run start --help`. Each exits 0; the check transcript shows `0 fail`
  and Fallow's `"verdict":"pass"`; the smoke prints `Usage: example COMMAND [--json]`.
  Repeat for `generated/scratch` and `generated/monorepo` with the check
  command each generated `AGENTS.md` names, adding `-scratch` or `-monorepo`
  to each name, such as `bootstrap-check-scratch`, so no transcript is
  overwritten.
- **Red, destination.** Record `bootstrap-refuse-not-empty`: rerun the durable
  command unchanged. Exit 3; stderr holds
  `{"schemaVersion":1,"status":"refused","error":{"code":"destination_not_empty","message":"destination already contains files","repair":"choose a new or empty directory; existing bytes were preserved","retrySafe":true}}`.
  Record `bootstrap-refuse-inside` with `--destination ./inside`. Exit 3;
  stderr reads `destination must be outside the template repository` then
  `Repair: choose a fresh destination outside this checkout`. Then record
  `git status --porcelain` in `template`: empty.
- **Red, request.** Record each, in `template`:
  - `bootstrap-refuse-missing`: `bun run bootstrap --profile durable`. Exit 2;
    `--profile, --destination, and --source-packet are required` then
    `Repair: run bun run bootstrap --help`.
  - `bootstrap-refuse-profile`: `--profile big` with the other flags and
    `--json`. Exit 2; error code `invalid_profile`, repair
    `choose --profile scratch or --profile durable`.
  - `bootstrap-refuse-packet`: `--source-packet relative/packet`. Exit 2;
    `source packet must be an absolute path or HTTP(S) URL` then
    `Repair: pass --source-packet an absolute path or an HTTP(S) URL`.
  - `bootstrap-refuse-mismatch`: `--profile scratch --monorepo`. Exit 2;
    `--monorepo is available only with --profile durable` then
    `Repair: remove --monorepo or choose --profile durable`.
  - After all four, `ls -A $run/work/generated` lists only the green folders.
- **Red, archive.** Record `bootstrap-archive-copy` in `template`:
  `mkdir ../archive && git archive HEAD | tar -x -C ../archive`, then
  `bootstrap-refuse-archive` in `archive`:
  `bun run bootstrap --profile durable --destination $run/work/generated/from-archive --source-packet $packet --json`.
  Exit 1; error code `template_revision_unavailable`, repair
  `rerun from a git clone of the template`; no `from-archive` folder.
- **Planted fault.** Record `bootstrap-fault` in `template`:
  `bun run --silent fault-replay 4afda36-project-recipe`. Exit 0 and
  `KILLED 4afda36-project-recipe`: the recipe table throws, naming the
  selection, when no recipe and no refusal match.

## Gotchas

- `bun run bootstrap` with no flags prints the help and exits 0. It is not a
  refusal.
- Bun prints `error: script "bootstrap" exited with code N` after a refusal
  that exits 1 or 3, not after one that exits 2. Read the exit code, not that
  line.
- Bootstrap reads the template commit with git, so a GitHub zip download or a
  `git archive` copy is refused. Always launch from a clone.
- A generated repository needs a first commit before `bun run check`: Fallow's
  audit compares against it. Its README gives the commands.
- When `node` resolves to Bun's fallback (as in the `oven/bun` image),
  `quality:fallow` prints
  `fallow-type-aware: Cannot find package 'typescript' imported from .../node_modules/fallow-type-aware/src/backend.mjs`
  and the check exits 2 after the tests pass.
- The generated CLI calls itself `example` in its usage line, whatever
  `--name` or destination was given.
- The `--starter` flags copy from `starters/`, which [MAG-129] removes. This map
  leaves them out until that settles.

[MAG-129]: https://linear.app/myagentdojo/issue/MAG-129
