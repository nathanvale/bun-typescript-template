---
"bun-typescript-template": minor
---

Moved the template's kernel Pin from 44a7596 to 5eb8f29 (agent-cli-kernel main), bringing in: the kernel's size check skips the root `CHANGELOG.md` (PR 123); the source lint admits Bun's pure parsers and names a runtime member missing from the allowlist (PR 122); the inline-switch lint admits only Fallow's own targets and fails closed when Biome's schema cannot be read (PR 120); scripts read rooted files through `readRootedFile`, with a lint that refuses other routes (PR 121); and a refused result can carry data (`carriesData`, PR 125; the CLI contract stays 3.0.0).

Action: Existing generated repositories move their own Pin separately with bun run pin-move 5eb8f295f0b97a98f23d3bfa2b3d1a4f9059374c --repository <path>, run from a starter kit checkout. Newly bootstrapped repositories receive 5eb8f29 automatically.
