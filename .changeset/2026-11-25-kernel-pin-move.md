---
"bun-typescript-template": minor
---

Moved the template's kernel Pin from a006774 to 44a7596 (agent-cli-kernel main), bringing in the kernel's installer-facing lint fixes: the state add-on can no longer reach the filesystem through the Bun global (PR 108), the shipped source lint admits only listed runtime members and imports (PR 109), type-only `child_process` and `module` imports pass (PR 116), the state rule reads a named default as the whole module (PR 115), and inline lint switches are refused (PR 117, new `config/comment-directives.mjs`).

Action: Existing generated repositories move their own Pin separately with bun run pin-move 44a7596f4d8c35f05f8b9b4e10c36fa0cd3a3285 --repository <path>. Newly bootstrapped repositories receive 44a7596 automatically.
