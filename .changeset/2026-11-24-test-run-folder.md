---
"bun-typescript-template": minor
---

Generated repositories now run tests through the test run, `scripts/test-run.ts`: `bun run test` points `TMPDIR` at one test run folder for `bun test` and every child process, by every spawn route, and removes the folder when the run ends. The preload `tests/support/test-run-folder.ts` (wired in `bunfig.toml`) stops any child a test file leaves running at teardown and fails the run naming it. The test run also names any entry the tests left in the system temp folder: a failure under `CI=true`, a warning elsewhere. A plain `bun test` still runs, with one warning line; under `CI=true` a package script that runs plain `bun test` is refused.

Action: Run Template upgrade. It changes the `test` script to `bun scripts/test-run.ts` and adds the preload to `bunfig.toml`; no command you type changes. After it, `bun run check` refuses a test that leaves a child process running, refuses a `bunfig.toml` that drops the preload, and under `CI=true` refuses a fixed path in the system temp folder or a `test` script that drops the test run. Stop each child your tests start before they end, and give each child an environment built from `process.env`.
