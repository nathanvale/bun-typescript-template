# Check command

A generated repository's check command, `bun run check`, runs lint,
format check, typecheck, tests and Fallow in that order, stops at the first
step that fails, and names the mistake. It is the only gate a generated
repository ships: it has no git hooks and no hosted check.

## Sub-features

- `check-green` passes on a fresh generated repository.
- `check-lint` refuses a lint error, including the template's
  `repository/no-comments` rule.
- `check-format` refuses a file Biome would reformat, without rewriting it.
- `check-type` refuses a type error.
- `check-test` refuses a failing test.
- `check-fallow` refuses an unused export.
- `check-unguarded` shows that `git commit` alone refuses nothing.

## How to get to it (user POV)

- Run `bun run check` in the generated repository, as its `AGENTS.md` names.
- Run one step alone: `bun run lint`, `format:check`, `typecheck`, `test` or
  `quality:fallow`.

## Driving it with session.sh

Preconditions:

- [Bootstrap](bootstrap.md)'s green and ready bullets have run, so
  `generated/repository` has a first commit, an install and a passing check.
- Commit the scaffold so each red can restore one file. Record
  `check-commit` in `generated/repository`:
  `git add -- $(git ls-files --others --exclude-standard) && git commit -q -m "feat: generated scaffold"`.
  `git status --porcelain` is then empty.

Each red plants one mistake, runs the check, restores the file and keeps the
check's exit code:
`<plant>; bun run check; status=$?; git checkout -- <file>; exit $status`.

- **Green.** Record `check-green`: `bun run check`. Exit 0; stderr lists the
  five steps from `$ eslint . --max-warnings 0` to `$ bun test`; stdout ends
  with Fallow's JSON, `"verdict":"pass"`.
- **Red, lint.** Record `check-red-lint`. Plant: append the line
  `// Loop over the names.` to `src/commands.ts`. Exit 1; stdout holds
  `repository/no-comments` and `✖ 1 problem (1 error, 0 warnings)`; stderr
  ends `error: script "check" exited with code 1`.
- **Red, format.** Record `check-red-format`. Plant: append the line
  `export const spaced   =   1;` to `src/commands.ts`. Its command hashes
  the file around the check:
  `<plant>; before=$(shasum src/commands.ts); bun run check; status=$?; [ "$(shasum src/commands.ts)" = "$before" ] && echo "check left src/commands.ts unchanged"; git checkout -- src/commands.ts; exit $status`.
  Exit 1; stderr holds `Formatter would have printed the following content:`
  and `error: script "format:check" exited with code 1`; stdout holds
  `check left src/commands.ts unchanged`.
- **Red, type.** Record `check-red-type`. Plant: append the line
  `export const wrong: string = 42;` to `src/commands.ts`. Exit 2; stdout
  holds `error TS2322: Type 'number' is not assignable to type 'string'.`
- **Red, test.** Record `check-red-test`. Plant: in `src/commands.ts` replace
  `ready: true` with `ready: false`. Exit 1; stderr holds
  `(fail) status reports that the command-line tool runs, from any folder`.
- **Red, Fallow.** Record `check-red-fallow`. Plant: append the line
  `export const unused = 1;` to `src/commands.ts`. Exit 1; stdout's JSON has
  `"total_issues":1` and an `unused_exports` entry for `unused`.
- **Unguarded commit.** Record `check-unguarded`: plant the type error, then
  `git commit -q -am "feat: break status" && git log --oneline -1`. Exit 0: the
  commit lands. Restore with
  `git revert --no-edit HEAD` and confirm `bun run check` passes again.
- **After.** Record `check-after`: `git status --porcelain && git log --oneline`.
  Clean, with only the commits this recipe made.

## Gotchas

- The check stops at the first failing step, so plant one mistake per run. A
  second mistake hides behind the first.
- Bootstrap copies the generated repository's own tests, so `bun test` runs
  13 tests across 3 files.
- Fallow needs a real Node.js on `PATH`; see [Bootstrap](bootstrap.md#gotchas).
- No fault record patches a step of the generated repository's `check`
  script. `tests/template/bootstrap/bootstrap-generated-repository.test.ts`
  runs lint, format and type reds against a generated repository, but fault
  replay never proves those tests catch a step dropped from `check`. Run this
  recipe's reds after changing `generated-repository/settings/package.json`.
