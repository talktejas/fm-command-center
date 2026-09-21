#!/usr/bin/env bash
# command-center-scan.sh - one JSON view of everything waiting on the captain,
# across this home and every local secondmate home.
#
# The reading half of the command center (command-center.py serves it,
# docs/command-center.md is the operator guide). Every fact here comes from a
# durable firstmate record or from the library that already owns its meaning;
# this script adds no semantics of its own.
#
# Usage:
#   command-center-scan.sh            emit the JSON view
#   command-center-scan.sh --fingerprint   emit only the change fingerprint
#
# WHY A SEPARATE SCRIPT. The open-decision fold (bin/fm-classify-lib.sh) and the
# busy classification (bin/fm-busy-lib.sh) are bash contracts owned elsewhere.
# Shelling out once per refresh keeps that knowledge where its owner lives
# instead of growing a second, drifting copy inside an HTTP server.
#
# WHY THE BACKLOG FILE RATHER THAN `tasks-axi list`. tasks-axi has no machine
# read format (`--json` covers mutations only) and its TOON table truncates long
# fields, which is fatal for a surface whose whole purpose is that nothing the
# captain wrote gets lost. The markdown backend file is the durable record
# itself, carries the untruncated hold reason and body, and its path is read
# from .tasks.toml rather than assumed. A home on a non-markdown backend is
# reported with `backlog_readable: false` rather than silently shown as empty,
# as is one whose backlog file exists but cannot be read. A markdown home with
# no backlog file yet holds nothing, and is reported readable and empty.
#
# FINGERPRINT. `--fingerprint` stats every status log, task meta, steering
# inbox and backlog across all homes and hashes the result. It is the cheap
# change check the server polls behind, so a full scan runs only when a record
# actually moved.
#
# Output: one JSON object on stdout.
#   homes[]  id, name, path, watcher_beat_epoch,
#            backlog_readable  false ONLY when holds are hidden: an unsupported
#                              backend, or a backlog file present but unreadable.
#                              An absent file on the markdown backend is true.
#   items[]  one per thing waiting on the captain:
#     home, id, source (hold|status), key, title, detail, repo, kind,
#     project, worktree, branch, branch_state (branch|detached|not-started),
#     listen (busy|idle|unknown|dead|none), listen_source,
#     since_epoch, since_kind (created|status-timestamp|status-mtime|none),
#     sent[]   the captain's steering records still in flight:
#              seq, at, delivered, handled, text
#   generated, schema
set -eu

# Standalone: this repo never copies or edits firstmate's own scripts. The
# open-decision fold and busy classification are bash contracts owned by
# firstmate's bin/ - sourced from there, by path, from a configurable
# checkout ($FM_FIRSTMATE_ROOT; command-center.py's --firstmate-root sets it
# for the subprocess). This is independent of FM_ROOT_OVERRIDE below: that one
# only ever pointed at the CODE root that carries .tasks.toml, never at where
# these libraries live, and a caller testing an alternate .tasks.toml must not
# also have to fake up a whole firstmate checkout to go with it.
LIB_ROOT="${FM_FIRSTMATE_ROOT:-/home/tds/p/firstmate}"
FM_ROOT="${FM_ROOT_OVERRIDE:-$LIB_ROOT}"
FM_HOME="${FM_HOME:-$FM_ROOT}"
SCHEMA=fm-command-center.v1

# shellcheck source=/dev/null
. "$LIB_ROOT/bin/fm-classify-lib.sh"
# shellcheck source=/dev/null
. "$LIB_ROOT/bin/fm-busy-lib.sh"
# shellcheck source=/dev/null
. "$LIB_ROOT/bin/fm-secondmate-registry-lib.sh"

usage() {
  awk 'NR == 1 { next } /^#/ { sub(/^# ?/, ""); print; next } { exit }' "$0"
}

fail() {
  printf 'command-center-scan: %s\n' "$*" >&2
  exit 1
}

command -v jq >/dev/null 2>&1 || fail "jq is required"

# --- homes -------------------------------------------------------------------
# The main home plus every LOCAL secondmate home. A remote secondmate is
# deliberately skipped: reaching it needs the remote transport, which is not a
# cost a three-second poll may pay. Its absence is stated, never implied.
home_records() {  # prints "<id>\t<name>\t<path>"
  local registry line
  printf '%s\t%s\t%s\n' main Main "$FM_HOME"
  registry="$FM_HOME/data/secondmates.md"
  [ -f "$registry" ] && [ -r "$registry" ] || return 0
  while IFS= read -r line; do
    case "$line" in "- "*) ;; *) continue ;; esac
    secondmate_registry_parse_line "$line" || continue
    [ -n "$SECONDMATE_REGISTRY_HOME" ] || continue
    [ -z "$SECONDMATE_REGISTRY_HOST" ] || continue   # remote: not polled here
    [ -d "$SECONDMATE_REGISTRY_HOME" ] || continue
    printf '%s\t%s\t%s\n' \
      "$SECONDMATE_REGISTRY_ID" "$SECONDMATE_REGISTRY_ID" "$SECONDMATE_REGISTRY_HOME"
  done < "$registry"
}

# --- fingerprint -------------------------------------------------------------
fingerprint() {
  local path backlog
  while IFS=$'\t' read -r _ _ path; do
    [ -n "$path" ] || continue
    # The same backlog file the scan reads, or the change check would go blind
    # to every hold on a home whose .tasks.toml names another path.
    backlog=$(backlog_path "$path") || backlog=
    stat -c '%Y %s %n' \
      "$path"/state/*.status "$path"/state/*.meta "$path"/state/*.inbox \
      "$path"/state/.last-watcher-beat ${backlog:+"$backlog"} 2>/dev/null || true
  done < <(home_records) | sort | cksum
}

# --- backlog -----------------------------------------------------------------
# The markdown backend file for a home, or empty when the home uses another
# backend. .tasks.toml lives with the CODE, while the path it names is relative
# to the HOME, which is why both roots appear here.
backlog_path() {  # <home>
  local cfg backend rel
  cfg="$FM_ROOT/.tasks.toml"
  [ -f "$cfg" ] || return 1
  backend=$(sed -n 's/^backend *= *"\([^"]*\)".*/\1/p' "$cfg" | head -1)
  [ "$backend" = markdown ] || return 1
  rel=$(sed -n 's/^path *= *"\([^"]*\)".*/\1/p' "$cfg" | head -1)
  [ -n "$rel" ] || rel=data/backlog.md
  printf '%s/%s\n' "$1" "$rel"
}

# Held tasks from the backlog file, as TSV: id, title, repo, kind, since, hold,
# body. A task line looks like
#   - [ ] <id> - <title> (repo: r) (kind: k) (since: D) (hold: reason) (...)
# and its body is the indented continuation beneath it. Only OPEN tasks carrying
# a (hold: ...) annotation are the captain's to answer: a closed `- [x]` row
# keeps its hold annotation after the answer landed, and carding it again would
# put every settled decision back in front of him.
#
# ONLY UNDER A SECTION TASKS-AXI ITSELF WRITES OPEN TASKS UNDER. `## Queued`
# and `## In flight` are the only two headings tasks-axi ever puts a `- [ ]`
# row beneath; nothing else in this file is a task, however task-shaped a line
# looks. A hand-written or reported narrative section - "## Captain rulings
# 2026-08-12 on the manufacturing-study decisions", say - can quote an old
# decision in exactly this bullet shape without being one, and answering it
# was never possible: there was no row a backend command could ever act on.
#
# The body has newlines and the record is TSV, so newlines travel as US (\037)
# and the caller restores them. A record field that can contain the record
# separator is the classic way a parser quietly eats the next row.
held_tasks() {  # <backlog-file>
  [ -f "$1" ] && [ -r "$1" ] || return 0
  awk '
    # Before the first heading a real tasks-axi file has none of its own yet,
    # so bullets there are read as tasks, same as always.
    BEGIN { insection = 1 }
    function flush(   b) {
      if (id == "") return
      # Only hold-kind "captain", exactly. An ABSENT hold kind does not mean
      # captain: tasks-axi makes --kind optional, so a hold with none is one of
      # the parked/future/load holds firstmate sets. bin/fm-captain-hold.sh checks
      # that every hold it sets retains hold_kind captain, so a real captain
      # call never reaches the backlog without the annotation.
      if (hold != "" && holdkind == "captain") {
        b = body
        gsub(/\n+$/, "", b)
        gsub(/\n/, "\036", b)
        printf "%s\037%s\037%s\037%s\037%s\037%s\037%s\037%s\n",
          id, title, repo, kind, since, hold, until, b
      }
      id = ""; title = ""; repo = ""; kind = ""; since = ""
      hold = ""; holdkind = ""; until = ""; body = ""
    }
    # Only a real `##` section heading ever changes insection: the file title
    # line ("# Backlog") and any deeper subheading are flushed like any other
    # heading but leave section membership exactly as it was.
    /^## / {
      flush()
      insection = ($0 == "## Queued" || $0 == "## In flight")
      next
    }
    /^#/ { flush(); next }
    !insection { next }   # a narrative or otherwise foreign section: no task here
    /^- \[[ x]\] / {
      flush()
      if ($0 !~ /^- \[ \] /) next          # closed row: never a live captain call
      line = substr($0, 7)
      id = line; sub(/ - .*$/, "", id)
      rest = line; sub(/^[^ ]* - /, "", rest)
      title = rest
      # Strip the trailing (key: value) annotations off the title, and read
      # them. ONLY the keys the backlog format defines: an open key pattern eats
      # an ordinary trailing parenthetical, and a title is his own words.
      # bin/fm-fleet-snapshot.sh owns this same rule over the same file.
      while (match(title, / \(((repo|kind|priority|hold|hold-kind|hold-until): |(since|merged|reported|done) )[^()]*\)$/)) {
        ann = substr(title, RSTART + 2, RLENGTH - 3)
        title = substr(title, 1, RSTART - 1)
        key = ann; sub(/:? .*$/, "", key)
        val = ann; sub(/^[a-z-]+:? /, "", val)
        if (key == "repo")      repo     = val
        if (key == "kind")      kind     = val
        if (key == "since")     since    = val
        if (key == "hold")      hold     = val
        if (key == "hold-kind") holdkind = val
        if (key == "hold-until") until   = val
      }
      next
    }
    /^  / { if (id != "") { l = $0; sub(/^  /, "", l); body = body l "\n" } ; next }
    /^$/ { if (id != "") body = body "\n"; next }
    { flush() }
    END { flush() }
  ' "$1"
}

# --- per-task record reads ---------------------------------------------------
meta_get() {  # <meta> <key>
  [ -f "$1" ] || return 0
  sed -n "s/^$2=//p" "$1" | head -1
}

# A branch is recorded nowhere in firstmate's own records, so it is read live.
# The three answers are all real: a ship on its branch, a scout on a detached
# scratch copy, and work nobody has started at all.
branch_of() {  # <worktree>  -> "<branch-state>\t<branch>" (newline-terminated)
  if [ -z "$1" ] || [ ! -d "$1" ]; then
    printf 'not-started\t\n'
    return 0
  fi
  local b
  if b=$(git -C "$1" symbolic-ref --quiet --short HEAD 2>/dev/null) && [ -n "$b" ]; then
    printf 'branch\t%s\n' "$b"
  else
    printf 'detached\t\n'
  fi
}

# The captain's own steering records for a task and how far each one got.
# Delivered is the record existing at all; picked up is the worker's own move
# into handled/ (bin/fm-task-inbox-lib.sh owns that acknowledgement contract).
# Nothing between the two is reported, because nothing between the two is
# observable.
sent_records() {  # <state-dir> <id>  -> JSON array
  local dir=$1/$2.inbox f seq at text handled
  [ -d "$dir" ] || { printf '[]'; return 0; }
  {
    for f in "$dir"/*.msg "$dir"/handled/*.msg; do
      [ -f "$f" ] || continue
      seq=$(basename "$f" .msg)
      at=$(sed -n 's/^at=//p' "$f" | head -1)
      text=$(sed -n '/^--$/,$p' "$f" | tail -n +2)
      case "$f" in */handled/*) handled=true ;; *) handled=false ;; esac
      jq -cn --arg s "$seq" --arg a "$at" --arg t "$text" --argjson h "$handled" \
        '{seq:$s,at:$a,delivered:true,handled:$h,text:$t}'
    done
  } | jq -cs 'sort_by(.seq)'
}

epoch_of() {  # <file>
  [ -e "$1" ] && stat -c '%Y' "$1" 2>/dev/null || printf ''
}

# ONE KNOWN MACHINE LINE NEVER REACHES HIS SCREEN. A no-mistakes ask-user gate
# reports itself as `ask-user findings=<ids> file=<path>` (bin/fm-dod-lib.sh
# rule 6): ids and a path, with the content deliberately left in the file
# rather than the line. That is bookkeeping, not something firstmate said to
# him, so such a row is stated plainly from what is known instead.
#
# EVERY OTHER NOTE IS THE WORKER'S OWN SENTENCE AND IS SHOWN AS WRITTEN. The
# options he is being asked to choose between are the whole value of the row,
# and a path or an id in the middle of a question is a far smaller price than
# losing the question.
status_line() {  # <note> <verb> <project>
  local note=$1 verb=$2 project=$3 said
  case "$note" in
    'ask-user findings='*' file='*) ;;
    *) printf '%s\n' "$note"; return 0 ;;
  esac
  said='stopped and needs a decision from you'
  [ "$verb" = blocked ] && said='stopped and cannot go on'
  if [ -n "$project" ]; then
    printf 'A worker on %s %s.\n' "$project" "$said"
  else
    printf 'A worker %s.\n' "$said"
  fi
}

# One item object. `source` says which record it came from, because the two are
# answered through different commands and the server must not guess.
emit_item() {  # <home-id> <state-dir> <id> <source> <key> <title> <detail> <repo> <kind>
  local home=$1 state=$2 id=$3 source=$4 key=$5 title=$6 detail=$7 repo=$8 kind=$9
  local meta=$state/$id.meta project worktree listen bstate branch since since_kind sent
  project=$(meta_get "$meta" project)
  worktree=$(meta_get "$meta" worktree)
  [ -n "$kind" ] || kind=$(meta_get "$meta" kind)
  # A secondmate's project= is its HOME path, not a repo; its projects= field
  # carries the real ones. Registry data, not a path, is the honest answer.
  if [ "$(meta_get "$meta" kind)" = secondmate ]; then
    project=$(meta_get "$meta" projects)
    worktree=
  else
    project=${project##*/}
  fi
  [ -n "$project" ] || project=$repo
  IFS=$'\t' read -r bstate branch < <(branch_of "$worktree")
  if [ -f "$meta" ]; then
    listen=$(fm_busy_classify_meta "$meta" "$id" "$state" 2>/dev/null || printf 'unknown error')
  else
    listen='none no-worker'
  fi
  if [ "$source" = hold ] && [ -n "${SINCE_DATE-}" ]; then
    since=$(date -u -d "${SINCE_DATE}T00:00:00Z" +%s 2>/dev/null || printf '')
    since_kind=created
  else
    # A worker's timestamp on the line that actually opened this decision is
    # honest waiting time; the status file's mtime is only ever the LAST
    # append, which can be a much newer, unrelated line. Fall back to that
    # mtime only for a pre-timestamp log with nothing better to report.
    since=
    if [ "$source" = status ]; then
      since=$(status_key_opened_at "$state/$id.status" "$key" 2>/dev/null)
    fi
    if [ -n "$since" ]; then
      since=$(date -u -d "$since" +%s 2>/dev/null || printf '')
    fi
    if [ -n "$since" ]; then
      since_kind=status-timestamp
    else
      since=$(epoch_of "$state/$id.status")
      since_kind=status-mtime
    fi
  fi
  [ -n "$since" ] || since_kind=none
  sent=$(sent_records "$state" "$id")
  jq -cn \
    --arg home "$home" --arg id "$id" --arg source "$source" --arg key "$key" \
    --arg title "$title" --arg detail "$detail" --arg repo "$repo" --arg kind "$kind" \
    --arg project "$project" --arg worktree "$worktree" \
    --arg branch "$branch" --arg bstate "$bstate" \
    --arg listen "${listen%% *}" --arg lsource "${listen#* }" \
    --arg since "$since" --arg sincekind "$since_kind" \
    --arg until "${HOLD_UNTIL-}" --arg verb "${STATUS_VERB-}" \
    --argjson sent "$sent" \
    '{home:$home,id:$id,source:$source,key:$key,title:$title,detail:$detail,
      repo:$repo,kind:$kind,project:$project,
      worktree:(if $worktree == "" then null else $worktree end),
      branch:(if $branch == "" then null else $branch end),
      branch_state:$bstate,listen:$listen,listen_source:$lsource,
      since_epoch:(if $since == "" then null else ($since|tonumber) end),
      since_kind:$sincekind,
      deferred_until:(if $until == "" then null else $until end),
      status_verb:(if $verb == "" then null else $verb end),
      sent:$sent}'
}

scan_home() {  # <home-id> <home-name> <home-path>
  local hid=$1 hpath=$3 backlog
  local state=$hpath/state
  local id title repo kind since hold body
  local task key verb note project line

  backlog=$(backlog_path "$hpath") || backlog=
  if [ -n "$backlog" ] && [ -r "$backlog" ]; then
    while IFS=$'\037' read -r id title repo kind since hold until body; do
      [ -n "$id" ] || continue
      SINCE_DATE=$since
      HOLD_UNTIL=$until
      emit_item "$hid" "$state" "$id" hold "$id" "$title" \
        "$(printf '%s\n\n%s' "$hold" "${body//$'\036'/$'\n'}")" "$repo" "$kind"
      unset SINCE_DATE HOLD_UNTIL
    done < <(held_tasks "$backlog")
  fi

  # Open status decisions: a live worker that stopped and is waiting. These
  # never appear in the backlog as held, which is exactly why the board built
  # on captain holds alone cannot reach them.
  [ -d "$state" ] || return 0
  while IFS=$'\t' read -r task key verb note; do
    [ -n "$task" ] || continue
    project=$(meta_get "$state/$task.meta" project | sed 's#.*/##')
    line=$(status_line "$note" "$verb" "$project")
    # `blocked` and `needs-decision` both stop a worker, but they mean different
    # things to the person answering, so the verb travels with the item.
    STATUS_VERB=$verb
    emit_item "$hid" "$state" "$task" status "$key" "$line" "$line" \
      "$project" ""
    unset STATUS_VERB
  done < <(scan_open_decisions "$state")
}

command_scan() {
  local hid hname hpath backlog readable beat items produced
  # The producer is captured and CHECKED before anything is published: piping it
  # straight into `jq -cs` would turn a mid-scan failure into a well-formed but
  # SHORT list, and the page would read that as "nothing else is waiting on you".
  produced=$(
    while IFS=$'\t' read -r hid hname hpath; do
      [ -n "$hpath" ] || continue
      # Cannot be READ and does not exist YET are different facts. A backend
      # that yields no path, or a file that is there but unreadable, hides holds
      # from the captain. A markdown home whose backlog is simply absent is a
      # fresh home holding nothing, and saying otherwise is a false alarm.
      backlog=$(backlog_path "$hpath") || backlog=
      readable=false
      if [ -z "$backlog" ]; then
        readable=false
      elif [ -e "$backlog" ]; then
        [ -r "$backlog" ] && readable=true
      else
        readable=true
      fi
      beat=$(epoch_of "$hpath/state/.last-watcher-beat")
      jq -cn --arg id "$hid" --arg name "$hname" --arg path "$hpath" \
        --arg beat "$beat" --argjson readable "$readable" \
        '{_row:"home",id:$id,name:$name,path:$path,
          watcher_beat_epoch:(if $beat == "" then null else ($beat|tonumber) end),
          backlog_readable:$readable}' || exit 1
      items=$(scan_home "$hid" "$hname" "$hpath") || exit 1
      # The tag is _row, not kind: an item carries a kind of its own and the
      # collision was deleting it along with the tag.
      [ -z "$items" ] || printf '%s\n' "$items" | jq -c '. + {_row:"item"}' || exit 1
    done < <(home_records)
  ) || fail "the scan could not read every record; refusing to publish a partial list"
  printf '%s\n' "$produced" \
    | jq -cs --arg schema "$SCHEMA" --arg now "$(date -u +%Y-%m-%dT%H:%M:%SZ)" '
    {schema:$schema, generated:$now,
     homes:[.[] | select(._row == "home") | del(._row)],
     items:[.[] | select(._row == "item") | del(._row)]}'
}

case "${1-}" in
  --fingerprint) fingerprint ;;
  -h|--help|help) usage ;;
  '') command_scan ;;
  *) usage >&2; exit 2 ;;
esac
