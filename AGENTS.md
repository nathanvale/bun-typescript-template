# Bun TypeScript Template

## Before work

- Run the doctor with `bun run doctor` and apply any repair it names.
- For the installed kernel, the Pin or `pin-move`, use
  [kernel-work](.agents/skills/kernel-work/SKILL.md). Kernel source lives in
  the `agent-cli-kernel` repository.
- Use the [repo gardener](.agents/skills/repo-gardener/SKILL.md) skill for
  an operator correction, review finding, rule row that needs a gate,
  unused guidance, or a name the names check refuses.

## Authority

- For CLI kernel behaviour, read the [CLI kernel authority](docs/agents/cli-kernel.md).
- Before naming a file, folder, symbol, test, or commit, look in the glossary
  first ([glossary map](GLOSSARY-MAP.md)); if it has a word for this, use it.

## Coordination context

- When CLI kernel work needs a private record, find its
  [planning record owner](docs/agents/cli-kernel.md#coordination-context).

## Checks

- Run the names check area with `bun run test:area names-check`.
- For a test area, the full suite, timing-sensitive tests, or a failed
  hosted check, use the [test and hosted check guidance](docs/agents/README.md#checks).
- Review a diff using the [review routine](CODING_STANDARDS.md#review-routine).

## Pull requests

- For opening, reviewing, or merging a pull request, follow the
  [pull request workflow](docs/agents/pull-requests.md).
