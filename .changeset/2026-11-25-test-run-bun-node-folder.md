---
"bun-typescript-template": patch
---

The test run's leftover check ignores Bun's own `bun-node-<uid>-<build>` folder, which Bun 1.4.4 makes in `/tmp` whenever something runs `node` under Bun, whatever `TMPDIR` or `BUN_TMPDIR` says. A fresh hosted runner no longer fails `bun run check` on it. Generated repositories get it on their next upgrade.
