---
"bun-typescript-template": minor
---

Added `scripts/build-bundles.ts` to generated repositories, one bundle builder in place of each repository's own copy. A repository lists its bundles in a new `package.json` key, `bundles`, an object from output path to entry `.ts` file, both relative to the repository root, for example `{ "skills/engineering/hello-world/dist/cli.mjs": "skills/engineering/hello-world/src/main.ts" }`.

New `package.json` scripts:

- `build:bundles` builds each listed entry with `Bun.build` (`target: "bun"`, `format: "esm"`, minified, no source map) and writes it to its output path. Line 2 of each bundle, after Bun's `// @bun` pragma, reads `// bundle: agent-cli-kernel@<40-character commit> bun@<Bun version>`.
- `check:bundles` builds each bundle in memory and compares its bytes with the committed file. `bun run check` now runs it first.
- `regenerate` runs `build:bundles`, so a pin move rebuilds the bundles and commits them with the Pin change.

Refusals, each with a `Repair:` line: `bundle_stale` names each bundle that differs from a fresh build or is missing; `bundle_kernel_mismatch` when `bun.lock` does not resolve the kernel commit `package.json` pins; `bundle_entry_missing` names each listed entry that does not exist. A repository without the `bundles` key has no bundles, and both scripts exit 0 having done nothing.

Action: A repository with its own `scripts/build-skill-clis.ts` (skills, skills-private) moves its bundle list into `package.json` `bundles`, turns any generated entry into a real `.ts` entry file, deletes its own builder and its `build:skills` and `check:skills` scripts, and runs `bun run build:bundles` once to stamp its committed bundles. Other repositories need nothing.
