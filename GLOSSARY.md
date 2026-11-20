# Bun TypeScript Template glossary

This file is the source of truth for the words this repository owns: the
template and the recipe table that Bootstrap follows, the kernel split, and
the gates that keep its own code honest. `GLOSSARY-MAP.md` names the glossaries
that own every other word, the kernel's among them. The shared tool words are
this repository's, and the kernel holds a copy.

## Language

An `_Avoid_` line lists words not to use for its term. A note in parentheses
says when: it covers the words before it, back to the previous note or
semicolon. The writer and the reviewer hold those words, because the names
check cannot tell what a name means. The names check refuses a word with no note
after it in every file and folder name. It refuses a word noted
`(unqualified)` as a whole name only when
[Words that need a qualifier](#words-that-need-a-qualifier) also lists it.

### Creating a repository

**Template**:
The canonical owner of portable template source and of its own pin. It does not
own the kernel or add-on source.

**Foundation**:
The template, kernel repository, composer, checker, exemplar and
agent-cli-design skill together. It is broader than the kernel.

**Bootstrap**:
The command, `bun run bootstrap`, that creates a generated repository with the
kernel at the template's Pin and the add-ons asked for.

**Source packet**:
The planning material for the repository Bootstrap is asked to make, given as an
absolute path or an HTTP(S) address. Bootstrap records it in the generated
repository.

**Recipe**:
One row of the recipe table. It says which folders Bootstrap copies into a
generated repository and which check command that repository runs.

**Recipe table**:
The module that holds the recipe Bootstrap follows. It holds one row.

**Generated repository**:
A repository created by Bootstrap.
_Avoid_: project, host (unqualified), app (for a generated repository)

**CLI inventory**:
The check that a repository has exactly one application CLI, found across its
source, manifests, scripts and documented invocations.

**Pointer skill**:
A short skill that Bootstrap writes into a generated repository at
`.agents/skills/<name>/SKILL.md`, and links from `.claude/skills/`, for one
skill the installed kernel ships. It carries that skill's trigger, sends the
reader to the full skill under `node_modules/agent-cli-kernel/`, and names
the pinned commit it was written for. The generated repository's tests fail
when that commit is not the one its pin names, or when the installed kernel
does not hold the full skill.
_Avoid_: stub, copy (for a pointer skill)

**Template version**:
One released state of the template, named by a git tag.
_Avoid_: version (unqualified); release, pin (for a template version)

### The kernel split

**Kernel split**:
The whole change that moves the kernel and add-on source and their tests out
of the template into the kernel repository, so that each generated repository
gets the kernel through its pin.
_Avoid_: extraction, migration (when the kernel split is meant)

**Sibling repository**:
A repository checked out beside another on the same machine and reached by a
local path.
_Avoid_: submodule, dependency (unless one is meant)

**Kernel migration**:
Moving a repository that Bootstrap made before the kernel split onto an
installed kernel at a pin. It is not a Template upgrade.
_Avoid_: upgrade, migration (unqualified)

### Pins

**Pin verification**:
Checking, from git history alone, that a pinned commit is reachable from where
the pin's kernel branch points on the pin's own remote, and that the carry-out
commit is that commit or an ancestor of it. The kernel's glossary defines
[Carry-out identity](https://github.com/nathanvale/agent-cli-kernel/blob/main/GLOSSARY.md). A pin move runs it on the new
commit. The template's hosted check runs it on the template's own pin on pull
requests, on pushes to main and weekly.
_Avoid_: pin check (say pin verification)

**Pin move**:
Changing a pin to another commit, in the template or in a generated
repository. It is always its own act: a Template upgrade does not do it.
_Avoid_: bump, update, upgrade (for a pin move)

**Pin move report**:
The account a pin move produces of what changed in the kernel between the old
and new pinned commits. It is what a reviewer of a pin move reads.
_Avoid_: diff, changelog (for a pin move report)

**Kernel trial**:
Making one repository from a candidate kernel commit, with every add-on
selected, and running that repository's check command.
_Avoid_: canary, dry run (for a kernel trial)

### Reading and installing a kernel

**Kernel lockfile**:
The one lockfile the template keeps for generated repositories, once a pin
move has written it. Every add-on selection shares it.
_Avoid_: lockfile (unqualified); package set lockfile (for the kernel lockfile)

**Kernel reader**:
The Module that reads the kernel's files at one commit of a kernel repository.
_Avoid_: reader (unqualified; Reader is the Contract 3 word for a program that parses an envelope)

**Kernel seam**:
The Seam at the kernel reader's Interface, where a kernel repository at one
commit is supplied. A test can supply a stand-in.

### Coding standards

**Rule table**:
The table of coding standards this repository has learned from review, with
what enforces each one today.

**Review only**:
The level of a rule row that has no gate, so the reviewer applies its guide.

**Partial**:
The level of a rule row whose gates cover only part of it, so the reviewer
applies the guide to the rest.

**Planned (parked)**:
A gate agreed for a rule row that does not exist yet and has no slot to be
built in.

**Single witness**:
A lesson seen once, held until a second distinct witness lets it become a rule
row.

**Unproved**:
A case with no passing evidence from the run or host it needs, reported as
unproved and never as a pass.

### Shared tool words

**Toolchain pin**:
The one Bun version a repository runs on. Its doctor fails when the running Bun is
another version.

**Check command**:
The one command a repository runs to show that it is sound. The template, the
kernel repository and every generated repository each have their own.
_Avoid_: check (unqualified)

**Hosted check**:
A repository's check command and gates as its forge runs them on pull requests
and pushes.
_Avoid_: CI (unqualified)

**Gate**:
A required validation that can refuse a change before it lands in a repository.
_Avoid_: proof, admission, guard (for a gate), check (unqualified)

**Test surface**:
An Interface that tests drive the way a caller does.
_Avoid_: test seam (a Seam is where behaviour can vary; nothing varies at a test surface)

**Test area**:
A named set of tests that runs on its own.

**Process runner**:
The module that starts a child process for a script or test, in its own process
group and under an optional time limit.

**Negative control**:
A break made on purpose to show that a test or gate can fail. It can be made once by
hand, or kept.
_Avoid_: mutation; canary (for a negative control)

**Planted fault**:
A negative control kept as a patch, which the test named in its fault record
must keep catching.
_Avoid_: mutant, mutation; canary (for a planted fault)

**Fault record**:
The entry that names a planted fault, the test that must catch it, and the
commit it undoes.

**Fault replay**:
A run that applies each selected planted fault's patch in a temporary
worktree. Its named test must pass without the patch and fail with it. A
repository's standards say which fault records a run selects.

**Anchor**:
The text that places one changed region of a planted fault's patch: the lines the
region removes or, when it only adds lines, the unchanged lines next to it.

**Recorded hit**:
A violation that already existed when its gate landed. The record gives its
reason and lets the gate pass until a commit fixes it.
_Avoid_: known hit, allowlist, baseline

**Refusal**:
A tool declining to act before it changes anything. Its message names the
cause and the repair.
_Avoid_: rejection (for a refusal)

**Repair**:
The next step a failure message tells the reader to take.
_Avoid_: fix (for the step; a fix is a commit)

**Verdict**:
The result of judging one thing once: one planted fault in a fault replay, or
one commit at the per-commit gate.

**Doctor**:
The command that checks, before work starts, that a checkout can run the
repository's check command and gates, and names a repair for each failure.

**Toolchain**:
The tools a repository's check command and gates use, at the accepted versions:
Bun, the linter, the compiler and the dead-code tool.

**Lint rule**:
One rule the linter enforces on code, with a message that names its repair. A
lint rule can be the gate of a rule row.
_Avoid_: rule (unqualified)

**Names check**:
The check that holds every tracked file and folder name to the glossary's
words.
_Avoid_: names gate (for the names check)

**Repo gardener**:
The role that keeps the rule table and the names true. Its four jobs are Sow,
Gate, Weed and Stake.
_Avoid_: steward, janitor

**Sow**:
The repo gardener's job of recording the lesson of a correction or review
finding beside its witness.

**Weed**:
The repo gardener's job of removing a rule row, guide bullet, link definition
or reference that nothing uses any more.
_Avoid_: clean up, prune

**Stake**:
The repo gardener's job of holding a file or folder name to the glossary's
words.

**Rule row**:
One coding standard in the rule table, with what enforces it today.

**Witness**:
A commit or review thread that shows a mistake: the commit that fixed it, the
review thread that caught it, or a commit that carries it.

**Gate note**:
The note, kept in a repository's standards, that says what a rule row's gates
refuse and where, what stays with the reviewer, and which witnesses taught it.

**Citable origins**:
The repositories, other than a repository itself, whose commits and review
threads a citation in that repository's standards may name.
_Avoid_: recorded origin (that is one repository and one commit), allowed hosts

**Claim tag**:
The mark on a claim in a plan that says how sure it is: passed on Linux,
passed on macOS only, designed and not run, decided by Nathan, or open.
_Avoid_: confidence, status (for a claim tag), proven (for a prototype run)

## Words that need a qualifier

Each of these words names different things in different projects. In the name
of a file, a folder, a test or a commit, pair it with a word that says which
one you mean, as `test-proof` does.

_Qualify_: host, project, starter, profile, proof, manifest, probe, copy, dependency, reader, checker, migration, parent, floor, owner, guard, layout
