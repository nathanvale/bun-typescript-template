---
"bun-typescript-template": patch
---

Updated generated `.changeset/README.md` release steps to check pending non-empty changesets before running `changeset version`, treat any non-zero exit as a failure, and use `agent-gates changelog backfill`.
