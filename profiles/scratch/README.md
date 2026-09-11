# Scratch Profile

This is a **scratch** repository: a containment boundary, not a
production-readiness claim. Dump code here, run it, throw it away when done.

## What this profile includes

- Bun 1.4.0 (`packageManager` pin) and TypeScript 7.0.2 as a dev dependency,
  type-checked with `tsc --noEmit`.
- `bun test` for proportionate tests.

## What this profile deliberately excludes

Fallow, complexity governance, monorepo structure, CI, release tooling, hooks,
and other product ceremony. Add any of these only if the experiment
specifically needs it.

## Source packet

`{{SOURCE_PACKET}}`

## Run it

```sh
bun install
bun run start
bun test
bun x tsc --noEmit
```

## Deletion, retirement, or promotion

- **Delete** this profile once the experiment's question is answered and
  nothing here is worth keeping — the source packet above is the durable
  record, not this code.
- **Promote** by selecting the `durable` profile from the bootstrap template
  when this becomes a maintained product, shared library, reusable tool, or
  long-lived code owner that justifies that maintenance — not before.
