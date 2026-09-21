#!/usr/bin/env bash
# command-center-work.sh - the /bearings lavish board's four sections, straight
# from the firstmate root's bin/fm-bearings-snapshot.sh --json, so nothing shown
# on that board needs a separate page.
#
# Standalone: this repo never copies or edits firstmate's own scripts. The
# snapshot is read by path from a configurable checkout ($FM_FIRSTMATE_ROOT,
# default /home/tds/p/firstmate); command-center.py sets it for the subprocess
# the same way it does for command-center-scan.sh.
#
# Sections mirror bin/fm-bearings-board.sh's own wording exactly:
#   decisions_open -> captains_call   (Captain's Call)
#   in_flight       -> underway        (Underway)
#   landed          -> landed          (Recently landed)
#   gates           -> charted         (Charted next)
#
# The snapshot itself carries none of project/worktree/branch - that is this
# command center's own reading of local task meta, done here the same way
# command-center-scan.sh does it for its own items, so a row here is never
# missing what that surface already shows. A row whose task meta cannot be
# found locally (a remote secondmate, or one with no meta yet) carries nulls
# rather than a guess.
#
# Output: one JSON object, schema fm-command-center-work.v1:
#   captains_call[] underway[] landed[] charted[]  - see the field mapping below
#   omitted[]   passed through from the snapshot, unchanged
#   error       set, with every section empty, when the snapshot could not be read
#
# Every row carries: id, title, project, worktree, branch, branch_state, pr (a
# full PR URL when one is known, else null) - plus whatever the snapshot itself
# named for that section (verb/key/owner; kind/state/repo/doing;
# artifact/owner; blocked_by/reason/owner/filed).
set -eu

LIB_ROOT="${FM_FIRSTMATE_ROOT:-/home/tds/p/firstmate}"
FM_HOME="${FM_HOME:-$LIB_ROOT}"
SNAPSHOT="$LIB_ROOT/bin/fm-bearings-snapshot.sh"
SCHEMA=fm-command-center-work.v1

empty_result() {  # <error-or-empty>
  jq -cn --arg schema "$SCHEMA" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg err "$1" \
    '{schema:$schema, generated:$now, captains_call:[], underway:[], landed:[],
      charted:[], omitted:[], error:(if $err == "" then null else $err end)}'
}

command -v jq >/dev/null 2>&1 || { empty_result "jq is required"; exit 0; }
[ -x "$SNAPSHOT" ] || { empty_result "fm-bearings-snapshot.sh not found at $SNAPSHOT"; exit 0; }

# --- local homes, so a row can be matched to its worktree/branch ------------
# Same registry format command-center-scan.sh reads; duplicated in miniature
# here rather than sourced, so this script never depends on that one's own
# argv dispatcher.
# shellcheck source=/dev/null
[ -f "$LIB_ROOT/bin/fm-secondmate-registry-lib.sh" ] \
  && . "$LIB_ROOT/bin/fm-secondmate-registry-lib.sh"

home_records() {  # prints "<id>\t<path>"
  local registry line
  printf 'main\t%s\n' "$FM_HOME"
  registry="$FM_HOME/data/secondmates.md"
  [ -f "$registry" ] && [ -r "$registry" ] || return 0
  while IFS= read -r line; do
    case "$line" in "- "*) ;; *) continue ;; esac
    command -v secondmate_registry_parse_line >/dev/null 2>&1 || continue
    secondmate_registry_parse_line "$line" || continue
    [ -n "${SECONDMATE_REGISTRY_HOME-}" ] || continue
    [ -z "${SECONDMATE_REGISTRY_HOST-}" ] || continue   # remote: not read here
    [ -d "$SECONDMATE_REGISTRY_HOME" ] || continue
    printf '%s\t%s\n' "$SECONDMATE_REGISTRY_ID" "$SECONDMATE_REGISTRY_HOME"
  done < "$registry"
}

meta_get() {  # <meta> <key>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -1
}

branch_of() {  # <worktree> -> "<branch-state>\t<branch>"
  if [ -z "$1" ] || [ ! -d "$1" ]; then printf 'not-started\t\n'; return 0; fi
  local b
  if b=$(git -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null) && [ -n "$b" ]; then
    printf 'branch\t%s\n' "$b"
  else
    printf 'detached\t\n'
  fi
}

# The first home whose state carries this task's meta - a task id is unique to
# the home that owns it, so the first (and only) match is the honest one.
task_context() {  # <id> -> "<project>\t<worktree>\t<branch_state>\t<branch>"
  local id=$1 hid hpath meta project worktree bstate branch
  while IFS=$'\t' read -r hid hpath; do
    meta="$hpath/state/$id.meta"
    [ -f "$meta" ] || continue
    project=$(meta_get "$meta" project)
    worktree=$(meta_get "$meta" worktree)
    if [ "$(meta_get "$meta" kind)" = secondmate ]; then
      project=$(meta_get "$meta" projects); worktree=
    else
      project=${project##*/}
    fi
    IFS=$'\t' read -r bstate branch < <(branch_of "$worktree")
    printf '%s\t%s\t%s\t%s\n' "$project" "$worktree" "$bstate" "$branch"
    return 0
  done < <(home_records)
  printf '\t\t\t\n'
}

RAW=$(timeout 60 "$SNAPSHOT" --json 2>&1) || { empty_result "${RAW:-fm-bearings-snapshot.sh failed}"; exit 0; }
printf '%s' "$RAW" | jq -e . >/dev/null 2>&1 \
  || { empty_result "fm-bearings-snapshot.sh produced unreadable output"; exit 0; }

# One context lookup per distinct id, folded into a single {"id":{...}} map so
# the final jq pass is one process, not one per row.
CTXMAP='{}'
while IFS= read -r id; do
  [ -n "$id" ] || continue
  IFS=$'\t' read -r project worktree bstate branch < <(task_context "$id")
  CTXMAP=$(printf '%s' "$CTXMAP" | jq -c \
    --arg id "$id" --arg project "$project" --arg worktree "$worktree" \
    --arg bstate "$bstate" --arg branch "$branch" \
    '.[$id] = {project:(if $project=="" then null else $project end),
               worktree:(if $worktree=="" then null else $worktree end),
               branch:(if $branch=="" then null else $branch end),
               branch_state:(if $bstate=="" then null else $bstate end)}')
done < <(printf '%s' "$RAW" | jq -r '
  [(.decisions_open//[])[].id, (.in_flight//[])[].id,
   (.landed//[])[].id, (.gates//[])[].id] | unique | .[]')

printf '%s' "$RAW" | jq -c \
  --argjson ctx "$CTXMAP" --arg schema "$SCHEMA" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
  def withctx: . as $r
    | ($ctx[$r.id] // {project:null,worktree:null,branch:null,branch_state:null}) as $c
    | $r + $c
      + {pr: (if (($r.artifact? // "") | test("^https?://")) then $r.artifact else null end)};
  {
    schema: $schema, generated: $now,
    captains_call: [(.decisions_open // [])[] | {id, title: .summary, verb, key, owner} | withctx],
    underway:      [(.in_flight // [])[] | {id, title: .name, kind, state, repo, doing} | withctx],
    landed:        [(.landed // [])[] | {id, title: .what, artifact, owner} | withctx],
    charted:       [(.gates // [])[] | {id, title, blocked_by, reason, owner, filed} | withctx],
    omitted: (.omitted // []),
    error: null
  }'
