---
"bun-typescript-template": patch
---

The test run's leftover check names only new entries owned by the user the tests run as, so a folder another user's process makes in the system temp folder during the run (a hosted runner's system service, for example `systemd-private-...`) no longer fails `bun run check`. Generated repositories get it on their next upgrade.
