# __REPOSITORY_NAME__

State-changing Bun CLI generated from the canonical complex starter.

Source packet: __SOURCE_PACKET__

```sh
bun install --frozen-lockfile
bun run start -- --help
bun run --silent start -- status --json
bun run --silent start -- set --value enabled --preview --json
bun run --silent start -- recover --json
bun run check
```

Set `CLI_EXAMPLE_STATE` to choose the example state file. The generated
repository owns its dependencies, lockfile, source, tests and CI. It has no
runtime dependency on the template or generator.

Applied changes write an intent before the state effect and a completion record
after it. An unresolved intent blocks another write; recovery inspects it
without replaying it. The process lifecycle waits for stdout drain, contains a
closed consumer, ignores held-open stdin, makes a best-effort crash diagnostic,
and bounds first SIGINT or SIGTERM shutdown to 500 milliseconds. A repeated
termination exits immediately.
