---
"bun-typescript-template": minor
---

A generated repository's eslint.config.mjs now keeps every lint rule the kernel's lint config gives it. The chained type assertion check moved from core no-restricted-syntax into the anti-slop rule anti-slop/no-chained-type-assertions, so it no longer replaces the kernel's no-restricted-syntax list in src/. kernelLint now names tests in testDirs, so tests/ gets the kernel's test refusals, and scripts/**/*.ts now gets the type-aware recommended rules with no-explicit-any, no-non-null-assertion and no-console.

After the next upgrade, lint refuses in src/: Object.assign on a value, a type predicate, a dynamic node:child_process or bun:ffi import and a computed import. In tests/: a type assertion with as, a type predicate, Object.assign and @ts-expect-error. In scripts/: any, a non-null assertion, console and an unawaited promise.

Action: measured at origin/main, agent-doorway (97f5145) has 0 new hits and agent-gates (8d6693c) has 3: two `JSON.parse(...) as T` in tests/rumdl-profiles.test.ts and the type predicate in tests/support/rumdl-drift.ts. Parse the value through a checked function instead of asserting it, and move a type predicate behind a parser that returns the narrowed value. scripts/check-gated-paths.ts now writes its refusal with process.stderr.write; the upgrade carries it, so its console hit clears with the same upgrade.
