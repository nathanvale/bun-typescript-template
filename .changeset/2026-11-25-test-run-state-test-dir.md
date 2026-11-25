---
"bun-typescript-template": patch
---

`scripts/test-run.ts` now creates the test run folder inside `STATE_TEST_DIR` when it is set and non-empty, points `STATE_TEST_DIR`, `TMPDIR`, `TMP`, and `TEMP` in `bun test` at the test run folder, and includes `STATE_TEST_DIR` in the leftover scan so `testFolder()` calls never escape into `STATE_TEST_DIR` when a run finishes or is killed.

Action: Run Template upgrade to update `scripts/test-run.ts`.
