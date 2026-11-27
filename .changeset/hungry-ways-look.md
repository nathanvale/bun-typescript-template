---
"bun-typescript-template": minor
---

Generated repositories may now set templateUpgrade.checkTimeoutSeconds in package.json to configure how long template upgrades wait for check steps; without it the limit is 900 seconds instead of 240, and nothing needs changing to keep working.
