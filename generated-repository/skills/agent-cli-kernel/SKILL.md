---

name: agent-cli-kernel
description: Write commands on the agent-cli-kernel package. Use when code imports agent-cli-kernel to declare a command or its input, write a command that changes something, declare a result it can produce (a station), build the contract with contractFor, test a command, or read a throw from contractFor when the CLI starts.
---

# Writing commands on agent-cli-kernel

This is a pointer skill. The full skill ships inside the installed kernel.
Read the full skill in node_modules before any kernel source:
`node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md`.

| Task                                   | Command                         |
| -------------------------------------- | ------------------------------- |
| Install the kernel at its pin          | `bun install --frozen-lockfile` |
| List the commands                      | `bun run start -- --help`       |
| Run a command                          | `bun run start -- <route>`      |
| Test the commands                      | `bun run test`                  |
| Check the repository before handing on | `bun run check`                 |

`tests/pointer-skills.test.ts` fails when the pinned commit below is not the
one `package.json` pins, or when the installed kernel does not hold the full
skill.

Full skill: `node_modules/agent-cli-kernel/skills/agent-cli-kernel/SKILL.md`
Pinned commit: `__KERNEL_COMMIT__`
