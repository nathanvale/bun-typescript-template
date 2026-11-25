---
"bun-typescript-template": patch
---

Hardens the test run (`scripts/test-run.ts`, `tests/support/test-run-folder.ts`, `tests/support/test-folder.ts`, and `scripts/kernel-trial.ts`):

- Process markers (`.test-run-process`) require a live exclusive lock held by the running test runner, so forged markers naming PID 1 or a parent shell no longer exempt leaks.
- `testFolder` anchors to `TEST_RUN_FOLDER` inside a test run so changing `STATE_TEST_DIR` mid-run cannot escape the run folder.
- `runTests` cleans up its run folder when marker creation or `Bun.spawn` throws after `mkdtempSync`.
- Concurrent runners write locked markers atomically and tolerate the brief startup window before a new run folder's marker appears.
- The preload guard also removes the run folder on `afterAll` and process exit when the runner is already gone.
- Nested `kernel-trial` test runs isolate their temp environment from outer system temp folders under `CI=true`.
