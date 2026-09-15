# Static-admission source packet

This directory is contributor-owned policy source for CDS-TS-2. The public S2
bootstrap combines one selected policy packet with its matching source overlay
under `starters/`. Keeping the policy here gives generated repositories the
same admitted TypeScript, Biome and Fallow configuration without maintaining a
second editable configuration copy.

Each profile below contains only the effective package, TypeScript, Biome and
Fallow policy that a future starter consumes. The admission test adds fresh
synthetic source and test files at runtime, then runs the native tools against
that materialized project. Invalid specimens remain test-only inputs and are
never part of this packet's compiler or linter scope.

The complex packet represents the threshold-met diagnostics variant. Its Zod
and LogTape dependencies are conditional complex-starter pins; the simple
packet has no runtime dependency.

## Contributor admission

From the repository root, admit a materialized project with installed pinned
dependencies and save native receipts outside that project:

```sh
bun run admit:static /absolute/project/path simple /absolute/evidence/path
```

Use `complex` for the threshold-met diagnostics profile. Admission compares
the project policy and lock resolutions with this packet, inventories authored
files, and checks compiler and Fallow discovery coverage. It runs Biome,
TypeScript, project tests, and both Fallow passes against the same files.

`quality:fallow` is the complete whole-project pass, including tests.
`quality:fallow:dependencies` is the separate unfiltered production pass that
also detects type-only dependencies. Both must pass. Each must independently
emit native complete semantic evidence or explicit evidence that no semantic
queries were necessary. Missing metadata cannot qualify either pass.

The command emits one JSON result to stdout and exits zero only for
`status: "admitted"`. A refusal exits one and names its cause. Inspect the
matching native receipt in the evidence directory, repair the reported policy,
scope or tool finding, then request admission again. Receipts retain argv,
working directory, exit code, stdout and stderr, plus the input file hashes.
