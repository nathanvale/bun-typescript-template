---
"bun-typescript-template": patch
---

Drop advisory refactoring-target `target_keys` additions in `fallow-health-recorded-hits.json` during `upgrade apply` instead of stopping with `recorded_hits_would_grow`, keeping `target_keys` at the base state while still refusing any growth in recorded health findings that `bun run check` needs.
