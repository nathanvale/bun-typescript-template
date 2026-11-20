# Glossary map

Each word has one owner. Find the glossary that owns the word you need, and
use its word.

This repository's `GLOSSARY.md` is the source of truth for every word it
defines, except where the transfer rule below or the shared tool words say
otherwise. No other glossary defines those words.

| Glossary        | Owns                                                                                                                                                                                                                                                         | Where                                                                                              |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| This repository | Every word that `GLOSSARY.md` defines: recipes, the kernel split with its pin, the installed kernel and the kernel lockfile, the template's own checks, the repo gardener's words, Bootstrap, and the words Template, Foundation, Add-on and Recorded origin | [GLOSSARY.md](GLOSSARY.md)                                                                         |
| Agent ecosystem | Words shared across projects that no repository glossary defines yet: Kernel, Repository profile, Template provenance and Template upgrade among them. Private, so only its name and owner here                                                              | "Agent ecosystem glossary (living)" in Linear. Owner: Engineering, through Linear MAG-64           |
| Design words    | Module, Interface, Seam and Adapter, with Implementation, Depth, Leverage and Locality                                                                                                                                                                       | The codebase-design skill, under "Glossary" in its `SKILL.md`. The skill is not in this repository |

Add-on selection lives only in a generated repository's `installedAddons`.
Template provenance holds no add-on list.

Use **CLI kernel** in contributor guidance. Use **Command Contract 3** when
citing the frozen specification named in the [CLI kernel authority](docs/agents/cli-kernel.md).

## Ownership transfer

The `glossary-split-20261120` transfer governs the kernel entries that
`glossary-ownership.json` lists and `GLOSSARY.md` holds under "Entries awaiting
kernel acceptance". Their sole owner is the template until the kernel's main
branch accepts this transfer in its own `glossary-ownership.json`. After that
their sole owner is the kernel, and the entries here are copies, even before
they are removed. This rule replaces every older statement that gives all
words to one glossary. No template-only entry and no shared tool word
transfers.

The shared tool words are one section of `GLOSSARY.md`, recorded as an export
in `tests/template/naming/shared-tool-words.txt`. The template owns them and
the kernel holds a copy; a test fails when this repository's section differs
from the export.
