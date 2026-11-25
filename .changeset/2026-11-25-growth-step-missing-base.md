---
"bun-typescript-template": patch
---

Changed the generated hosted check step `Check Fallow recorded hits did not grow` in `.github/workflows/ci.yml` to pass `github.event_name` through `EVENT_NAME` and fail with a `::error::` annotation and exit code 1 on `pull_request` events when `BASE` is empty or not a commit in the checkout. On `push` events with no earlier commit to compare (empty `BASE`, forty zeros, or a commit missing from the checkout), the step emits a `::notice::` annotation and exits 0.

Generated repositories receive the stricter hosted growth step on their next Template upgrade.
