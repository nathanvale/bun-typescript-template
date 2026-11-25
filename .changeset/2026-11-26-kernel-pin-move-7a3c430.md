---
"bun-typescript-template": minor
---

Moved the template's kernel Pin from 5eb8f29 to 7a3c430 (agent-cli-kernel main), bringing in two new kernel exports, `agent-cli-kernel/rooted-file` (PR 126) and `agent-cli-kernel/xdg-base` (PR 131); `renamedFrom`, which keeps a renamed command's old routes working (PR 135); the state rule refusing `process.mainModule` (PR 132); stricter planted-fault verdicts that count a fault as caught only for the right reason, replayed in one temp copy with its own `.git` (PRs 128, 129, 130); lock probes that pass behind symbolic links (PR 133); the decision record that look-only work is its own inspect route (PR 134); and fake-timer state tests (PR 127).

Action: Existing generated repositories move their own Pin separately with bun run pin-move 7a3c430369a7adf3c91b28fe9bcde3aad342298e --repository <path>. Newly bootstrapped repositories receive 7a3c430 automatically.
