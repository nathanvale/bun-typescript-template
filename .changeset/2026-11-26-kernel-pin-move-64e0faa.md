---
"bun-typescript-template": minor
---

Moved the template's kernel Pin from 7a3c430 to 64e0faa (agent-cli-kernel main). Generated commands gain `--discover-all` (PR 136), `--version` and `-h` (PR 141), and accept `--name=value`, with the unknown-option message naming the option (PR 138). `availablePaths` is now `[]` except on help, discovery and unknown-command (PR 137). `renamedFrom` is removed (PR 140). `readRootedFile` declines any path with a `..` segment as `parent-step` (PR 142). The contract version stays 3.0.0.

Action: Existing generated repositories move their own Pin separately with bun run pin-move 64e0faa68197d701c36444dc10335408684e6514 --repository <path>. In the same change, delete any `renamedFrom` declaration (it no longer compiles), handle `parent-step` in any exhaustive switch on `RootedRefusal.reason`, rename any option called `-h` or `--version`, and update verify-cli scenarios that pin `--discover` data or a full `availablePaths`.
