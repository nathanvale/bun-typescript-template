# check:commits

`bun run check:commits <base> [head]` checks every commit in `base..head`
(after the fixed point in `repository.json`) in its own worktree with its own
install, typecheck and lint. It prints a verdict per commit and refuses the
branch when any commit is red at its own head. The hosted `commits` job runs it on
every pull request.

## Sub-features

- `commits-green` prints `GREEN <short sha> <subject>` per commit and exits 0.
- `commits-red` prints `RED`, the failed step, a repair and a rerun command,
  and exits 1.
- `commits-empty` refuses a range with no commits.
- `commits-usage` refuses a call with no base.
- `commits-doctor` refuses to start when the doctor fails (see
  [Doctor](doctor.md)).

## How to get to it (user POV)

- Run `bun run check:commits origin/main` in a template clone before opening
  a pull request.
- Paste the `Rerun locally:` line a red verdict prints.

## Driving it with session.sh

Preconditions:

- A launched run; `doctor` passes; `git status --porcelain` in `template` is
  empty.

- **Green.** Commit one good change, such as the commit hook's green, then
  record `commits-green` in `template`: `bun run --silent check:commits HEAD~1`.
  Exit 0; stdout ends `GREEN <sha> <subject>` and
  `Checked 1 commits: all green in <s> s, <s> s per commit.`
- **Red.** Record `commits-history` in `template`. Build two commit objects
  to represent imported history with a type error in the first commit.

  ```sh
  set -eu
  path=src/recipe.ts
  sed 's/checkCommand: "bun run check[^"]*",/checkCommand: 1,/' "$path" > "$run/work/recipe-with-type-error"
  cp "$run/work/recipe-with-type-error" "$path"
  git add -- "$path"
  broken_tree=$(git write-tree)
  git restore --source=HEAD --staged --worktree -- "$path"
  clean_tree=$(git rev-parse 'HEAD^{tree}')
  test "$broken_tree" != "$clean_tree"
  broken=$(git commit-tree "$broken_tree" -p HEAD -m "refactor(recipe): stage a broken line")
  git commit-tree "$clean_tree" -p "$broken" -m "fix(recipe): restore the check command" > "$run/work/check-commits-tip"
  ```

  Exit 0. Then record `commits-red`:
  `bun run --silent check:commits HEAD "$(cat "$run/work/check-commits-tip")"`.
  Exit 1; stdout holds
  `RED <sha> refactor(recipe): stage a broken line`,
  `Failed: bun run typecheck`,
  `Repair: change <sha> itself so that bun run typecheck passes at that commit.`,
  `Rerun locally: CHECK_COMMITS_SINCE='<fixed point>' bun run check:commits '<sha>^@' <sha>`,
  `error TS2322: Type 'number' is not assignable to type 'string'.` for `src/recipe.ts`,
  `GREEN <sha> fix(recipe): restore the check command` and
  `1 of 2 commits are red in <s> s, <s> s per commit.`
- **Red, empty.** Record `commits-red-empty`:
  `bun run --silent check:commits HEAD`. Exit 1; stdout ends
  `No commits in HEAD..HEAD to check, so this gate checks nothing. Repair: name a base that HEAD is ahead of.`
- **Red, usage.** Record `commits-red-usage`: `bun run --silent check:commits`.
  Exit 2; stderr `Usage: bun run check:commits <base> [head]`.
- **Planted fault.** Record `commits-fault`:
  `bun run --silent fault-replay 8d55f96-check-commits`. Exit 0 and
  `KILLED 8d55f96-check-commits`.
- **After.** Record `commits-after`: `git status --porcelain` and
  `git -C . worktree list`. Clean, and only the clone itself is listed.

## Gotchas

- Each commit costs a full install, typecheck and lint: about 10 s on a Mac.
  Keep the range to the commits the recipe made.
- `--help` is read as the base and fails inside `git rev-list`, which prints
  git's own usage and exits 2.
- Commits at or before `checkCommitsSince` in `repository.json` are never
  checked. A base older than it checks fewer commits than `base..head` holds.
