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
The canonical owner of portable template source and of its own pin. Bootstrap
gives each generated repository a pin of its own, at the template's Pin. The
template does not own the kernel or add-on source.

**Foundation**:
The template, kernel repository, composer, checker, exemplar and
agent-cli-design skill together. It is broader than the kernel.

**Bootstrap**:
The command, `bun run bootstrap`, that creates a generated repository with the
kernel at the template's Pin and the add-ons asked for.

**Recipe**:
One row of the recipe table. It says which folders Bootstrap copies into a
generated repository, which of them carries the Pin, and which check command
the repository runs. The type check refuses a row without the Pin.

**Recipe table**:
The module that holds the recipe Bootstrap follows. It holds one row.

**Generated repository**:
A repository created by Bootstrap.
_Avoid_: project, host (unqualified), app (for a generated repository)

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
of the template into the kernel repository, while each generated repository
gets the kernel through its pin. It covers every step, from preparation to
removing every recipe row without the Pin.
For the single step that moves the files, say carry-out.
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
repository. A pin move needs a passed kernel trial. When the pin names a
kernel branch, the new commit must be reachable from it. A Template upgrade
does not move a generated repository's pin; a pin move is always its own act.
The kernel's glossary defines [Pin](https://github.com/nathanvale/agent-cli-kernel/blob/main/GLOSSARY.md).
_Avoid_: bump, update, upgrade (for a pin move)

**Pin move report**:
The account a pin move produces of what changed in the kernel between the old
and new pinned commits. It is what a reviewer of a pin move reads.
_Avoid_: diff, changelog (for a pin move report)

**Kernel trial**:
Making one repository from a candidate kernel commit, with every add-on
selected, and running that repository's check command. It must pass before a
pin move. It may also run on any kernel change as advice only.
_Avoid_: canary, dry run (for a kernel trial)

### Reading and installing a kernel

**Kernel lockfile**:
The one lockfile the template keeps for generated repositories, once a pin
move has written it. Every add-on selection shares it.
_Avoid_: lockfile (unqualified); package set lockfile (for the kernel lockfile)

**Kernel reader**:
The Module that reads the kernel's files from git objects at one commit in a
kernel repository, and never from a working tree.
_Avoid_: reader (unqualified; Reader is the Contract 3 word for a program that parses an envelope)

**Kernel seam**:
The Seam at the kernel reader's Interface: a local path to a kernel repository
and one full commit. Its Adapters are the git object stores it can read: the
sibling repository, any local clone, and a test stand-in.

### Shared tool words

**Toolchain pin**:
The one Bun version this repository runs on, recorded as `packageManager` in
`package.json`. `bun run doctor` fails when the running Bun is another
version.

**Check command**:
The one command a repository runs to show that it is sound. The template, the
kernel repository and every generated repository each have their own.
_Avoid_: check (unqualified)

**Hosted check**:
A repository's check command and gates as its forge runs them on pull requests
and pushes.
_Avoid_: CI (unqualified)

**Gate**:
A required validation that can refuse a change before it lands in a repository. A gate that
would check nothing must fail. The names of a repository's own gates belong to
that repository's standards, not to this glossary. The repo gardener's Gate
job gives a rule row its gate.
_Avoid_: proof, admission, guard (for a gate), check (unqualified)

**Test surface**:
An Interface that tests drive the way a caller does.
_Avoid_: test seam (a Seam is where behaviour can vary; nothing varies at a test surface)

**Test area**:
A named set of tests that runs on its own.

**Process runner**:
The module that starts a child process. By default the child runs in its own
process group with only its own tree's tools on the path; a time limit is
optional. It is meant for any child of a script or test that could hang,
which it ends with a time limit or an explicit stop.

**Negative control**:
A break made on purpose to show that a test or gate can fail. It can be made once by
hand, or kept.
_Avoid_: mutation; canary (for a negative control)

**Planted fault**:
A negative control kept as a patch. Fault replay applies it when its fault
record is selected, so its named test must keep catching it.
_Avoid_: mutant, mutation; canary (for a planted fault)

**Fault record**:
The entry that names a planted fault, the test that must catch it, and the
commit it undoes.

**Fault replay**:
A run that applies each selected planted fault's patch in a temporary
worktree. Its named test must pass without the patch and fail with it. A
repository's standards say which fault records a run selects.

**Anchor**:
The text one changed region of a planted fault's patch is placed by. A hunk
can hold several changed regions, runs of lines it removes or adds, with
unchanged lines between them. A region's anchor is the lines it removes, or,
when it only adds lines, the unchanged lines next to it. Fault replay applies
each region where its anchor occurs exactly once, and uses the hunk's other
lines only to choose between several places.

**Recorded hit**:
A violation that already existed when its gate landed. The record gives
its reason and lets the gate pass until a commit fixes it. Fix every new
violation so the list only shrinks after its gate lands.
_Avoid_: known hit, allowlist, baseline

**Refusal**:
A tool declining to act before it changes anything. Its message names the
cause and the repair.
_Avoid_: rejection (for a refusal)

**Repair**:
The next step a failure message tells the reader to take. A message writes it
after the word "Repair:".
_Avoid_: fix (for the step; a fix is a commit)

**Verdict**:
The result of judging one thing once. A fault replay gives each planted fault
one of KILLED, SURVIVED, STALE, BROKEN or TIMEOUT. The per-commit gate gives
each commit GREEN or RED.

**Doctor**:
The command that checks, before work starts, that this checkout can run the
repository's check command and gates. It verifies the pinned Bun, the
installed toolchain, fallow's readiness and the machine's load, and names
a repair for each failure.

**Toolchain**:
The tools a repository's check command and gates use, at the accepted versions:
Bun, the linter, the compiler and the dead-code tool. The linter and the
dead-code tool each load their own TypeScript package, and the compiler is
TypeScript's native build.

**Lint rule**:
One rule the linter enforces on code, with a message that names its repair. A
lint rule can be the gate of a rule row.
_Avoid_: rule (unqualified)

**Names check**:
Enforces the glossary's words in every tracked file and folder name. It runs as a test, as a hook when a file is created, and at commit.
_Avoid_: names gate (for the names check)

**Repo gardener**:
The role that keeps the rule table and the names true. Its four jobs are Sow,
Gate, Weed and Stake.
_Avoid_: steward, janitor

**Sow**:
Record the lesson of a correction or a review finding beside its witness. A
lesson seen twice grows into a rule row.

**Weed**:
Remove a rule row, guide bullet, link definition or reference that nothing uses any
more, after finding out why it was added.
_Avoid_: clean up, prune

**Stake**:
Hold a file or folder name to the glossary's words: rename it, give its word
an owner, or record the hit with its reason.

**Rule row**:
One row of the rule table in `CODING_STANDARDS.md`. It names a coding standard,
what enforces it today, and the guide or gate note a reviewer applies. A row enters with at least two
witnesses.

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
