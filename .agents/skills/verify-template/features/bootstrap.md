# Bootstrap

Bootstrap creates a generated repository with the kernel at the template's
Pin, records where it came from, and leaves a repository whose own check
command passes out of the box. It refuses a request it cannot honour safely
and leaves every existing byte in place.

## Sub-features

- `bootstrap-help` prints the one usage line, what the repository gets, and
  the safety line.
- `bootstrap-green` creates a repository whose `package.json` names the
  kernel at the template's Pin.
- `bootstrap-provenance` writes `.cli-design-template.json` and `AGENTS.md`
  naming the template commit and the source packet.
- `bootstrap-ready` lets the generated repository install, pass its check
  command and run its CLI.
- `bootstrap-refuse-destination` refuses a non-empty destination or one inside
  the template.
- `bootstrap-refuse-request` refuses a missing flag, a relative source packet,
  or an option it does not know, such as the retired `--profile`.
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
- `KERNEL_REPOSITORY` names a clone of the kernel repository that holds the
  template's pinned commit, exported before recording. The run's clone has no
  kernel repository beside it.

- **Help.** Record `bootstrap-help` in `template`:
  `bun run bootstrap --help`. Exit 0; stdout starts
  `Create a Bun TypeScript repository with the kernel at the template's Pin.`
  and ends with
  `An existing non-empty destination is refused and never overwritten.`
- **Green.** Record `bootstrap-green` in `template`:
  `bun run bootstrap --destination $run/work/generated/repository --source-packet $packet --json`.
  Exit 0; stdout is one JSON line with `"status":"created"`, the destination,
  the source packet and a `generatedFiles` count, and no `profile`, `starter`
  or `variant`. Then record `bootstrap-pin` in `generated/repository`:
  `grep agent-cli-kernel package.json`. It names
  `github:nathanvale/agent-cli-kernel#` and the commit in the template's
  `kernel-pin.json`.
- **Green, human line.** Record `bootstrap-human` in `template`:
  `bun run bootstrap --destination $run/work/generated/human --source-packet $packet`.
  Exit 0; stdout reads
  `Created a repository at <path>, with the kernel at the template's Pin`.
- **Provenance.** Record `bootstrap-provenance` in `generated/repository`:
  `cat .cli-design-template.json AGENTS.md`. `templateRevision` and
  `Template source:` equal the launched commit, `templateDirty` is `false`,
  `sourcePacket` equals `$packet`, and the file names no `profile` or
  `starter`.
- **Green, ready.** In `generated/repository`, record `bootstrap-base`:
  `git init -q -b main && git commit -q --allow-empty -m "chore: establish comparison base"`,
  then `bootstrap-install`: `bun install --frozen-lockfile`, then
  `bootstrap-check`: `bun run check`, then `bootstrap-smoke`:
  `bun run start --help`. Each exits 0; the check transcript shows `0 fail`
  and Fallow's JSON with `"total_issues":0`; the smoke prints
  `Usage: repository <command> [options]`.
- **Red, destination.** Record `bootstrap-refuse-not-empty`: rerun the green
  command unchanged. Exit 3; stderr holds
  `{"schemaVersion":1,"status":"refused","error":{"code":"destination_not_empty","message":"destination already contains files","repair":"choose a new or empty directory; existing bytes were preserved","retrySafe":true}}`.
  Record `bootstrap-refuse-inside` with `--destination ./inside`. Exit 3;
  stderr reads `destination must be outside the template repository` then
  `Repair: choose a fresh destination outside this checkout`. Then record
  `git status --porcelain` in `template`: empty.
- **Red, request.** Record each, in `template`:
  - `bootstrap-refuse-missing`: `bun run bootstrap --destination $run/work/generated/missing`.
    Exit 2; `--destination and --source-packet are required` then
    `Repair: run bun run bootstrap --help`.
  - `bootstrap-refuse-packet`: `--source-packet relative/packet`. Exit 2;
    `source packet must be an absolute path or HTTP(S) URL` then
    `Repair: pass --source-packet an absolute path or an HTTP(S) URL`.
  - `bootstrap-refuse-retired`: `--profile durable` with the other flags and
    `--json`. Exit 2; error code `unknown_argument`, message
    `unknown argument: --profile`, repair `run bun run bootstrap --help`.
  - After all three, `ls -A $run/work/generated` lists only the green folders.
- **Red, archive.** Record `bootstrap-archive-copy` in `template`:
  `mkdir ../archive && git archive HEAD | tar -x -C ../archive`, then
  `bootstrap-refuse-archive` in `archive`:
  `bun run bootstrap --destination $run/work/generated/from-archive --source-packet $packet --json`.
  Exit 1; error code `template_revision_unavailable`, repair
  `rerun from a git clone of the template`; no `from-archive` folder.
- **Planted fault.** Record `bootstrap-fault` in `template`:
  `bun run --silent fault-replay 76c8d28-recipe-pin`. Exit 0 and
  `KILLED 76c8d28-recipe-pin`: the type check refuses a recipe row without
  the Pin.

## Gotchas

- `bun run bootstrap` with no flags prints the help and exits 0. It is not a
  refusal.
- Bun prints `error: script "bootstrap" exited with code N` after a refusal
  that exits 1 or 3, not after one that exits 2. Read the exit code, not that
  line.
- Bootstrap reads the template commit with git, so a GitHub zip download or a
  `git archive` copy is refused. Always launch from a clone.
- Without `KERNEL_REPOSITORY`, Bootstrap looks for the kernel repository
  beside the template. From an archive copy it then refuses first with
  `template_git_unreadable`, because git cannot say where the copy keeps its
  objects.
- `bun install --frozen-lockfile` in a generated repository fetches the kernel
  from GitHub at the pinned commit, so it needs the network.
- When `node` resolves to Bun's fallback (as in the `oven/bun` image),
  `quality:fallow` prints
  `fallow-type-aware: Cannot find package 'typescript' imported from .../node_modules/fallow-type-aware/src/backend.mjs`
  and the check exits 2 after the tests pass.
- The generated CLI names itself after `--name`, or the destination folder
  when `--name` is not given.
