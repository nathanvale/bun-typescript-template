# Glossary map

Each word has one owner. Look in the glossary first; if it has a word for this,
use it.

This repository's `GLOSSARY.md` is the source of truth for the template's
words. The kernel's glossary owns the kernel's words. A word that only the
template needs is added here and never to the kernel's glossary.

| Glossary        | Owns                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Where                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| This repository | Template, Foundation, Bootstrap, Source packet, Recipe, Recipe table, Generated repository, Pull request template, Issue template, CLI inventory, Pointer skill, Template version, Template upgrade, Kernel split, Sibling repository, Kernel migration, Pin verification, Pin move, Pin move report, Regenerate step, Kernel trial, Kernel lockfile, Kernel reader, Git file, Kernel root and Kernel seam, Bundle, and the coding-standards words (Rule table, Review only, Partial, Parked gate, Single witness and Unproved), with the shared tool words (including Changeset, Changelog and Gated path) that the kernel copies | [GLOSSARY.md](GLOSSARY.md)                                                                               |
| Kernel          | The kernel's own words: Kernel repository, Carry-out, Carry-out identity, Prepared parent, Kernel repository alignment, Recorded origin, Pin, Pinned commit, Installed kernel, Add-on, Add-on selection, Add-on requirement, Kernel declaration, Fault timing, and the words of verify-cli (Target, Probe, Scenario, Evidence folder and the rest of its section)                                                                                                                                                                                                                           | [GLOSSARY.md on the kernel's main](https://github.com/nathanvale/agent-cli-kernel/blob/main/GLOSSARY.md) |
| Agent ecosystem | Words shared across projects that no repository glossary defines yet: Kernel and Template provenance among them. Private, so only its name and owner here                                                                                                                                                                                                                                                                                                                                                                                                                                   | "Agent ecosystem glossary (living)" in Linear. Owner: Engineering, through Linear MAG-64                 |
| Design words    | Module, Interface, Seam and Adapter, with Implementation, Depth, Leverage and Locality                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The codebase-design skill, under "Glossary" in its `SKILL.md`. The skill is not in this repository       |

## Shared tool words

The tool words that both repositories carry (names check, recorded hit, gate,
plain word, layout rule and the rest of the section "Shared tool words") belong
to this repository.
The kernel holds a copy. `tests/template/names-check/shared-tool-words.txt` records
this repository's section, and a test fails when `GLOSSARY.md` differs from it.
The kernel's own export names the template commit it was copied from. Change
the shared section here, then refresh the kernel's copy and its recorded
commit together.

## Words the kernel owns

The kernel accepted the `glossary-split-20261120` transfer, and
`glossary-ownership.json` lists the entries it owns. `GLOSSARY.md` here defines
none of them, and a test fails when it does. Link the kernel's glossary for
them.

The kernel supplies a package that a generated repository installs at its Pin.
The template's own pin, its branch and its dependency line are described in
the [CLI kernel authority](docs/agents/cli-kernel.md#the-templates-pin).
Add-on selection lives only in a generated repository's `installedAddons`.
Template provenance holds no add-on list.

Use **CLI kernel** in contributor guidance. Use **Command Contract 3** when
citing the frozen specification named in the [CLI kernel authority](docs/agents/cli-kernel.md).
