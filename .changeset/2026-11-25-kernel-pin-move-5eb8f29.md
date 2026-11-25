---
"bun-typescript-template": minor
---

Moved the template's kernel Pin from 44a7596 to 87d23cf (agent-cli-kernel main), bringing in: the kernel's size check skips the root `CHANGELOG.md` (PR 123), the source lint admits Bun's pure parsers and names a runtime member missing from the allowlist (PR 122), and the inline-switch lint admits only Fallow's own targets and fails closed when Biome's schema cannot be read (PR 120).

Action: Existing generated repositories move their own Pin separately with bun run pin-move 87d23cf123007f942f6169c3d60fdc45c1b1c3f8 --repository <path>. Newly bootstrapped repositories receive 87d23cf automatically.
