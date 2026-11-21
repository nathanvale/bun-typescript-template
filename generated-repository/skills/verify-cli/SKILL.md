---

name: verify-cli
description: Prove that a CLI built on agent-cli-kernel really works, the way a user meets it. Use when asked to verify, smoke-test or prove a command of a repository that installs agent-cli-kernel, before claiming a CLI change is done, or when its tests pass but nobody has run the real CLI.
---

# Verifying a CLI built on agent-cli-kernel

This is a pointer skill. The full skill ships inside the installed kernel.
Read the full skill in node_modules before you verify anything:
`node_modules/agent-cli-kernel/skills/verify-cli/SKILL.md`.

Run each command below from the repository root through the helper:
`bun node_modules/agent-cli-kernel/skills/verify-cli/verify.ts <command>`.
This repository's CLI, the target, is `src/cli.ts`.

| Task                                       | Command                              |
| ------------------------------------------ | ------------------------------------ |
| Check the CLI is ready before driving it   | `ready src/cli.ts`                   |
| Run every check its discovery implies      | `sweep src/cli.ts`                   |
| List each failed check of the sweep        | `findings src/cli.ts`                |
| Make a run folder bound to the CLI         | `launch <run folder> src/cli.ts`     |
| Drive one scenario and keep its evidence   | `drive <run folder> <scenario file>` |
| Report each station's state                | `report <run folder>`                |
| Remove the run's scratch, keeping evidence | `cleanup <run folder>`               |

`tests/pointer-skills.test.ts` fails when the pinned commit below is not the
one `package.json` pins, or when the installed kernel does not hold the full
skill.

Full skill: `node_modules/agent-cli-kernel/skills/verify-cli/SKILL.md`
Pinned commit: `__KERNEL_COMMIT__`
