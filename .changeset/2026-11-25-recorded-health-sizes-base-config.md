---
"bun-typescript-template": patch
---

Changed `scripts/check-recorded-health-sizes.ts` in generated repositories to measure both the base commit and `HEAD` with the base commit's Fallow settings file (`.fallowrc.json`, `.fallowrc.jsonc`, `fallow.toml` or `.fallow.toml`, or an empty one when the base has none), and with no `.gitignore`, `.ignore` or inline `fallow-ignore` marker in either measured copy. The measuring moved into a second module, `scripts/fallow-health-at-base-settings.ts`, which Bootstrap and the Template upgrade copy with the script.

A change to Fallow thresholds, `thresholdOverrides`, rule severities, `health.ignore`, `ignorePatterns`, `production` or `entry`, the settings file's name, an ignore file or an inline `fallow-ignore` comment in the same diff can no longer hide unapproved growth in a recorded health finding. A settings change with no growth, and a real shrink below the base commit's limit, still pass.

Action: Existing generated repositories receive both scripts on their next Template upgrade. Land a Fallow settings relaxation in its own pull request before growing a recorded health finding under it.
