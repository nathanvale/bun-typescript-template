# Scratch Profile Proof

Verifies `profiles/scratch/` — as it would land in a **generated repository**
after `bun run bootstrap --profile scratch --destination PATH --source-packet
PATH_OR_URL` — installs, runs, and tests cleanly from a fresh copy, with the
`{{SOURCE_PACKET}}` token correctly substituted and no Fallow presence
anywhere in its dependency, config, or process surface.

## Environment

- Bun 1.4.0 (`bun --version` → `1.4.0`)
- TypeScript 7.0.2 (`bunx tsc --version` → `Version 7.0.2`)

## Method

Copied `profiles/scratch/` (excluding `node_modules`, the lockfile, and the
template-source-only `TEMPLATE-SOURCE.md`) to a fresh `/tmp` directory,
simulated `bootstrap`'s token substitution with a `sed` replace of
`{{SOURCE_PACKET}}` → an example `--source-packet` value, then from that
fresh copy's root (no `cd profiles/scratch` — a generated repository has no
such subdirectory):

```sh
bun install
bun run start
bun test
bun x tsc --noEmit
```

## Result

```
bun install v1.4.0 (34cbb9a40)
Saved lockfile
+ @types/bun@1.4.0
+ typescript@7.0.2
6 packages installed [11.00ms]

$ bun run src/index.ts
Hello, scratch!

bun test v1.4.0 (34cbb9a40)
 1 pass
 0 fail
 1 expect() calls
Ran 1 test across 1 file. [2.00ms]

tsc --noEmit: exit 0
```

## Token substitution check

- Generated `README.md` contains the literal `--source-packet` value passed
  to `sed`, in place of `{{SOURCE_PACKET}}` — confirmed with
  `grep -F "$SOURCE_PACKET" README.md`.
- No leftover `{{SOURCE_PACKET}}` token in the generated `README.md`.
- No `work-placement.md` reference in the generated `README.md` (that path
  only exists in the dotfiles repository; see `TEMPLATE-SOURCE.md` for the
  template-source-only pointer to it).
- No `cd profiles/scratch` in the generated `README.md`'s run instructions —
  commands run from the generated repository's own root.

## Fallow absence check

- `grep -i fallow package.json bun.lock tsconfig.json` → clean.
- `ls node_modules` → `@types`, `@typescript`, `bun-types`, `typescript`,
  `undici-types` only; no `fallow` package.
- `bun install --dry-run` dependency trace → no `fallow` entry.
- `README.md` names "Fallow" only in prose, as ceremony this profile
  deliberately excludes — not as a dependency, script, config entry, or
  process invocation.

Temp copy was deleted after each check; this file is the retained evidence.
