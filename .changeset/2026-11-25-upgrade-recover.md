---
"bun-typescript-template": minor
---

Added `bun run upgrade recover --repository PATH [--to REF] [--json]` to clear a failed Template upgrade worktree without forced removal: it commits the worktree's edits by path onto `template-upgrade/<target7>-failed-<n>`, writes the same diff to `.worktrees/template-upgrade-<target7>-failed-<n>.patch`, unlocks the worktree, removes it with plain `git worktree remove`, and repoints Template upgrade repair lines and documentation to `upgrade recover`.
