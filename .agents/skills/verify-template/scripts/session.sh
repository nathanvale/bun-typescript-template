#!/bin/sh
set -eu

# A caller's repository-location variables would point every git call here,
# including recorded commands and cleanup, at the caller's checkout.
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY \
  GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_COMMON_DIR

usage="Usage: session.sh launch <run root> [checkout] | doctor <run root> | record <run root> <name> <folder> <command> | cleanup <run root>"

fail() {
  printf '%s\n' "$1" >&2
  exit "${2:-1}"
}

pinned_bun() {
  sed -n 's/.*"packageManager": *"bun@\([^"+]*\).*/\1/p' "$1/package.json"
}

require_pinned_bun() {
  pin=$(pinned_bun "$1")
  found=$(bun --version 2>/dev/null || printf 'none')
  [ "$found" = "$pin" ] && return 0
  fail "session: found Bun $found, the template pins $pin. Repair: run this helper as mise exec bun@$pin -- $0 ..., or from a login shell whose PATH puts Bun $pin first. Done when bun --version prints $pin."
}

require_run() {
  [ -f "$1/run.env" ] || fail "session: $1 has no run.env, so this helper did not launch it. Repair: pass the run root that launch printed."
}

require_launch_bun() {
  launched=$(sed -n 's/^bun=//p' "$1/run.env")
  found=$(bun --version 2>/dev/null || printf 'none')
  [ "$found" = "$launched" ] && return 0
  fail "session: found Bun $found, launch ran with $launched. Repair: run this helper as mise exec bun@$launched -- $0 ..., or from a login shell whose PATH puts Bun $launched first. Done when bun --version prints $launched."
}

folder_in() {
  case "$2" in
    /*) printf '%s' "$2" ;;
    *) printf '%s' "$1/work/$2" ;;
  esac
}

record() {
  require_run "$1"
  root=$(cd "$1" && pwd -P)
  name=$2
  folder=$(folder_in "$root" "$3")
  command=$4
  require_launch_bun "$root"
  [ -d "$folder" ] || fail "session: $folder is not a folder. Repair: launch first, or pass a folder under $root/work."
  case "$name" in
    */* | .* | "") fail "session: record name \"$name\" must be one plain file name. Repair: pass a name such as bootstrap-green." 2 ;;
  esac
  out="$root/evidence/$name.txt"
  stdout=$(mktemp)
  stderr=$(mktemp)
  mkdir -p "$root/work/tmp"
  set +e
  (
    cd "$folder" &&
      run="$root" TMPDIR="$root/work/tmp" GIT_AUTHOR_NAME=verify-template GIT_AUTHOR_EMAIL=verify-template@example.invalid \
        GIT_COMMITTER_NAME=verify-template GIT_COMMITTER_EMAIL=verify-template@example.invalid \
        sh -c "$command"
  ) >"$stdout" 2>"$stderr" </dev/null
  status=$?
  set -e
  head=$(git -C "$folder" rev-parse HEAD 2>/dev/null || printf 'none')
  {
    printf 'name: %s\n' "$name"
    printf 'when: %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    printf 'host: %s\n' "$(uname -sm)"
    printf 'bun: %s\n' "$(bun --version 2>/dev/null || printf 'none')"
    printf 'folder: %s\n' "$folder"
    printf 'head: %s\n' "$head"
    printf 'command: %s\n' "$command"
    printf -- '--- stdout\n'
    cat "$stdout"
    printf -- '--- stderr\n'
    cat "$stderr"
    printf -- '--- exit\n%s\n' "$status"
  } >"$out"
  rm -f "$stdout" "$stderr"
  printf '%s\t%s\t%s\n' "$name" "$status" "$out" >>"$root/evidence/index.tsv"
  printf 'recorded %s: exit %s, %s\n' "$name" "$status" "$out"
}

launch() {
  root=$1
  checkout=${2:-$(git rev-parse --show-toplevel)}
  require_pinned_bun "$checkout"
  [ -e "$root/work" ] && fail "session: $root/work exists, so another run may own it. Repair: pick a new run root, or run cleanup $root if this run is yours."
  mkdir -p "$root"
  if git -C "$root" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    fail "session: $root is inside a git work tree, so a generated repository there would share its history. Repair: pass a run root outside every repository, such as \${TMPDIR:-/tmp}/verify-template/<run id>."
  fi
  mkdir -p "$root/evidence" "$root/work"
  revision=$(git -C "$checkout" rev-parse HEAD)
  dirty=$(git -C "$checkout" status --porcelain | wc -l | tr -d ' ')
  {
    printf 'checkout=%s\n' "$checkout"
    printf 'revision=%s\n' "$revision"
    printf 'uncommitted=%s\n' "$dirty"
    printf 'bun=%s\n' "$(bun --version)"
    printf 'host=%s\n' "$(uname -sm)"
  } >"$root/run.env"
  git clone --quiet --no-hardlinks "$checkout" "$root/work/template"
  git -C "$root/work/template" checkout --quiet --detach "$revision"
  record "$root" launch-install template "bun install --frozen-lockfile"
  record "$root" launch-doctor template "bun run --silent doctor"
  [ "$dirty" = 0 ] || printf 'session: %s has %s uncommitted paths; this run tests %s only.\n' "$checkout" "$dirty" "$revision" >&2
  status=$(awk -F '\t' '$1 == "launch-doctor" { status = $2 } END { print status }' "$root/evidence/index.tsv")
  [ "$status" = 0 ] || fail "session: the template doctor failed (see $root/evidence/launch-doctor.txt). Repair: apply its Repair line, then run cleanup $root and launch again."
  printf 'ready: %s at %s\n' "$root/work/template" "$revision"
}

doctor() {
  root=$1
  require_run "$root"
  template="$root/work/template"
  [ -d "$template" ] || fail "FAIL launch: $template is missing. Repair: run launch with a new run root."
  revision=$(sed -n 's/^revision=//p' "$root/run.env")
  head=$(git -C "$template" rev-parse HEAD)
  [ "$head" = "$revision" ] || fail "FAIL revision: the clone is at $head, launch recorded $revision. Repair: git -C $template checkout --detach $revision."
  printf 'ok revision: %s\n' "$head"
  require_pinned_bun "$template"
  printf 'ok bun: %s\n' "$(bun --version)"
  (cd "$template" && bun run --silent doctor)
}

cleanup() {
  root=$1
  require_run "$root"
  template="$root/work/template"
  if [ -d "$template/.git" ]; then
    work=$(cd "$root/work" && pwd -P)
    own=$(cd "$template" && pwd -P)
    outside=$(git -C "$template" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r tree; do
      case "$tree" in
        ("$own" | "$template" | "$work"/* | "$root/work"/*) ;;
        (*) printf '%s ' "$tree" ;;
      esac
    done)
    [ -z "$outside" ] || fail "session: worktrees outside $root/work use the clone's git folder, so cleanup kept everything: $outside. Repair: keep what you need from each, run git -C $template worktree remove <path> for each, then run cleanup $root again."
    git -C "$template" worktree list --porcelain | sed -n 's/^worktree //p' | while read -r tree; do
      [ "$tree" = "$own" ] || [ "$tree" = "$template" ] && continue
      git -C "$template" worktree remove --force "$tree" || true
    done
  fi
  rm -rf "$root/work"
  count=$(find "$root/evidence" -type f | wc -l | tr -d ' ')
  printf 'cleaned %s/work; kept %s evidence files in %s/evidence\n' "$root" "$count" "$root"
}

command=${1:-}
[ $# -gt 0 ] && shift
case "$command" in
  launch) [ $# -ge 1 ] || fail "$usage" 2; launch "$@" ;;
  doctor) [ $# -eq 1 ] || fail "$usage" 2; doctor "$1" ;;
  record) [ $# -eq 4 ] || fail "$usage" 2; record "$@" ;;
  cleanup) [ $# -eq 1 ] || fail "$usage" 2; cleanup "$1" ;;
  *) fail "$usage" 2 ;;
esac
