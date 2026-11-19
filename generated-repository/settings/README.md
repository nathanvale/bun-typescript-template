# `__REPOSITORY_NAME__`

A Bun command-line tool on the stamped CLI kernel.

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

## Stamped source

The kernel repository owns the folders that `.kernel-stamp.json` lists, and
`stamp-checker.ts`. They are copies. Do not edit them here: change the kernel
in the kernel repository.

`bun run check:stamp` compares them with the stamp record and names each file
that differs. `bun run check` runs it first.
