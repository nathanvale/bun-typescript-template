---
"bun-typescript-template": minor
---

Moved the starter kit's Pin commands behind its front door: bun run pin:verify, pin:plan and pin:move replace pin-verification and pin-move. pin move now writes both Pin places (kernel-pin.json and the starter kit's agent-cli-kernel dependency) and runs inside the kernel's state transaction; refusals return DOMAIN_PIN_* causes. Generated repositories need nothing.
