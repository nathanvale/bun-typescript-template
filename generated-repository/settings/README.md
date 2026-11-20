# `__REPOSITORY_NAME__`

A Bun command-line tool on the CLI kernel.

Source packet: `__SOURCE_PACKET__`

```sh
bun install --frozen-lockfile
bun run start -- --help
bun run start -- status
bun run check
```

## Adding a command

Declare it in `src/commands.ts` and add it to the `commands` list there.
`src/cli.ts` hands that list to the kernel, which parses input, routes, and
prints the result.

## The kernel

The kernel repository owns the kernel. `package.json` pins it to one kernel
commit, and an install places it under `node_modules/`. Do not edit it there:
change the kernel in the kernel repository.

A command gets an add-on's capability only when `installedAddons` in
`src/cli.ts` lists it. The add-ons ship under `agent-cli-kernel/addons/`.
