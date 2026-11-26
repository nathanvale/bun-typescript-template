---
"bun-typescript-template": patch
---

Measure growth in `fallow-duplicates-recorded-hits.json` during `upgrade apply` by `normalized_clone_fingerprints` alone when the base and the re-recorded file both carry it, so a recorded clone that a refactor moved to new lines or another file no longer stops the upgrade with `recorded_hits_would_grow`. Fallow matches a recorded clone by that fingerprint, so its `clone_groups` label and raw `clone_fingerprints` only describe where it is. A new normalized fingerprint, or a rise in its count, is still refused; a file without `normalized_clone_fingerprints` on either side is measured as before.
