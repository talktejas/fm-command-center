#!/usr/bin/env bash
# tests/lib.sh - shared primitives for this repo's behavior tests.
#
# A trimmed copy of firstmate's own tests/lib.sh (tests/lib.sh in
# talktejas/firstmate), keeping only what command-center.test.sh and
# command-center-state.test.js actually use: ok/not-ok reporters, a
# self-cleaning temp root, deterministic git fixtures, and the string/file
# assertions. Firstmate's own test suite is not something this repo owns or
# copies wholesale.
#
# ROOT is this repo's own root (this file lives in tests/), so a sourcing test
# can use "$ROOT/command-center.py" etc without recomputing it.

umask 022

# shellcheck disable=SC2034
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

fail() {
  printf 'not ok - %s\n' "$1" >&2
  exit 1
}

pass() {
  printf 'ok - %s\n' "$1"
}

# fm_test_tmproot <prefix> echoes a fresh temp dir, removed on exit.
FM_TEST_CLEANUP_DIRS=()

fm_test_cleanup() {
  local d
  for d in "${FM_TEST_CLEANUP_DIRS[@]:-}"; do
    [ -n "$d" ] && rm -rf "$d"
  done
}
trap fm_test_cleanup EXIT

fm_test_tmproot() {
  local prefix=${1:-fm-test} root tmp_base
  tmp_base=${TMPDIR:-/tmp}
  tmp_base=${tmp_base%/}
  root=$(mktemp -d "$tmp_base/${prefix}.XXXXXX") || return 1
  FM_TEST_CLEANUP_DIRS+=("$root")
  printf '%s\n' "$root"
}

# fm_git_identity: deterministic author/committer for git fixtures.
fm_git_identity() {
  export GIT_AUTHOR_NAME=${1:-fmtest} GIT_AUTHOR_EMAIL=${2:-fmtest@example.invalid}
  export GIT_COMMITTER_NAME=$GIT_AUTHOR_NAME GIT_COMMITTER_EMAIL=$GIT_AUTHOR_EMAIL
}

# fm_git_init_commit <dir>: a git repo at <dir> with a README and one commit.
fm_git_init_commit() {
  local dir=$1
  mkdir -p "$dir"
  git -C "$dir" init -q -b main
  printf '# %s\n' "$(basename "$dir")" > "$dir/README.md"
  git -C "$dir" add README.md
  git -C "$dir" -c user.name='Command Center Tests' -c user.email='tests@example.invalid' \
    commit -qm initial
}

# --- common assertions ------------------------------------------------------

assert_equals() {
  [ "$1" = "$2" ] || fail "$3 (expected '$1', got '$2')"
}

assert_not_equals() {
  [ "$1" != "$2" ] || fail "$3 (unexpectedly got '$1')"
}

assert_contains() {
  case "$1" in
    *"$2"*) : ;;
    *) fail "$3 (missing: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
  esac
}

assert_not_contains() {
  case "$1" in
    *"$2"*) fail "$3 (unexpected: '$2')"$'\n'"--- output ---"$'\n'"$1" ;;
    *) : ;;
  esac
}

# assert_grep <pattern> <file> <msg>: fixed-string grep must match in <file>.
assert_grep() {
  grep -F -- "$1" "$2" >/dev/null || fail "$3"
}
