---
"bun-typescript-template": minor
---

Generated repositories now run tests through the test run, `scripts/test-run.ts`: `bun run test` points `TMPDIR` at one test run folder for `bun test` and every child process, by every spawn route, stops `bun test`'s process group when the run ends, is killed, or times out, and removes the folder at the end. The test run also names any entry the tests left in the system temp folder: a failure under `CI=true`, a warning elsewhere. The preload `tests/support/test-run-folder.ts` (wired in `bunfig.toml`) removes the folder and stops `bun test`'s process group if the test run itself is killed; plain `bun test` still runs with one warning line, and under `CI=true` a package script that runs plain `bun test` is refused.

Action: Run Template upgrade. It changes the `test` script to `bun scripts/test-run.ts` and adds the preload to `bunfig.toml`; no command you type changes. After it, `bun run check` refuses a `bunfig.toml` that drops the preload, and under `CI=true` refuses a fixed path in the system temp folder or a `test` script that drops the test run. Give each child process your tests start an environment built from `process.env` so its temporary files land inside the test run folder.
