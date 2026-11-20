---

name: verify-template
description: Prove the template's user journey black-box from a scratch clone. Bootstrap a generated repository, run its check command, commit, and see the doctor, the commit hook and check:commits refuse planted mistakes. Use after changing Bootstrap, the generated repository, a gate script or a git hook, or before claiming one works.
---

# Verify template

Drive the template the way a new user does: from a scratch clone outside every
repository, through `bun run` and `git commit`, keeping a transcript of each
command. The [feature map](features/README.md) holds one recipe per feature.
This file holds the session around them. Words follow
[GLOSSARY.md](../../../GLOSSARY.md).

## Session

[`scripts/session.sh`](scripts/session.sh) owns one run root:
`<run root>/work/` holds the clone and the generated repositories, and
`<run root>/evidence/` holds the transcripts. Run it from the template
checkout:

```sh
skill=.agents/skills/verify-template
run="${TMPDIR:-/tmp}/verify-template/$(date -u +%Y%m%dT%H%M%SZ)"
```

Every helper call needs the pinned Bun (`packageManager` in `package.json`).
When `bun --version` prints another version, wrap each call as
`mise exec bun@1.4.4 -- "$skill/scripts/session.sh" ...`, or run it in a clean
login shell: `env -i HOME="$HOME" USER="$USER" TERM=xterm-256color zsh -lic '...'`.
The helper refuses the wrong Bun and names both repairs.

### Launch

`"$skill/scripts/session.sh" launch "$run"` clones the checkout's `HEAD`
commit into `$run/work/template`, runs `bun install --frozen-lockfile` and the
doctor there, and prints `ready: <clone> at <sha>` when the doctor passes.

- It tests the commit, not uncommitted edits. Commit first; launch prints the
  uncommitted path count when there is one.
- Each run root is its own instance, so two runs can go side by side. Launch
  refuses a run root whose `work/` exists or that sits inside a git work tree.
- A failed launch names its repair. Run cleanup on that run root, then launch
  a new one.

### Doctor

`"$skill/scripts/session.sh" doctor "$run"` is read-only. It checks the clone is
at the launched commit and Bun matches the pin, then runs
`bun run --silent doctor` in the clone. Run it first whenever anything looks
off. A `WARN load` line is not a failure: timing-sensitive tests may flake.

### Drive

`"$skill/scripts/session.sh" record "$run" <name> <folder> '<command>'` runs
the command with `sh -c` in the folder, as git identity `verify-template`, with
`$run` set to the run root, and writes `evidence/<name>.txt` plus a row in `evidence/index.tsv` (name, exit
code, path). It exits 0 even when the command fails. Read the exit code from
the transcript.

- `<folder>` is relative to `$run/work` or absolute: `template` is the clone,
  `generated/<name>` a Bootstrap destination.
- Give each proof its own name, such as `bootstrap-green` or
  `hook-red-name`. The feature files use these names.
- A red proof is one of two kinds. A **hands-on red** plants a mistake in the
  run's own clone or generated repository, runs the gate, then restores the
  file with `git checkout -- <file>`. A **fault replay** runs
  `bun run --silent fault-replay <id> ...` in `template` and expects `KILLED`.
  A fault replay proves the gate's test catches the planted fault, not that the
  gate refuses a user, so record a hands-on red wherever the feature file
  gives one.

### Evidence

- Each proof is a `record` transcript: command, stdout, stderr, exit code, Bun
  version, host and commit.
- Drive the public entry: `bun run <script>`, the CLI the generated repository
  ships, and `git commit` through the installed hook. Internal functions and
  test helpers prove nothing about the user's path.
- Pair every green with a red. A gate that never goes red proves nothing.
- Check side effects with a second command: the files Bootstrap wrote, the
  commits git recorded, `git status --porcelain` after a refusal.
- Report each feature with its green and red transcript names. Report a
  sub-feature you could not reach with the command tried and the unmet
  precondition; never report it as proven through a different path.

### Cleanup

`"$skill/scripts/session.sh" cleanup "$run"` removes worktrees registered to
the clone (fault replay and check:commits make them under `$run/work/tmp`),
deletes `$run/work`, and keeps `$run/evidence` and `$run/run.env`. It prints
the kept file count. It refuses a folder without `run.env`, and it refuses,
keeping everything, while a worktree outside `$run/work` still uses the clone.
Run it after every failed iteration too.

## Linux

Run the same session inside `oven/bun:1.4.4` as a non-root user. On the Mac
mini, OrbStack runs it. Launch clones a commit, so send a git bundle of the
branch, a driver script holding your helper calls, and this setup script,
`inner.sh`, which prints the kept evidence as a tar on stdout:

```sh
set -eu
apt-get update -qq >&2
apt-get install -y -qq git procps nodejs >/dev/null 2>&1
useradd -m verify
cp /in/head.bundle /in/driver.sh /home/verify/
chown verify /home/verify/head.bundle /home/verify/driver.sh
su verify -c 'cd && git clone -q -b <branch> head.bundle template && cd template && sh ../driver.sh' >&2
tar -C "$(ls -d /tmp/verify-template/* | head -n 1)" -cf - evidence run.env
```

```sh
git bundle create "$out/in/head.bundle" <branch>
tar -C "$out/in" -cf - head.bundle driver.sh inner.sh |
  ssh -o BatchMode=yes mac-mini "zsh -lc 'docker run -i --rm oven/bun:1.4.4 bash -c \"mkdir /in && tar -x -C /in -f - && bash /in/inner.sh\"'" 2>"$out/linux.log" |
  tar -x -C "$out"
```

- The image lacks git and procps, and some template tests fail as root.
- The image has no Node.js, only Bun's `node` fallback, and a generated check
  then fails at Fallow (see [Bootstrap](features/bootstrap.md#gotchas)).
  `nodejs` stands in for the Node a hosted runner or a developer machine has.
- The container is the stand-in for a Linux host. Its package installs and
  user are setup steps a real Linux host must supply itself.

## Features

Read the [feature map](features/README.md) before driving, then use the
matching feature file as the recipe.
