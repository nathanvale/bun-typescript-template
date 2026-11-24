---
"bun-typescript-template": minor
---

Added `scripts/check-recorded-health-sizes.ts` (and `"check:recorded-health-sizes"` in `package.json`) to generated repositories and called it from the hosted check step `Check Fallow recorded hits did not grow` after `quality:fallow -- --fail-on-baseline-growth --baseline-base "$BASE"`.

The script measures each recorded health finding in `fallow-health-recorded-hits.json` at the base commit and at `HEAD` using Fallow's own JSON output (`file lines` for `<file>`, and `function lines`, `cyclomatic complexity`, and `cognitive complexity` for functions). It refuses any unapproved rise in a recorded finding's size and refuses any new file-and-rule pair or higher count in `eslint-suppressions.json`. Shrinking, leaving sizes unchanged, removing a finding, or adding a new `approved` field to the entry in the same reviewed change passes. Unreadable base files and malformed lists fail closed with exit code 2.

Action: After the next Template upgrade, the hosted check refuses pull requests or pushes that grow any recorded health finding's size or `eslint-suppressions.json` without a new `approved` field. Measured on `agent-doorway` from its landing commit `885ac6e` to `origin/main` (`97f5145`), 3 recorded hits grew: `src/open.ts` (`<file>`, file lines 767 to 853), `src/open.ts` function `run` (function lines 313 to 338), and `tests/open.test.ts` (`<file>`, file lines 1,889 to 2,511). On any branch that grows a recorded hit, shrink the file, function, or suppression back to or below the base size, or make a reviewed change that gives the entry a new `"approved"` field naming the ticket or pull request and its reason.
