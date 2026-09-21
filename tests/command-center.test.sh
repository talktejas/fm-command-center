#!/usr/bin/env bash
# Behavioral regressions for the command center's reading half and its HTTP
# boundary. Everything here goes through the executables: the scan script's
# JSON and the server's own endpoints, never their source bytes.
set -u

# shellcheck source=tests/lib.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

# This repo never copies or edits firstmate's own scripts: SCAN and SERVER are
# this repo's own, RECORD/BACKFILL/SWEEP/HOOK/tasks-axi/captain-hold below are
# firstmate's, read from a real (read-only) checkout at FIRSTMATE_ROOT.
FIRSTMATE_ROOT="${FM_FIRSTMATE_ROOT:-/home/tds/p/firstmate}"
SCAN="$ROOT/command-center-scan.sh"
RECORD="$FIRSTMATE_ROOT/bin/fm-captain-message.sh"
BACKFILL="$FIRSTMATE_ROOT/bin/fm-captain-message-backfill.py"
SERVER="$ROOT/command-center.py"
WORK="$ROOT/command-center-work.sh"
TASKS_AXI="$FIRSTMATE_ROOT/bin/fm-tasks-axi.sh"
CAPTAIN_HOLD="$FIRSTMATE_ROOT/bin/fm-captain-hold.sh"
TMP_ROOT=$(fm_test_tmproot command-center)

# A home whose backlog carries one live captain hold, one hold that was already
# answered, and one hold that belongs to firstmate rather than the captain.
seed_home() {  # <home>
  local home=$1
  mkdir -p "$home/data" "$home/state"
  cat > "$home/data/backlog.md" <<'EOF'
# Backlog

## Queued
- [ ] cc-live - Blue or green? (repo: demo) (kind: ship) (since 2026-09-01) (hold: The colour call) (hold-kind: captain)
  Body first paragraph.

  Body second paragraph, after a blank line.
- [ ] cc-deferred - Hosting region (repo: demo) (kind: ship) (since 2026-09-02) (hold: Deferred by the captain) (hold-kind: captain) (hold-until: 2099-01-01)
- [ ] cc-not-captain - Waiting on CI (repo: demo) (kind: ship) (since 2026-09-03) (hold: blocked on an upstream release) (hold-kind: system)
- [ ] cc-plain - Ordinary queued work (repo: demo) (kind: ship) (since 2026-09-04)

## Done
- [x] cc-answered - Already settled (repo: demo) (kind: ship) (done 2026-09-05) (hold: The colour call) (hold-kind: captain)
EOF
}

scan() {  # <home>
  FM_HOME="$1" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$SCAN"
}

test_only_live_captain_holds_are_carded() {
  local home out
  home="$TMP_ROOT/holds"
  seed_home "$home"
  out=$(scan "$home") || fail "the scan failed on a seeded home"

  assert_contains "$out" '"id":"cc-live"' \
    "an open captain hold is missing from the scan"
  assert_contains "$out" '"id":"cc-deferred"' \
    "a deferred captain hold is missing from the scan"
  assert_not_contains "$out" '"id":"cc-answered"' \
    "a closed task still carries its hold annotation and was carded again"
  assert_not_contains "$out" '"id":"cc-not-captain"' \
    "a non-captain hold was presented as the captain's to answer"
  assert_not_contains "$out" '"id":"cc-plain"' \
    "an unheld queued task was presented as waiting on the captain"
  pass "only open captain holds reach the captain's list"
}

test_body_survives_the_record_separator() {
  local home detail
  home="$TMP_ROOT/body"
  seed_home "$home"
  detail=$(scan "$home" | jq -r '.items[] | select(.id == "cc-live") | .detail')

  assert_contains "$detail" 'The colour call' \
    "the hold reason is missing from the item detail"
  assert_contains "$detail" 'Body first paragraph.' \
    "the task body is missing from the item detail"
  assert_contains "$detail" 'Body second paragraph, after a blank line.' \
    "a body paragraph after a blank line was lost"
  pass "a multi-paragraph body survives the scan intact"
}

test_deferred_hold_reports_its_date() {
  local out
  out=$(scan "$TMP_ROOT/holds")
  assert_equals "2099-01-01" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "cc-deferred") | .deferred_until')" \
    "a hold deferred to a date did not report that date"
  assert_equals "null" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "cc-live") | .deferred_until')" \
    "an undeferred hold invented a deferral date"
  pass "a deferred hold carries its date and an undeferred one carries none"
}

# project, worktree and branch are three different facts with three different
# ways of being absent, and a row that has none of them must still be honest
# rather than guessing.
test_branch_states_are_honest() {
  local home out ship scout
  home="$TMP_ROOT/branches"
  seed_home "$home"
  ship="$TMP_ROOT/ship-wt"
  scout="$TMP_ROOT/scout-wt"
  fm_git_identity
  fm_git_init_commit "$ship" >/dev/null 2>&1
  fm_git_init_commit "$scout" >/dev/null 2>&1
  git -C "$ship" checkout -q -b fm/on-a-branch
  git -C "$scout" checkout -q --detach HEAD

  printf 'needs-decision [key=k-ship]: pick one\n' > "$home/state/t-ship.status"
  printf 'needs-decision [key=k-scout]: pick one\n' > "$home/state/t-scout.status"
  printf 'worktree=%s\nproject=/somewhere/demo\nkind=ship\n' "$ship" > "$home/state/t-ship.meta"
  printf 'worktree=%s\nproject=/somewhere/demo\nkind=scout\n' "$scout" > "$home/state/t-scout.meta"

  out=$(scan "$home")
  assert_equals "branch" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-ship") | .branch_state')" \
    "a worker on a real branch was not reported as on a branch"
  assert_equals "fm/on-a-branch" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-ship") | .branch')" \
    "the branch name was not read from the worktree"
  assert_equals "detached" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-scout") | .branch_state')" \
    "a detached scratch copy was not reported as detached"
  assert_equals "null" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-scout") | .branch')" \
    "a detached copy invented a branch name"
  assert_equals "not-started" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "cc-live") | .branch_state')" \
    "a hold nobody has started claimed a branch state it cannot have"
  pass "branch, detached and not-started are each reported for what they are"
}

# A status decision is a stopped worker; it never appears in the backlog as
# held, which is exactly why a surface built on captain holds alone misses it.
test_status_decisions_are_carded_with_their_verb() {
  local home out
  home="$TMP_ROOT/status"
  mkdir -p "$home/data" "$home/state"
  printf '# Backlog\n' > "$home/data/backlog.md"
  printf 'working: started\nblocked [key=k-stuck]: the pipeline is down\n' \
    > "$home/state/t-blocked.status"
  printf 'needs-decision [key=k-ask]: which shape\nresolved [key=k-ask]: settled\n' \
    > "$home/state/t-resolved.status"

  out=$(scan "$home")
  assert_contains "$out" '"id":"t-blocked"' \
    "an open blocker was missing from the scan"
  assert_equals "blocked" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-blocked") | .status_verb')" \
    "the status verb did not travel with the item"
  assert_not_contains "$out" '"id":"t-resolved"' \
    "a decision closed by its own resolved line was still presented as open"
  pass "open status decisions are carded and resolved ones are not"
}

# A status decision's honest "since" is the moment the worker's own line
# opened it, not the status file's mtime, which only ever reflects the LAST
# append - a much newer, unrelated line routinely follows the one that
# actually matters. A pre-timestamp log has nothing better than that mtime,
# and must still say so plainly through since_kind rather than pretending to
# know the real moment.
test_status_decision_since_prefers_the_opening_line_timestamp() {
  local home out
  home="$TMP_ROOT/since-kind"
  mkdir -p "$home/data" "$home/state"
  printf '# Backlog\n' > "$home/data/backlog.md"
  printf 'needs-decision [key=k-ts]: [2026-01-01T00:00:00Z] pick REST or RPC\nworking: [2026-01-01T01:00:00Z] still thinking\n' \
    > "$home/state/t-ts.status"
  printf 'needs-decision [key=k-legacy]: pick a colour\n' \
    > "$home/state/t-legacy.status"

  out=$(scan "$home")
  assert_equals "status-timestamp" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-ts") | .since_kind')" \
    "a timestamped opening line was not preferred over the file's later mtime"
  assert_equals "1767225600" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-ts") | .since_epoch')" \
    "the reported since_epoch did not match the opening line's own timestamp"
  assert_equals "status-mtime" \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-legacy") | .since_kind')" \
    "a pre-timestamp status line was not reported as falling back to file mtime"
  pass "a timestamped opening line beats the status file's mtime; a legacy line still falls back honestly"
}

# Delivered and picked up are different facts with different proofs. The move
# into handled/ IS the acknowledgement, and nothing may be reported between them.
test_steering_records_report_delivered_and_picked_up() {
  local home out
  home="$TMP_ROOT/sent"
  mkdir -p "$home/data" "$home/state/t-sent.inbox/handled"
  printf '# Backlog\n' > "$home/data/backlog.md"
  printf 'blocked [key=k]: waiting\n' > "$home/state/t-sent.status"
  printf 'schema=fm-task-inbox.v1\nat=2026-09-01T10:00:00Z\n--\nfirst answer\n' \
    > "$home/state/t-sent.inbox/handled/001.msg"
  printf 'schema=fm-task-inbox.v1\nat=2026-09-01T11:00:00Z\n--\nsecond answer\n' \
    > "$home/state/t-sent.inbox/002.msg"

  out=$(printf '%s' "$(scan "$home")" | jq -c '.items[] | select(.id == "t-sent") | .sent')
  assert_contains "$out" '"seq":"001"' "an acknowledged steering record was dropped"
  assert_contains "$out" '"seq":"002"' "an unacknowledged steering record was dropped"
  assert_contains "$out" '"text":"first answer"' "the captain's words were lost from the record"
  assert_equals "true" \
    "$(printf '%s' "$out" | jq -r '.[] | select(.seq == "001") | .handled')" \
    "a record moved into handled/ was not reported as picked up"
  assert_equals "false" \
    "$(printf '%s' "$out" | jq -r '.[] | select(.seq == "002") | .handled')" \
    "a record still in the inbox was reported as picked up"
  pass "a steering record reports delivered and picked up from the acknowledgement move"
}

# A title is the captain's own words: the parser strips the annotations the
# backlog format defines and nothing else.
test_a_title_keeps_a_trailing_parenthetical() {
  local home out
  home="$TMP_ROOT/paren"
  mkdir -p "$home/data" "$home/state"
  {
    printf '# Backlog\n'
    printf -- '- [ ] t-9 - Pick the hosting region (eu or us) (repo: demo) (hold: which one) (hold-kind: captain)\n'
  } > "$home/data/backlog.md"

  out=$(printf '%s' "$(scan "$home")" | jq -r '.items[] | select(.id == "t-9") | .title')
  assert_equals "Pick the hosting region (eu or us)" "$out" \
    "a parenthetical that is part of the title was eaten as an annotation"
  assert_equals "demo" \
    "$(printf '%s' "$(scan "$home")" | jq -r '.items[] | select(.id == "t-9") | .repo')" \
    "the real annotations stopped being read"
  pass "a title keeps a trailing parenthetical that is part of it"
}

# A short list is the worst thing this surface can publish: the page reads it as
# "nothing else is waiting on you". A scan that cannot read everything must fail.
test_a_scan_that_cannot_read_everything_fails_instead_of_truncating() {
  local home shim realjq out rc
  home="$TMP_ROOT/partial"
  seed_home "$home"
  shim="$TMP_ROOT/shim"
  mkdir -p "$shim"
  realjq=$(command -v jq) || fail "jq is required for this test"
  # Fail the stage that assembles one scanned item, and only that one: the
  # producer keeps going and the list comes out short unless the scan checks.
  cat > "$shim/jq" <<EOF
#!/usr/bin/env bash
case " \$* " in *'_row:"item"'*) exit 1 ;; esac
exec "$realjq" "\$@"
EOF
  chmod +x "$shim/jq"
  rc=0
  out=$(PATH="$shim:$PATH" FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$SCAN" 2>/dev/null) || rc=$?
  [ "$rc" -ne 0 ] || fail "a scan that could not read every record exited 0"
  assert_not_contains "$out" '"items"' \
    "a partial list was published as if it were the whole one"
  pass "a scan that cannot read everything fails instead of truncating"
}

# The page exists to show him only what is actually his. tasks-axi makes --kind
# optional on a hold, so an absent hold kind is firstmate's own parked or future
# hold - and a send against one is refused by fm-captain-hold.sh anyway.
test_only_captain_kind_holds_are_his_to_answer() {
  local home out
  home="$TMP_ROOT/holdkind"
  mkdir -p "$home/data" "$home/state"
  {
    printf '# Backlog\n'
    printf -- '- [ ] hk-captain - Which palette? (repo: demo) (kind: captain) (hold: pick one) (hold-kind: captain)\n'
    printf -- '- [ ] hk-none - Start after launch (repo: demo) (kind: ship) (hold: not yet)\n'
    printf -- '- [ ] hk-parked - Waiting on the vendor (repo: demo) (kind: ship) (hold: vendor) (hold-kind: parked)\n'
  } > "$home/data/backlog.md"

  out=$(printf '%s' "$(scan "$home")" | jq -r '[.items[].id] | sort | join(",")')
  assert_equals "hk-captain" "$out" \
    "the captain's list carried a hold that is not his to answer"
  pass "only a hold marked for the captain reaches his list"
}

# A home on a non-markdown backend holds no readable backlog, so its captain
# calls are simply absent from the list. Short is not empty, and the page can
# only say so if the scan reports the difference.
test_an_unreadable_backlog_is_reported_not_shown_as_empty() {
  local home root out
  home="$TMP_ROOT/beads"
  seed_home "$home"
  root="$TMP_ROOT/beads-root"
  mkdir -p "$root"
  printf '[markdown]\npath = "data/backlog.md"\n\n[backend]\nbackend = "beads"\n' \
    > "$root/.tasks.toml"

  out=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$root" "$SCAN")
  assert_equals "false" \
    "$(printf '%s' "$out" | jq -r '.homes[] | select(.id == "main") | .backlog_readable')" \
    "a home whose backlog could not be read was not reported as unreadable"
  assert_equals "0" "$(printf '%s' "$out" | jq -r '[.items[] | select(.source == "hold")] | length')" \
    "the fixture no longer proves the held rows go missing when the backlog is unreadable"

  # A backlog that is there but cannot be opened hides holds just the same.
  if [ "$(id -u)" != 0 ]; then
    chmod 000 "$home/data/backlog.md"
    out=$(scan "$home")
    chmod 600 "$home/data/backlog.md"
    assert_equals "false" \
      "$(printf '%s' "$out" | jq -r '.homes[] | select(.id == "main") | .backlog_readable')" \
      "a backlog present but unopenable was reported as readable"
  fi
  pass "an unreadable backlog is reported rather than shown as empty"
}

# A home that simply has no backlog file yet holds nothing, and saying its holds
# are missing would be the same false claim pointing the other way.
test_a_home_with_no_backlog_yet_is_empty_not_unreadable() {
  local home out
  home="$TMP_ROOT/fresh"
  mkdir -p "$home/state"

  out=$(scan "$home")
  assert_equals "true" \
    "$(printf '%s' "$out" | jq -r '.homes[] | select(.id == "main") | .backlog_readable')" \
    "a fresh home with no backlog file yet was reported as unreadable"
  assert_equals "0" "$(printf '%s' "$out" | jq -r '.items | length')" \
    "a home holding nothing reported items"
  pass "a home with no backlog yet is empty rather than unreadable"
}

test_fingerprint_changes_only_when_a_record_moves() {
  local home first second third
  home="$TMP_ROOT/fingerprint"
  seed_home "$home"
  first=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$SCAN" --fingerprint)
  second=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$SCAN" --fingerprint)
  assert_equals "$first" "$second" \
    "the change check reported a change when nothing moved"
  printf 'blocked [key=k]: something happened\n' > "$home/state/t-new.status"
  third=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$SCAN" --fingerprint)
  assert_not_equals "$first" "$third" \
    "the change check missed a new status record"
  pass "the change check is stable when idle and notices a moved record"
}

# The Work tab's own reading half: the firstmate root's real
# bin/fm-bearings-snapshot.sh, projected into the four sections
# bin/fm-bearings-board.sh words, over this repo's own (empty) home.
test_work_scan_reports_the_four_bearings_sections() {
  local home out
  home="$TMP_ROOT/work"
  seed_home "$home"
  out=$(FM_HOME="$home" FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" timeout 90 "$WORK") \
    || fail "the work scan did not run"
  assert_equals "fm-command-center-work.v1" "$(jq -r '.schema' <<<"$out")" \
    "the work scan reported the wrong schema"
  assert_equals "null" "$(jq -c '.error' <<<"$out")" \
    "a scan that read the fleet reported an error anyway"
  for key in captains_call underway landed charted omitted; do
    jq -e ".$key | type == \"array\"" <<<"$out" >/dev/null \
      || fail "the work scan's .$key was not an array"
  done
  pass "the work scan reports the four bearings sections as arrays, unchanged in wording"
}

# A row for a task this home actually owns carries its project, worktree and
# branch the same way command-center-scan.sh's own items do - read from the
# task's own meta, never guessed.
test_work_scan_names_a_local_tasks_context() {
  local home out worktree
  home="$TMP_ROOT/work-context"
  mkdir -p "$home/state" "$home/data"
  worktree="$TMP_ROOT/work-context-tree"
  fm_git_init_commit "$worktree"
  git -C "$worktree" checkout -q -b my-branch
  cat > "$home/state/cc-work-demo.meta" <<EOF
project=demo
worktree=$worktree
kind=ship
EOF
  cat > "$home/data/backlog.md" <<'EOF'
# Backlog

## Queued
- [ ] cc-work-demo - A captain's call the work board must show (repo: demo) (kind: ship) (since 2026-09-10) (hold: Pick one) (hold-kind: captain)
EOF
  out=$(FM_HOME="$home" FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" timeout 90 "$WORK") \
    || fail "the work scan did not run"
  local row
  row=$(jq -c '.captains_call[] | select(.id == "cc-work-demo")' <<<"$out")
  [ -n "$row" ] || fail "the work board did not carry this home's own captain's call"
  assert_equals "demo" "$(jq -r '.project' <<<"$row")" \
    "the work board did not name the task's project"
  assert_equals "$worktree" "$(jq -r '.worktree' <<<"$row")" \
    "the work board did not name the task's worktree"
  assert_equals "my-branch" "$(jq -r '.branch' <<<"$row")" \
    "the work board did not read the task's own branch"
  pass "a work row for a task this home owns carries its project, worktree and branch"
}

# --- HTTP boundary -----------------------------------------------------------
# Sets SERVER_PORT and SERVER_PID in the CALLER's shell. It must not be used in
# a command substitution: that runs in a subshell, the pid never comes back, and
# every test leaks a live server.
start_server() {  # <home>
  local home=$1
  SERVER_PORT=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" python3 "$SERVER" --port "$SERVER_PORT" --home "$home" \
    > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  for _ in $(seq 1 60); do
    curl -sf -m 2 -o /dev/null "http://127.0.0.1:$SERVER_PORT/" && return 0
    kill -0 "$SERVER_PID" 2>/dev/null || return 1
    sleep 1
  done
  return 1
}

stop_server() {
  [ -n "${SERVER_PID:-}" ] || return 0
  kill "$SERVER_PID" 2>/dev/null || true
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=
}

post() {  # <port> <path> <json>
  curl -s -X POST -H 'Content-Type: application/json' -d "$3" \
    "http://127.0.0.1:$1$2"
}

# The click does not wait on a shell command: the server records his words and
# answers at once, then writes the outcome as an amendment naming that sid.
# The page folds the pair and shows the outcome in place, and so do these tests.
wait_outcome() {  # <home> <sid>  -> the outcome record row on stdout
  local home=$1 sid=$2 row
  for _ in $(seq 1 160); do
    row=$(jq -c --arg s "$sid" 'select(.of == $s and .outcome != "sending")' \
      "$home/data/command-center/said.jsonl" 2>/dev/null | tail -1)
    [ -n "$row" ] && { printf '%s\n' "$row"; return 0; }
    sleep 0.25
  done
  return 1
}

# A send is accepted the moment the words are durable and delivers behind the
# acceptance, so anything delivery writes is waited for, never asserted at once.
wait_for() {  # <failure message> <cmd...>
  local msg=$1 i=0
  shift
  while [ "$i" -lt 60 ]; do
    "$@" >/dev/null 2>&1 && return 0
    sleep 0.5
    i=$((i + 1))
  done
  fail "$msg"
}

said_has() {  # <port> <jq filter that must be non-empty>
  curl -s -m 10 "http://127.0.0.1:$1/api/said" \
    | jq -e "[.said[] | select($2)] | length > 0"
}

test_server_serves_the_page_and_the_records() {
  local home port body
  home="$TMP_ROOT/http"
  seed_home "$home"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT

  body=$(curl -s "http://127.0.0.1:$port/")
  assert_contains "$body" '<title>Firstmate Command Center</title>' \
    "the page was not served at the root address"
  body=$(curl -s -m 120 "http://127.0.0.1:$port/api/items")
  assert_contains "$body" '"id":"cc-live"' \
    "the records endpoint did not carry the waiting item"
  assert_equals "304" \
    "$(curl -s -o /dev/null -w '%{http_code}' \
        -H "If-None-Match: $(curl -sI -m 120 "http://127.0.0.1:$port/api/items" \
          | awk 'tolower($1)=="etag:"{gsub(/\r/,"");print $2}')" \
        "http://127.0.0.1:$port/api/items")" \
    "an unchanged poll re-sent the whole view instead of answering 304"
  stop_server
  pass "the page and the records are served, and an unchanged poll costs nothing"
}

test_the_work_board_is_served() {
  local home port body
  home="$TMP_ROOT/http-work"
  seed_home "$home"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(curl -s -m 90 "http://127.0.0.1:$port/api/work")
  assert_equals "fm-command-center-work.v1" "$(jq -r '.schema' <<<"$body")" \
    "the work board endpoint did not carry the bearings work schema"
  assert_contains "$body" '"id":"cc-live"' \
    "the work board did not carry this home's own captain's call"
  stop_server
  pass "the work board is served over its own endpoint"
}

# Send one refused cross-site POST whose body is itself a complete, innocent-
# looking request, then count the notes firstmate actually received. A server
# that answers the refusal without draining the body parses that body as the
# next request on the same connection.
smuggle_notes() {  # <port> <home>
  local port=$1 home=$2 inner smuggled
  inner=$(printf 'POST /api/note HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nContent-Type: application/json\r\nContent-Length: 24\r\n\r\n{"text":"smuggled note"}' "$port")
  smuggled=$(printf 'POST /api/note HTTP/1.1\r\nHost: 127.0.0.1:%s\r\nOrigin: http://evil.example\r\nContent-Type: text/plain\r\nContent-Length: %s\r\n\r\n%s' \
    "$port" "${#inner}" "$inner")
  printf '%s' "$smuggled" | timeout 10 python3 -c '
import socket, sys
data = sys.stdin.buffer.read()
s = socket.create_connection(("127.0.0.1", int(sys.argv[1])), 5)
s.sendall(data)
s.settimeout(3)
try:
    while s.recv(65536):
        pass
except OSError:
    pass
s.close()
' "$port" >/dev/null 2>&1 || true
  grep -rl 'smuggled note' "$home" 2>/dev/null | wc -l | tr -d ' '
}

# When no scan has ever published, there is no list AND the server refuses
# sends. The page says so as its own state; this pins the half it derives from.
test_a_server_with_no_scan_yet_refuses_both_the_list_and_a_send() {
  local home shim realjq port
  home="$TMP_ROOT/never-scanned"
  seed_home "$home"
  shim="$TMP_ROOT/never-shim"
  mkdir -p "$shim"
  realjq=$(command -v jq) || fail "jq is required for this test"
  cat > "$shim/jq" <<EOF
#!/usr/bin/env bash
case " \$* " in *'_row:"item"'*) exit 1 ;; esac
exec "$realjq" "\$@"
EOF
  chmod +x "$shim/jq"

  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  PATH="$shim:$PATH" FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" python3 "$SERVER" \
    --port "$port" --home "$home" > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  local ready=
  for _ in $(seq 1 60); do
    curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$ready" ] || fail "the server did not start"

  assert_equals "503" \
    "$(curl -s -m 120 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$port/api/items")" \
    "a server that has never published a scan served a list anyway"
  assert_equals "503" \
    "$(curl -s -m 120 -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        -d '{"home":"main","id":"cc-live","source":"hold","key":"cc-live","text":"Green."}' \
        "http://127.0.0.1:$port/api/answer")" \
    "a server that has never published a scan accepted a send"
  stop_server
  pass "a server with no scan yet refuses both the list and a send"
}

# The one free-text field reaches firstmate's own scripts, so it is checked
# before anything is run, and an unknown item can never select a command.
test_server_refuses_bad_input_before_running_anything() {
  local home port
  home="$TMP_ROOT/guard"
  seed_home "$home"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT

  assert_contains "$(post "$port" /api/answer '{"home":"main","id":"cc-live","source":"hold","key":"cc-live","text":"   "}')" \
    'an empty answer is not an answer' "an empty answer was accepted"
  assert_contains "$(post "$port" /api/answer '{"home":"main","id":"../../etc/passwd","source":"hold","text":"x"}')" \
    '"ok":false' "a traversal-shaped task id was not refused"
  assert_contains "$(post "$port" /api/answer '{"home":"main","id":"cc-nonexistent","source":"hold","key":"cc-nonexistent","text":"x"}')" \
    'no longer waiting for you' "an unknown item was not refused"
  assert_contains "$(post "$port" /api/answer \
      "{\"home\":\"main\",\"id\":\"cc-live\",\"source\":\"hold\",\"key\":\"cc-live\",\"text\":\"$(head -c 9000 /dev/zero | tr '\0' 'a')\"}")" \
    '8192 bytes' "an oversize answer was not refused at the recorded-decision limit"
  assert_equals "400" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST -H 'Content-Type: application/json' \
        -d 'not json' "http://127.0.0.1:$port/api/answer")" \
    "an unreadable request body was not refused"
  # The trust boundary is loopback, so a page the captain happens to have open
  # must not be able to steer a worker as him. Each signal is refused on its
  # own, so no one guard can be dropped behind the others.
  local body='{"home":"main","id":"cc-live","source":"hold","key":"cc-live","text":"x"}'
  assert_equals "403" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: text/plain' -d "$body" \
        "http://127.0.0.1:$port/api/answer")" \
    "a form-submittable content type reached a firstmate command"
  assert_equals "403" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' -H 'Origin: http://evil.example' \
        -d "$body" "http://127.0.0.1:$port/api/answer")" \
    "a foreign Origin reached a firstmate command"
  assert_equals "403" \
    "$(curl -s -o /dev/null -w '%{http_code}' -X POST \
        -H 'Content-Type: application/json' -H 'Sec-Fetch-Site: cross-site' \
        -d "$body" "http://127.0.0.1:$port/api/answer")" \
    "a cross-site fetch reached a firstmate command"
  # A refused request must leave nothing on the kept-alive connection for the
  # next one to be read out of: the note here is smuggled behind the refusal.
  assert_equals "0" "$(smuggle_notes "$port" "$home")" \
    "a request smuggled behind a refused one reached firstmate"
  assert_equals "403" \
    "$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: attacker.example' \
        "http://127.0.0.1:$port/api/items")" \
    "a rebound hostname could read the records"
  stop_server
  pass "bad input is refused before any firstmate command runs"
}

# The whole point of the surface: his words reach the durable record, and the
# one thing firstmate does not keep is kept here.
test_answering_a_hold_records_the_captains_words_and_clears_the_item() {
  local home port result resolved
  home="$TMP_ROOT/answer"
  mkdir -p "$home/data" "$home/state"
  FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" \
    "$TASKS_AXI" add cc-answer "Blue or green?" --kind captain --repo demo \
    >/dev/null 2>"$TMP_ROOT/axi.err" \
    || fail "tasks-axi could not add the fixture task, so this test never ran: $(cat "$TMP_ROOT/axi.err")"
  FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" \
    "$CAPTAIN_HOLD" hold cc-answer --reason "The colour call" \
    >/dev/null 2>"$TMP_ROOT/axi.err" \
    || fail "the fixture task could not be held for the captain: $(cat "$TMP_ROOT/axi.err")"

  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  result=$(post "$port" /api/answer \
    '{"home":"main","id":"cc-answer","source":"hold","key":"cc-answer","text":"Green. Blue reads as disabled."}')
  # The send is accepted the moment his words are durable; delivery runs behind.
  assert_contains "$result" '"ok":true' "the answer was not accepted"
  assert_contains "$result" '"outcome":"sending"' \
    "the acceptance did not say delivery was still running"
  assert_grep 'Green. Blue reads as disabled.' \
    "$home/data/command-center/said.jsonl" \
    "the words were not durable by the time the send was accepted"
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$result")") \
    || fail "the outcome of the send never reached the record"
  assert_contains "$resolved" '"outcome":"sent"' "the answer was not delivered"
  assert_contains "$resolved" 'fm-captain-hold.sh answer' \
    "a held decision was not answered through the script that owns decision records"

  wait_for "the captain's exact words never reached the durable task record" \
    grep -q 'Green. Blue reads as disabled.' "$home/data/backlog.md"
  # The page's "you last sent … — …" line is derived from this record alone, so
  # it has to carry the item, his exact words, the outcome, which route ran, and
  # whether that act closed the task or lifted its hold.
  wait_for "the outcome never landed on the record of what he said" \
    said_has "$port" '.item == "cc-answer" and .outcome == "sent"'
  assert_equals "main/hold/cc-answer/cc-answer|Green. Blue reads as disabled.|sent|hold|close|fm-captain-hold.sh answer cc-answer" \
    "$(curl -s -m 30 "http://127.0.0.1:$port/api/said" \
        | jq -r '[.said[] | select(.item == "cc-answer")][0]
                 | [.item_key, .text, .outcome, .source, .mode, .route] | join("|")')" \
    "the record the item line is derived from did not carry what he sent, what became of it, and the script that owns decision records"
  wait_for "an answered decision stayed in the waiting list" \
    bash -c "! curl -s -m 120 'http://127.0.0.1:$port/api/items' | grep -q '\"id\":\"cc-answer\"'"
  stop_server
  pass "an accepted answer reaches the task record, the captain's log, and leaves the list"
}

# A question held for the captain IS the task, so answering it closes the task.
# Work held pending his answer is not: answering it must lift the hold so the
# work resumes, because marking unstarted work complete cannot be undone.
test_answering_held_work_releases_it_instead_of_closing_it() {
  local home port shown result
  home="$TMP_ROOT/release"
  mkdir -p "$home/data" "$home/state"
  FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" \
    "$TASKS_AXI" add cc-work "Ship the palette" --kind ship --repo demo \
    >/dev/null 2>"$TMP_ROOT/axi.err" \
    || fail "tasks-axi could not add the fixture task, so this test never ran: $(cat "$TMP_ROOT/axi.err")"
  FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" \
    "$CAPTAIN_HOLD" hold cc-work --reason "Which palette?" \
    >/dev/null 2>"$TMP_ROOT/axi.err" \
    || fail "the fixture work item could not be held for the captain: $(cat "$TMP_ROOT/axi.err")"

  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  result=$(post "$port" /api/answer \
    '{"home":"main","id":"cc-work","source":"hold","key":"cc-work","text":"Go with green."}')
  assert_contains "$result" '"ok":true' "held work could not be answered"
  wait_outcome "$home" "$(jq -r .sid <<<"$result")" >/dev/null \
    || fail "the outcome of the send never reached the record"
  wait_for "answering held work was not recorded as lifting its hold" \
    said_has "$port" '.item == "cc-work" and .mode == "release" and .outcome == "sent"'
  stop_server

  shown=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" \
    "$TASKS_AXI" show cc-work --full 2>/dev/null)
  assert_not_contains "$shown" 'state: done' \
    "answering work held pending his answer marked that work complete"
  assert_grep 'Go with green.' "$home/data/backlog.md" \
    "the captain's exact words did not reach the durable task record"
  pass "answering held work lifts its hold and never marks the work done"
}

# Closing real work as done is not a guess worth making - but his words must
# still reach firstmate. deliver_certainly (bin/command-center.py) writes the
# guaranteed inbox note before it ever tries the row's own keyed decision
# route, so a row that cannot be classified never comes back as "not sent":
# the bonus refusal is folded into the detail of a send that landed.
test_a_held_row_with_no_kind_still_reaches_firstmate_as_a_note() {
  local home port result resolved
  home="$TMP_ROOT/nokind"
  mkdir -p "$home/data" "$home/state"
  {
    printf '# Backlog\n'
    printf -- '- [ ] cc-bare - Which palette? (repo: demo) (hold: pick one) (hold-kind: captain)\n'
  } > "$home/data/backlog.md"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  result=$(post "$port" /api/answer \
    '{"home":"main","id":"cc-bare","source":"hold","key":"cc-bare","text":"Green."}')
  assert_contains "$result" '"outcome":"sending"' \
    "the send did not return the moment his words were durable"
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$result")") \
    || fail "the outcome of the send never reached the record"
  stop_server
  assert_contains "$resolved" '"outcome":"sent"' \
    "the guaranteed note did not land, so a row that cannot be classified read as not sent"
  assert_contains "$resolved" 'cannot tell a question from work' \
    "the bonus route's refusal was not explained on the record"
  assert_not_contains "$(cat "$home/data/backlog.md")" 'Green.' \
    "a row that cannot be classified was filed as a decision anyway"
  assert_contains "$(cat "$home"/state/inbox/*.note 2>/dev/null)" 'Green.' \
    "his words never reached firstmate's own inbox"
  pass "a held row with no kind still reaches firstmate as a note, never as a lost answer"
}

# The page clears his box the moment a send is accepted, so "accepted" has to
# mean the words are on disk. If they are not, he must keep them.
test_a_send_whose_words_cannot_be_recorded_is_refused() {
  local home port result
  if [ "$(id -u)" = 0 ]; then
    pass "running as root; an unwritable log cannot be staged"
    return
  fi
  home="$TMP_ROOT/nolog"
  mkdir -p "$home/data" "$home/state"
  {
    printf '# Backlog\n'
    printf -- '- [ ] cc-nolog - Which palette? (repo: demo) (kind: captain) (hold: pick one) (hold-kind: captain)\n'
  } > "$home/data/backlog.md"
  mkdir -p "$home/data/command-center"
  : > "$home/data/command-center/said.jsonl"
  chmod 400 "$home/data/command-center/said.jsonl"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  result=$(post "$port" /api/answer \
    '{"home":"main","id":"cc-nolog","source":"hold","key":"cc-nolog","text":"Green."}')
  stop_server
  chmod 600 "$home/data/command-center/said.jsonl"
  assert_contains "$result" '"ok":false' \
    "a send was accepted although what he typed reached no record"
  assert_contains "$result" 'could not be recorded' \
    "the refusal did not say his words were not recorded"
  assert_not_contains "$(cat "$home/data/backlog.md")" 'Green.' \
    "words that were never recorded were delivered anyway"
  pass "a send whose words cannot be recorded is refused, so he keeps them"
}

# A firstmate script that reads stdin must not be able to block the server on
# whatever terminal it was started in. "-" is fm-inbox.sh's read-from-stdin
# argument, so this server is started with a stdin that stays open and silent.
test_a_note_of_just_a_dash_is_queued_and_never_hangs_the_server() {
  local home port body
  home="$TMP_ROOT/stdin"
  seed_home "$home"
  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  # stdin is held open and silent, the way a foreground terminal is: a child
  # that reads it must not be able to block the server.
  sleep 45 | FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" python3 "$SERVER" --port "$port" --home "$home" \
    > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  local ready=
  for _ in $(seq 1 60); do
    curl -sf -m 2 -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$ready" ] || fail "the server did not start"
  # "-" is fm-inbox.sh's own read-from-stdin selector. As the captain's note it
  # is just a note, and it must reach the inbox like any other.
  body=$(curl -s -m 15 -X POST -H 'Content-Type: application/json' \
    -d '{"text":"-"}' "http://127.0.0.1:$port/api/note")
  [ -n "$body" ] || fail "the note endpoint never answered: a child read the server's stdin"
  # Like every other send here: accepted the moment his words are durable,
  # delivered behind it, and the outcome lands on the record.
  assert_contains "$body" '"outcome":"sending"' \
    "the note did not return the moment his words were durable"
  assert_equals 1 "$(python3 - "$home/data/command-center/said.jsonl" <<'PYEOF'
import json, sys
print(sum(1 for line in open(sys.argv[1], encoding="utf-8")
          if json.loads(line).get("kind") == "note"))
PYEOF
)" "the note was accepted before his words were on disk"
  wait_for "the note never reached the inbox" \
    bash -c "[ -n \"\$(cat '$home'/state/inbox/*.note 2>/dev/null)\" ]"
  assert_contains "$(wait_outcome "$home" "$(jq -r .sid <<<"$body")")" '"outcome":"sent"' \
    "a note of exactly a dash was not reported as queued"
  assert_equals "-" \
    "$(cat "$home"/state/inbox/*.note 2>/dev/null | sed -n '/^--$/,$p' | tail -n +2)" \
    "a note of exactly a dash never reached the inbox"
  stop_server
  pass "a note of exactly a dash is queued, and no child can hang the server"
}

# The log is the sole surviving copy of his steers and notes. A log that cannot
# be READ is not a log with nothing in it, and must not read as one.
test_an_unreadable_log_is_reported_not_shown_as_empty() {
  local home port body
  if [ "$(id -u)" = 0 ]; then
    pass "running as root; the unreadable-log case cannot be staged"
    return
  fi
  home="$TMP_ROOT/logread"
  seed_home "$home"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  post "$port" /api/note '{"text":"a note worth keeping"}' >/dev/null
  assert_contains "$(curl -s -m 30 "http://127.0.0.1:$port/api/said")" \
    'a note worth keeping' "the note never reached the readable record"
  chmod 000 "$home/data/command-center/said.jsonl"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/said")
  chmod 600 "$home/data/command-center/said.jsonl"
  stop_server
  assert_contains "$body" 'could not be read' \
    "an unreadable record was served as an empty one"
  pass "an unreadable record is reported rather than shown as empty"
}


# fm-send.sh's exit 3 means the text WAS delivered and only the read-back stayed
# unconfirmed; its own message forbids a blind resend. Reporting that as a
# failure is how the captain sends the same steer twice.
test_the_send_outcome_is_decided_by_the_exit_code_alone() {
  local home out
  home="$TMP_ROOT/unconfirmed"
  seed_home "$home"
  out=$(FM_CC_HOME="$home" python3 - "$SERVER" <<'PYEOF'
import importlib.util, subprocess, sys, os
spec = importlib.util.spec_from_file_location("cc", sys.argv[1])
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)
status_item = {"source": "status", "id": "t-1", "key": "k"}
# A captain hold is a local record write with no delivery plane, and its script
# documents an exact retry as idempotent: a refusal there is a plain failure.
hold_item = {"source": "hold", "id": "t-1", "key": "t-1", "kind": "captain"}
# fm-send.sh echoes its own argv back on the remote leg, so this output can
# carry the captain's answer verbatim. The same prose under a different exit
# code must never move the verdict, in either direction.
quotes_him = ("error: steer to remote secondmate box is unconfirmed (transport lost "
              "twice). Resend: FM_HOME=/h fm-send.sh t-1 'the build status is "
              "unconfirmed (see CI)'")
cases = [
    (status_item, 0, quotes_him),
    (status_item, 0, ""),
    (status_item, 3, ""),
    (status_item, 1, quotes_him),
    (status_item, 1, "error: no such task"),
    (hold_item, 0, ""),
    (hold_item, 1, "error: that task is no longer held"),
    (hold_item, 2, "error: mode mismatch"),
]
real = subprocess.run
for item, rc, err in cases:
    subprocess.run = lambda *a, rc=rc, err=err, **k: subprocess.CompletedProcess(
        a[0] if a else [], rc, "", err)
    print(cc.send_answer(os.environ["FM_CC_HOME"], item, "answer text")[0])
# A killed child asks the same question, so each route answers it its own way.
def killed(*a, **k):
    raise subprocess.TimeoutExpired(a[0] if a else [], 120)
for item in (status_item, hold_item):
    subprocess.run = killed
    outcome, route = cc.send_answer(os.environ["FM_CC_HOME"], item, "answer text")[:2]
    print(outcome, route)
# fm-inbox.sh publishes the note record before it wakes firstmate, so a nonzero
# exit there cannot mean nothing was saved.
for rc in (0, 1):
    subprocess.run = lambda *a, rc=rc, **k: subprocess.CompletedProcess(
        a[0] if a else [], rc, "",
        "fm-inbox: note n-1 is saved at /h/inbox/n-1.note but firstmate was NOT woken")
    print(cc.send_note(os.environ["FM_CC_HOME"], "a note")[0])
subprocess.run = real
PYEOF
)
  assert_equals "sent
sent
unknown
unknown
unknown
sent
failed
failed
unknown fm-send.sh t-1
failed fm-captain-hold.sh answer t-1
sent
unknown" "$out" \
    "the outcome or route was not taken from the route that actually ran"
  pass "each route's outcome is decided by its own exit code alone"
}

# The module header promises the expensive scan runs once per actual change
# however many tabs are open. Every tab is its own thread, so that is a promise
# about concurrency, not about the rate guard alone.
test_concurrent_polls_produce_one_scan() {
  local home out
  home="$TMP_ROOT/herd"
  seed_home "$home"
  out=$(python3 - "$SERVER" "$home" <<'PYEOF'
import importlib.util, subprocess, sys, threading, time
spec = importlib.util.spec_from_file_location("cc", sys.argv[1])
cc = importlib.util.module_from_spec(spec)
spec.loader.exec_module(cc)
records = cc.Records(sys.argv[2])
runs = []
lock = threading.Lock()

def slow_run(args, timeout):
    with lock:
        runs.append(args[-1])
    time.sleep(0.4)
    if args[-1] == "--fingerprint":
        return subprocess.CompletedProcess(args, 0, "fingerprint\n", "")
    return subprocess.CompletedProcess(args, 0, '{"homes":[],"items":[]}', "")

records._run = slow_run
threads = [threading.Thread(target=records.refresh) for _ in range(8)]
for t in threads: t.start()
for t in threads: t.join()
print(runs.count("--fingerprint"))
print(len(records.snapshot()[0] or "") > 0)
PYEOF
)
  assert_equals "1
True" "$out" \
    "eight concurrent polls each launched their own scan"
  pass "one change produces one scan however many tabs poll"
}

# The page loads its decision rules as a second request, so that request is part
# of the page working at all. Serve them, and serve rules that actually decide.
test_the_server_serves_the_pages_decision_rules() {
  local home port body
  home="$TMP_ROOT/rules"
  seed_home "$home"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  assert_equals "200" \
    "$(curl -s -o "$TMP_ROOT/rules.js" -w '%{http_code}' \
        "http://127.0.0.1:$port/command-center-state.js")" \
    "the page's decision rules were not served"
  stop_server

  body=$(node -e '
    const r = require(process.argv[1]);
    const facts = r.pollFacts({kind:"unchanged"}, 42);
    process.stdout.write([facts.confirmed, facts.readAt, facts.offline,
      r.transportFailure("hold", "x").outcome === undefined].map(String).join(","));
  ' "$TMP_ROOT/rules.js") || fail "the served rules could not be executed"
  assert_equals "true,42,null,true" "$body" \
    "the served rules did not decide what the page depends on them deciding"
  pass "the server serves decision rules the page can actually use"
}

# The page's decision rules live in web/command-center-state.js because they are
# what got the rules wrong twice; these execute that file itself.
test_the_pages_decision_rules_hold() {
  local out rc=0
  command -v node >/dev/null 2>&1 || fail "node is required to run the page's rule tests"
  out=$(node "$(dirname "${BASH_SOURCE[0]}")/command-center-state.test.js" 2>&1) || rc=$?
  [ "$rc" -eq 0 ] || fail "the page's decision rules regressed:
$out"
  pass "the page's $out decision rules hold"
}

# --- what firstmate SAID to him ---------------------------------------------
# The whole point of the page: firstmate's work records are not a record of the
# messages it sent him, so bin/fm-captain-message.sh writes them down and the
# server reads them back.
say() {  # <home> <title> <text> [extra args...]
  local home=$1 title=$2 text=$3
  shift 3
  case " $* " in *" --task "*) ;; *) set -- --general "$@" ;; esac
  FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$RECORD" --title "$title" "$@" "$text"
}

test_a_message_names_the_project_the_worktree_and_the_branch() {
  local home row wt
  home="$TMP_ROOT/record"
  seed_home "$home"
  wt="$home/wt"
  git init -q "$wt"
  git -C "$wt" checkout -q -b fm/colour
  printf 'project=/home/captain/p/demo\nworktree=%s\n' "$wt" > "$home/state/cc-live.meta"

  say "$home" "The colour call is ready" "Blue or green?" --task cc-live >/dev/null \
    || fail "the recorder refused a message"
  row=$(tail -1 "$home/data/captain-messages.jsonl")

  assert_equals demo "$(jq -r .project <<<"$row")" \
    "a message recorded against a task did not carry its project"
  assert_equals "$wt" "$(jq -r .worktree <<<"$row")" \
    "a message recorded against a task did not carry its worktree"
  assert_equals fm/colour "$(jq -r .branch <<<"$row")" \
    "a message recorded against a task did not carry its branch"
  assert_equals "Blue or green?" "$(jq -r .text <<<"$row")" \
    "the message text was not recorded"
  pass "a recorded message names its project, its worktree and its branch"
}

# firstmate itself (the sweep and the backfill above) only ever resolves a
# message's project, worktree and branch from the ONE task a turn touched, and
# only from that task's live meta - by design, neither guesses beyond that.
# This server fills what those two honestly leave blank, computed at read
# time from the fleet's own current records, never rewritten into the log.
test_a_taskless_message_is_matched_to_the_one_task_it_names() {
  local home port body
  home="$TMP_ROOT/match-task"
  seed_home "$home"
  say "$home" "Status check" "Still working the colour call, see cc-live for details." >/dev/null \
    || fail "the recorder refused a message"

  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals "demo" "$(jq -r '.messages[0].project' <<<"$body")" \
    "a message naming exactly one task in its own words was not matched to that task's project"
  assert_contains "$(jq -r '.messages[0].context_source' <<<"$body")" "cc-live" \
    "the matched context did not quietly name the task it came from"
  pass "a message naming exactly one task in its own words is matched to that task's project"
}

test_a_message_naming_two_tasks_is_left_blank_rather_than_guessed() {
  local home port body
  home="$TMP_ROOT/match-ambiguous"
  seed_home "$home"
  say "$home" "Two things" "Working cc-live and cc-deferred both today." >/dev/null \
    || fail "the recorder refused a message"

  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals "null" "$(jq -r '.messages[0].project' <<<"$body")" \
    "a message naming more than one task was guessed at rather than left honestly blank"
  pass "a message naming more than one task is left blank rather than guessed"
}

# A closed task keeps its repo in the backlog long after its worktree and its
# meta are gone; a worktree and a branch it no longer has must stay blank.
# fm-captain-message.sh itself refuses --task against an id with no live
# record (its own honesty rule), which is exactly the row the automatic sweep
# leaves behind once a task's meta is gone - so this writes that row directly,
# the same shape the sweep or the backfill would have left it in.
test_a_message_for_a_task_whose_meta_is_gone_gets_its_backlog_repo() {
  local home port body
  home="$TMP_ROOT/match-backlog"
  seed_home "$home"
  printf '%s\n' '{"id":"m-gone","at":"2026-09-21T00:00:00Z","title":"It shipped",
    "text":"Settled.","task":"cc-answered","project":null,"worktree":null,"branch":null}' \
    | jq -c . > "$home/data/captain-messages.jsonl"

  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals "demo" "$(jq -r '.messages[0].project' <<<"$body")" \
    "a task whose meta is gone did not fall back to its backlog repo"
  assert_equals "null" "$(jq -r '.messages[0].worktree' <<<"$body")" \
    "a backlog-only fallback invented a worktree it cannot know"
  pass "a message for a task whose meta is gone still gets its backlog repo"
}

test_a_message_matched_to_a_registered_project_when_it_names_no_task() {
  local home port body
  home="$TMP_ROOT/match-project"
  seed_home "$home"
  printf '# Projects\n\n- demoproj [direct-PR] - a fixture project (added 2026-09-21)\n' \
    > "$home/data/projects.md"
  say "$home" "Heads up" "The demoproj work is moving along nicely." >/dev/null \
    || fail "the recorder refused a message"

  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals "demoproj" "$(jq -r '.messages[0].project' <<<"$body")" \
    "a message naming a registered project by name was not matched to it"
  pass "a message naming no task but exactly one registered project is matched to it"
}

# The captain's own order of precedence: the worker/task a turn was actually
# handling - found from its own transcript, not the message's words - is
# checked first and used even where firstmate's own sweep left the row's task
# blank (that turn touched two, so turn_task's single-match rule left it
# null). Unlike a keyword match, several tasks found this way show ALL their
# projects rather than staying blank.
test_a_message_shows_every_project_a_turns_tool_calls_touched() {
  local home cfg enc port body
  home="$TMP_ROOT/turn-projects"
  cfg="$TMP_ROOT/turn-projects-config"
  seed_turn_home "$home"
  cat > "$home/data/backlog.md" <<'EOF'
# Backlog

## Queued
- [ ] cc-one - First (repo: alpha) (kind: ship) (since 2026-09-01)
- [ ] cc-two - Second (repo: beta) (kind: ship) (since 2026-09-02)
EOF
  enc=$(python3 -c 'import re,sys; print(re.sub(r"[^A-Za-z0-9]","-",sys.argv[1]))' "$home")
  seed_turn_transcript "$cfg/projects/$enc/sess-t.jsonl"
  jq -cn '{id:"m-two", req:"r-two", session:"sess-t", title:"Both landed",
    text:"Both landed.", task:null, project:null, worktree:null, branch:null,
    source:"transcript", at:"2026-09-21T00:00:00Z"}' \
    > "$home/data/captain-messages.jsonl"

  CLAUDE_CONFIG_DIR="$cfg" start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals "alpha · beta" "$(jq -r '.messages[0].project' <<<"$body")" \
    "a turn whose tool calls touched two tasks did not show both their projects"
  assert_equals "null" "$(jq -r '.messages[0].worktree' <<<"$body")" \
    "two touched tasks must not invent a single worktree"
  pass "a message from a turn whose tool calls touched two tasks shows both their projects"
}

# The message's own text names a project too, but the worker/task evidence
# already answered it: keyword matching is a fallback for when that evidence
# names nothing, never a second vote once it has.
test_a_worker_evidenced_project_is_not_joined_by_a_keyword_guess() {
  local home cfg enc port body
  home="$TMP_ROOT/turn-precedence"
  cfg="$TMP_ROOT/turn-precedence-config"
  seed_turn_home "$home"
  cat > "$home/data/backlog.md" <<'EOF'
# Backlog

## Queued
- [ ] cc-one - First (repo: alpha) (kind: ship) (since 2026-09-01)
EOF
  printf '# Projects\n\n- decoy [direct-PR] - a project this message also names (added 2026-09-21)\n' \
    > "$home/data/projects.md"
  enc=$(python3 -c 'import re,sys; print(re.sub(r"[^A-Za-z0-9]","-",sys.argv[1]))' "$home")
  seed_turn_transcript "$cfg/projects/$enc/sess-t.jsonl"
  jq -cn '{id:"m-one", req:"r-one", session:"sess-t", title:"About one task",
    text:"About one task, also touches decoy.", task:null, project:null,
    worktree:null, branch:null, source:"transcript", at:"2026-09-21T00:00:00Z"}' \
    > "$home/data/captain-messages.jsonl"

  CLAUDE_CONFIG_DIR="$cfg" start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 120 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals "alpha" "$(jq -r '.messages[0].project' <<<"$body")" \
    "the message's own decoy keyword was joined onto worker evidence that already answered it"
  pass "worker/task evidence is never joined by a keyword match once it has named a project"
}

test_message_backfill_resolves_only_context_keyed_by_a_task_record() {
  local home wt result row
  home="$TMP_ROOT/backfill"
  seed_home "$home"
  wt="$home/wt"
  git init -q "$wt"
  git -C "$wt" checkout -q -b fm/backfill
  printf 'project=/home/captain/p/demo\nworktree=%s\n' "$wt" > "$home/state/cc-live.meta"
  printf '%s\n' \
    '{"id":"captured","task":null,"project":null,"worktree":null,"branch":null}' \
    '{"id":"routed","task":"cc-live","project":null,"worktree":null,"branch":null}' \
    > "$home/data/captain-messages.jsonl"

  result=$(FM_HOME="$home" "$BACKFILL") || fail "the message backfill failed"
  assert_equals 1 "$(jq -r .changed <<<"$result")" \
    "the task-keyed row was not backfilled"
  assert_equals 2 "$(jq -r .unresolved <<<"$result")" \
    "a row missing context was not left honestly unresolved"
  assert_equals 1 "$(jq -r '.unresolved_reasons.branch_not_recorded' <<<"$result")" \
    "the backfill did not explain why the branch stayed unknown"
  assert_equals 1 "$(jq -r '.unresolved_reasons.no_task_record' <<<"$result")" \
    "the backfill did not explain why the captured row stayed unknown"
  row=$(jq -c 'select(.id == "routed")' "$home/data/captain-messages.jsonl")
  assert_equals demo "$(jq -r .project <<<"$row")" \
    "the backfill did not resolve project from task metadata"
  assert_equals "$wt" "$(jq -r .worktree <<<"$row")" \
    "the backfill did not resolve worktree from task metadata"
  assert_equals null "$(jq -r .branch <<<"$row")" \
    "the backfill guessed a historical branch from the worktree's current one"
  assert_equals 0 "$(FM_HOME="$home" "$BACKFILL" | jq -r .changed)" \
    "a second backfill pass was not convergent"
  pass "message backfill resolves task-keyed context without guessing captured rows"
}

# The automatic capture can be killed mid-write; whatever is recorded next must
# not be glued onto what it left behind - either writer, same rule.
test_a_recorded_message_never_glues_onto_a_torn_row() {
  local home log
  home="$TMP_ROOT/handtorn"
  mkdir -p "$home/data"
  log="$home/data/captain-messages.jsonl"
  printf '%s\n' '{"id":"m1","at":"2026-01-01T00:00:00Z","title":"Whole","text":"A complete record."}' > "$log"
  printf '%s' '{"id":"m2","at":"2026-01-01T00:00:00Z","title":"Torn","te' >> "$log"

  say "$home" 'Recorded by hand' 'After the torn write.' >/dev/null \
    || fail "the recorder failed on a log whose last row was torn"
  assert_equals "Whole|Recorded by hand" \
    "$(python3 - "$log" <<'PYEOF'
import json, sys
kept = []
for line in open(sys.argv[1], encoding="utf-8"):
    try:
        kept.append(json.loads(line))
    except ValueError:
        continue
print("|".join(r.get("title", "") for r in kept))
PYEOF
)" "a message recorded by hand was glued onto a torn row and lost with it"
  pass "a recorded message never glues onto a torn row"
}

test_a_field_nothing_knows_is_recorded_as_unknown_not_guessed() {
  local home row
  home="$TMP_ROOT/unknown"
  seed_home "$home"
  say "$home" "Nothing to do with a project" "A fleet-wide note." >/dev/null \
    || fail "the recorder refused a message with no task"
  row=$(tail -1 "$home/data/captain-messages.jsonl")
  assert_equals null "$(jq -r '.project // "null"' <<<"$row")" \
    "a project nothing recorded was filled in with a guess"
  assert_equals null "$(jq -r '.branch // "null"' <<<"$row")" \
    "a branch nothing recorded was filled in with a guess"
  pass "a field nothing knows is recorded as unknown rather than guessed"
}

test_the_recorder_refuses_a_message_with_no_title_or_no_text() {
  local home
  home="$TMP_ROOT/refuse"
  seed_home "$home"
  ! FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$RECORD" "no title given" 2>/dev/null \
    || fail "a message with no title was recorded anyway"
  ! say "$home" "A title" "   " 2>/dev/null \
    || fail "an empty message was recorded anyway"
  local err
  err=$(FM_HOME="$home" FM_ROOT_OVERRIDE="$FIRSTMATE_ROOT" "$RECORD" --title "A title" "About some work." 2>&1) \
    && fail "a message naming neither --task nor --general was recorded anyway"
  case $err in *"--task <id>"*"state/*.meta"*) ;; *)
    fail "the refusal did not name --task <id> and state/*.meta: $err" ;; esac
  [ ! -s "$home/data/captain-messages.jsonl" ] \
    || fail "a refused message still reached the log"
  err=$(say "$home" "A title" "About a typo." --task cc-nosuch 2>&1) \
    && fail "a message about a task with no record was recorded anyway"
  case $err in *"--task <id>"*"state/*.meta"*) ;; *)
    fail "the unknown-task refusal did not name --task <id> and state/*.meta: $err" ;; esac
  [ ! -s "$home/data/captain-messages.jsonl" ] \
    || fail "a message about an unrecorded task still reached the log"
  pass "the recorder refuses a message with no title, no text, or no --task/--general"
}

# THE ONE THING THAT DECIDES WHETHER THIS IS DONE. He was away; firstmate spoke
# several times; he opens the page and every one of them is there, newest first,
# with nothing dropped and nothing added that he never saw.
test_every_message_sent_while_he_was_away_comes_back_in_order() {
  local home port body i titles
  home="$TMP_ROOT/away"
  seed_home "$home"
  for i in 1 2 3 4 5; do
    say "$home" "Message $i" "Body of message $i" --project demo >/dev/null
  done
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server

  assert_equals 5 "$(jq '.messages | length' <<<"$body")" \
    "a message firstmate sent while he was away did not come back"
  titles=$(jq -r '[.messages[].title] | join(",")' <<<"$body")
  assert_equals "Message 5,Message 4,Message 3,Message 2,Message 1" "$titles" \
    "the messages did not come back newest first, in order"
  assert_equals "Body of message 3" \
    "$(jq -r '.messages[] | select(.title == "Message 3") | .text' <<<"$body")" \
    "a message came back without the text he was meant to read"
  assert_not_contains "$body" 'cc-live' \
    "internal bookkeeping he was never sent was served as one of his messages"
  pass "every message sent while he was away comes back, in order, with nothing else"
}

test_a_reply_takes_the_answer_route_when_the_task_is_still_waiting() {
  local home port id body resolved
  home="$TMP_ROOT/reply-answer"
  seed_home "$home"
  id=$(say "$home" "Blue or green?" "The colour call is yours." --task cc-live --project demo --question) \
    || fail "the recorder refused the message"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 30 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Go blue."}')")
  assert_contains "$body" '"outcome":"sending"' "the reply was not accepted"
  # The item a steer may reach is named at acceptance, so the page can lock it
  # while the delivery is still running.
  assert_equals "main/hold/cc-live/cc-live" "$(jq -r '.item_key // ""' <<<"$body")" \
    "the accepted reply did not name the item it is about to steer"
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$body")") \
    || fail "the outcome of the reply never reached the record"
  stop_server

  assert_contains "$resolved" '"outcome":"sent"' "the reply was not delivered"
  assert_equals "main/hold/cc-live/cc-live" "$(jq -r '.item_key // ""' <<<"$resolved")" \
    "the reply did not name the item it steers"
  assert_contains "$resolved" 'fm-captain-hold.sh answer cc-live' \
    "a reply about a task still waiting did not take the answer route"
  assert_equals "$id" \
    "$(jq -r 'select(.text == "Go blue.") | .msg' "$home/data/command-center/said.jsonl" | head -1)" \
    "the reply was not recorded against the message it answered"
  assert_contains "$(cat "$home/data/backlog.md")" 'Go blue.' \
    "his exact words did not reach the durable record"
  pass "a reply about a task still waiting is answered through the answer route"
}

test_a_reply_with_nothing_waiting_is_queued_for_firstmate() {
  local home port id body resolved
  home="$TMP_ROOT/reply-note"
  seed_home "$home"
  id=$(say "$home" "PR is green" "https://example.invalid/pr/1 is ready to merge.") \
    || fail "the recorder refused the message"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Merge it."}')")
  assert_contains "$body" '"outcome":"sending"' "the reply was not accepted"
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$body")") \
    || fail "the outcome of the reply never reached the record"
  stop_server

  assert_contains "$resolved" '"outcome":"sent"' "the reply was not queued"
  assert_equals "" "$(jq -r '.item_key // ""' <<<"$resolved")" \
    "a reply that steers nothing named an item anyway"
  assert_contains "$resolved" 'fm-inbox.sh note' \
    "a reply with nothing waiting on it did not reach firstmate as a note"
  assert_contains "$(cat "$home"/state/inbox/*.note 2>/dev/null)" 'Merge it.' \
    "his reply never reached firstmate's own inbox"
  pass "a reply with nothing waiting on it is queued for firstmate"
}

test_a_reply_to_a_message_this_home_never_recorded_is_refused() {
  local home port code
  home="$TMP_ROOT/reply-unknown"
  seed_home "$home"
  say "$home" "Something" "Anything." >/dev/null
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  code=$(curl -s -o /dev/null -w '%{http_code}' -X POST \
    -H 'Content-Type: application/json' -d '{"msg":"m-never-written","text":"hi"}' \
    "http://127.0.0.1:$port/api/reply")
  stop_server
  assert_equals 404 "$code" \
    "a reply naming a message that was never recorded was acted on anyway"
  pass "a reply names a recorded message or it is refused"
}

# A task id is not unique across homes (bin/fm-backend-hometag-lib.sh), and a
# message record does not say which home it came from - the log does. A reply
# resolved against ANOTHER home's waiting task would steer a worker in an
# installation he was never talking about.
test_a_reply_never_resolves_its_task_against_another_home() {
  local home mate port id body resolved
  home="$TMP_ROOT/reply-crosshome"
  mate="$TMP_ROOT/reply-crosshome-mate"
  seed_home "$home"
  seed_home "$mate"
  # cc-live is waiting in the OTHER home only: this home's copy is plain work.
  sed -i 's/^- \[ \] cc-live .*$/- [ ] cc-live - Blue or green? (repo: demo) (kind: ship) (since 2026-09-01)/' \
    "$home/data/backlog.md"
  printf -- '- mate - synthetic scope (home: %s; scope: reviews; projects: demo; added 2026-07-14)\n' \
    "$mate" > "$home/data/secondmates.md"
  id=$(say "$home" "Blue or green?" "The colour call is yours." --task cc-live --project demo --question) \
    || fail "the recorder refused the message"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  curl -s -m 30 -o /dev/null "http://127.0.0.1:$port/api/items"
  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Go blue."}')")
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$body")") \
    || fail "the outcome of the reply never reached the record"
  stop_server

  assert_contains "$resolved" 'fm-inbox.sh note' \
    "a reply was resolved against a task waiting in another home"
  assert_not_contains "$(cat "$mate/data/backlog.md")" 'Go blue.' \
    "his words were delivered into an unrelated installation"
  pass "a reply never resolves its task against another home"
}

# "Every one" is the whole requirement: the list he opens is not allowed to stop
# at the old 500-line cap and say nothing about the messages it left out.
# THE WORST THING THIS PAGE COULD DO. A task collects several messages over its
# life: the question, then the PR, then the result. A reply to the PR message
# must never be written as the answer that closes the colour question.
test_a_reply_to_a_message_that_is_not_a_question_never_answers_a_decision() {
  local home port id body resolved
  home="$TMP_ROOT/reply-notaquestion"
  seed_home "$home"
  say "$home" "Blue or green?" "The colour call is yours." --task cc-live --project demo --question >/dev/null \
    || fail "the recorder refused the question"
  id=$(say "$home" "The PR is up" "https://example.invalid/pr/1 for the colour work." --task cc-live --project demo) \
    || fail "the recorder refused the message"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Merge it."}')")
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$body")") \
    || fail "the outcome of the reply never reached the record"
  stop_server

  assert_contains "$resolved" 'fm-inbox.sh note' \
    "a reply to a message that was not a question took the answer route"
  assert_not_contains "$(cat "$home/data/backlog.md")" 'Merge it.' \
    "words about a PR were written as the answer that closes an unrelated decision"
  assert_contains "$(cat "$home"/state/inbox/*.note 2>/dev/null)" 'Merge it.' \
    "his reply never reached firstmate at all"
  pass "a reply to a message that is not a question never answers a decision"
}

# A reply that cannot rule out the answer route must not quietly become a note:
# he would be told his steer was delivered while the worker stayed stopped. The
# click is accepted at once, so the refusal is the outcome on the record.
test_a_reply_is_never_delivered_as_a_note_while_no_scan_has_been_read() {
  local home shim realjq port id body resolved ready
  home="$TMP_ROOT/reply-unscanned"
  seed_home "$home"
  id=$(say "$home" "Blue or green?" "The colour call is yours." --task cc-live --project demo --question) \
    || fail "the recorder refused the message"
  shim="$TMP_ROOT/reply-unscanned-shim"
  mkdir -p "$shim"
  realjq=$(command -v jq) || fail "jq is required for this test"
  cat > "$shim/jq" <<EOF
#!/usr/bin/env bash
case " \$* " in *'_row:"item"'*) exit 1 ;; esac
exec "$realjq" "\$@"
EOF
  chmod +x "$shim/jq"

  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  PATH="$shim:$PATH" FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" python3 "$SERVER" \
    --port "$port" --home "$home" > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  ready=
  for _ in $(seq 1 60); do
    curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$ready" ] || fail "the server did not start"

  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Go blue."}')")
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$body")") \
    || fail "the outcome of the reply never reached the record"
  stop_server
  assert_contains "$resolved" '"outcome":"failed"' \
    "a reply that never left this machine was not reported as safe to resend"
  assert_equals "" "$(cat "$home"/state/inbox/*.note 2>/dev/null || true)" \
    "a reply fell through to the note route while no scan had been read"
  pass "a reply is never delivered as a note while no scan has been read"
}

# His own words are a list too: a reply missing from a thread reads as a message
# he never answered, which is an invitation to send the same steer twice.
test_his_own_words_are_served_whole_and_never_shortened_quietly() {
  local home port body i
  home="$TMP_ROOT/saidmany"
  seed_home "$home"
  mkdir -p "$home/data/command-center"
  for i in $(seq 1 600); do
    jq -cn --arg t "word $i" '{at:"2026-09-01T10:00:00Z", kind:"note", home:"main",
      text:$t, route:"fm-inbox.sh note", outcome:"sent"}'
  done > "$home/data/command-center/said.jsonl"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/said")
  stop_server
  assert_equals 600 "$(jq '.said | length' <<<"$body")" \
    "his own words past the old cap were dropped from the record"
  assert_equals 0 "$(jq '.dropped' <<<"$body")" \
    "a complete list of his words claimed rows were dropped"
  pass "his own words are served whole, and a shortened list would say so"
}

# HIS WORDS COME BACK AT ONCE. He reported the click freezing while the command
# ran. The answer must arrive before the command finishes, with his words
# already durable, and the outcome must land on the record afterwards.
test_the_click_returns_before_the_command_finishes() {
  local home fakeroot port f result started elapsed
  home="$TMP_ROOT/instant"
  seed_home "$home"
  # A throwaway firstmate checkout: real bin/ scripts symlinked in, except the
  # one route under test, which is replaced with a slow stub.
  fakeroot="$TMP_ROOT/instant-firstmate"
  mkdir -p "$fakeroot/bin"
  for f in "$FIRSTMATE_ROOT"/bin/*; do ln -s "$f" "$fakeroot/bin/$(basename "$f")"; done
  ln -s "$FIRSTMATE_ROOT/.tasks.toml" "$fakeroot/.tasks.toml"
  rm -f "$fakeroot/bin/fm-captain-hold.sh"
  printf '#!/usr/bin/env bash\nsleep 6\nexit 0\n' > "$fakeroot/bin/fm-captain-hold.sh"
  chmod +x "$fakeroot/bin/fm-captain-hold.sh"

  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  python3 "$SERVER" \
    --port "$port" --home "$home" --firstmate-root "$fakeroot" > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  local ready=
  for _ in $(seq 1 60); do
    curl -sf -m 2 -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$ready" ] || fail "the server did not start"

  started=$(date +%s)
  result=$(post "$port" /api/answer \
    '{"home":"main","id":"cc-live","source":"hold","key":"cc-live","text":"Go blue."}')
  elapsed=$(( $(date +%s) - started ))
  assert_contains "$result" '"ok":true' "the click was refused"
  [ "$elapsed" -lt 5 ] \
    || fail "the click waited ${elapsed}s for the command instead of returning at once"
  assert_grep 'Go blue.' "$home/data/command-center/said.jsonl" \
    "his words were not durable before the click returned"
  assert_contains "$(wait_outcome "$home" "$(jq -r .sid <<<"$result")")" '"outcome":"sent"' \
    "the outcome never landed on the record after the command finished"
  stop_server
  pass "the click returns before the command finishes, with his words already durable"
}

# A read that FAILED is not the state of the log: caching it would answer 304 to
# every later poll and leave the page saying his record could not be read long
# after it could.
test_a_failed_read_is_never_cached_as_the_state_of_the_log() {
  local home port headers etag body
  if [ "$(id -u)" = 0 ]; then
    pass "running as root; the unreadable-log case cannot be staged"
    return
  fi
  home="$TMP_ROOT/msgetagfail"
  seed_home "$home"
  say "$home" "Something he must not lose" "The whole point of the page." >/dev/null
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  chmod 000 "$home/data/captain-messages.jsonl"
  headers=$(curl -s -D - -o /dev/null "http://127.0.0.1:$port/api/messages")
  etag=$(printf '%s' "$headers" | sed -n 's/^[Ee][Tt]ag: *//p' | tr -d '\r')
  chmod 600 "$home/data/captain-messages.jsonl"
  assert_equals "" "$etag" \
    "a failed read was served with a live change check"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  stop_server
  assert_contains "$body" 'Something he must not lose' \
    "the repaired log never came back after one unreadable moment"
  pass "a failed read is never cached as the state of the log"
}

# A captain-facing message is often a bullet list, and a log whose whole purpose
# is that no message is lost may not refuse one for how it starts.
test_the_recorder_takes_a_body_that_looks_like_a_flag() {
  local home id
  home="$TMP_ROOT/dashbody"
  seed_home "$home"
  id=$(say "$home" "Two things" "- the first thing
- the second thing") || fail "a message whose body is a bullet list was refused"
  assert_contains "$(jq -r --arg i "$id" 'select(.id == $i) | .text' \
    "$home/data/captain-messages.jsonl")" '- the first thing' \
    "the bullet list was not recorded as the message text"
  id=$(say "$home" "Asking" "help") || fail "a message of exactly help was refused"
  assert_equals help \
    "$(jq -r --arg i "$id" 'select(.id == $i) | .text' "$home/data/captain-messages.jsonl")" \
    "a message of exactly help printed usage instead of being recorded"
  pass "the recorder takes a body that looks like a flag"
}

# The one machine line that never reaches his screen: a no-mistakes ask-user
# gate reports itself as ids plus a path, with the content deliberately left in
# the file. Everything else is the worker's own question, and the options he is
# being asked to choose between are the whole value of the row.
test_the_ask_user_machine_line_is_stated_plainly_and_real_questions_are_not() {
  local home out row
  home="$TMP_ROOT/plain"
  mkdir -p "$home/data" "$home/state"
  printf '# Backlog\n' > "$home/data/backlog.md"
  printf 'needs-decision [key=k-mach]: ask-user findings=status-line-timestamp-has-no-reader file=/home/c/p/fm/data/nm-1-findings.txt\n' \
    > "$home/state/t-machine.status"
  printf 'project=/home/captain/p/demo\nkind=ship\n' > "$home/state/t-machine.meta"
  printf 'needs-decision [key=k-opts]: Ship with the current cap of 500, or raise it to 2000 - your call, see data/limits.md\n' \
    > "$home/state/t-options.status"
  printf 'project=/home/captain/p/demo\nkind=ship\n' > "$home/state/t-options.meta"
  printf 'blocked [key=k-short]: Which palette?\n' > "$home/state/t-short.status"

  out=$(scan "$home") || fail "the scan failed"
  row=$(printf '%s' "$out" | jq -c '.items[] | select(.id == "t-machine")')
  assert_not_contains "$row" 'findings=' \
    "the ask-user machine line was rendered as something firstmate said to him"
  assert_not_contains "$row" 'nm-1-findings.txt' \
    "a file path from the machine line reached a row he reads"
  assert_contains "$(printf '%s' "$row" | jq -r .title)" 'A worker on demo' \
    "the machine row was not stated plainly from what is known"

  # His decision content survives intact, path and hyphens and all: losing the
  # options is far worse than showing him a path inside a sentence.
  assert_equals 'Ship with the current cap of 500, or raise it to 2000 - your call, see data/limits.md' \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-options") | .title')" \
    "the worker's own question was replaced instead of shown"
  assert_equals 'Which palette?' \
    "$(printf '%s' "$out" | jq -r '.items[] | select(.id == "t-short") | .title')" \
    "a short question a person would say out loud was thrown away"
  pass "the ask-user machine line is stated plainly and real questions are shown as written"
}

# The bonus route can be gone entirely - a bare OSError, not a
# SubprocessError - and deliver_certainly (bin/command-center.py) still owes
# him a landed send: the guaranteed note went out through fm-inbox.sh, which
# is untouched here, so the bonus raising must never read as "not sent".
test_a_send_whose_bonus_route_cannot_run_at_all_still_reaches_firstmate() {
  local home fakeroot port f result resolved
  home="$TMP_ROOT/norunner"
  seed_home "$home"
  fakeroot="$TMP_ROOT/norunner-firstmate"
  mkdir -p "$fakeroot/bin"
  for f in "$FIRSTMATE_ROOT"/bin/*; do ln -s "$f" "$fakeroot/bin/$(basename "$f")"; done
  ln -s "$FIRSTMATE_ROOT/.tasks.toml" "$fakeroot/.tasks.toml"
  # The script that owns the bonus decision route is gone: subprocess.run
  # raises, and that is not a SubprocessError.
  rm -f "$fakeroot/bin/fm-captain-hold.sh"

  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  python3 "$SERVER" \
    --port "$port" --home "$home" --firstmate-root "$fakeroot" > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  local ready=
  for _ in $(seq 1 60); do
    curl -sf -m 2 -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$ready" ] || fail "the server did not start"

  result=$(post "$port" /api/answer \
    '{"home":"main","id":"cc-live","source":"hold","key":"cc-live","text":"Go blue."}')
  resolved=$(wait_outcome "$home" "$(jq -r .sid <<<"$result")") \
    || fail "the outcome of the send never reached the record"
  stop_server
  assert_contains "$resolved" '"outcome":"sent"' \
    "a bonus route that cannot run at all left the item reading as not sent"
  assert_not_contains "$(cat "$home/data/backlog.md")" 'Go blue.' \
    "a bonus route that never ran was somehow recorded as having closed the decision"
  assert_contains "$(cat "$home"/state/inbox/*.note 2>/dev/null)" 'Go blue.' \
    "his words never reached firstmate's own inbox when the bonus route could not run"
  pass "a send whose bonus route cannot run at all still reaches firstmate through the guaranteed note"
}

# A message the recorder never marked as a question has no answer route to rule
# out, so a backlog that will not parse has nothing to say about where it goes.
test_a_reply_that_is_not_a_question_is_sent_even_with_no_scan() {
  local home shim realjq port id body
  home="$TMP_ROOT/reply-noscan-note"
  seed_home "$home"
  id=$(say "$home" "The PR is up" "Ready when you are.") \
    || fail "the recorder refused the message"
  shim="$TMP_ROOT/reply-noscan-note-shim"
  mkdir -p "$shim"
  realjq=$(command -v jq) || fail "jq is required for this test"
  cat > "$shim/jq" <<EOF
#!/usr/bin/env bash
case " \$* " in *'_row:"item"'*) exit 1 ;; esac
exec "$realjq" "\$@"
EOF
  chmod +x "$shim/jq"

  port=$(python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()')
  PATH="$shim:$PATH" FM_FIRSTMATE_ROOT="$FIRSTMATE_ROOT" python3 "$SERVER" \
    --port "$port" --home "$home" > "$home/server.log" 2>&1 &
  SERVER_PID=$!
  local ready=
  for _ in $(seq 1 60); do
    curl -s -m 2 -o /dev/null "http://127.0.0.1:$port/" && { ready=1; break; }
    kill -0 "$SERVER_PID" 2>/dev/null || break
    sleep 1
  done
  [ -n "$ready" ] || fail "the server did not start"

  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Merge it."}')")
  assert_contains "$body" '"ok":true' \
    "a reply with no answer route to rule out was refused because a backlog would not parse"
  assert_contains "$(wait_outcome "$home" "$(jq -r .sid <<<"$body")")" 'fm-inbox.sh note' \
    "the reply never reached firstmate as a note"
  stop_server
  assert_contains "$(cat "$home"/state/inbox/*.note 2>/dev/null)" 'Merge it.' \
    "his words never reached firstmate's own inbox"
  pass "a reply that is not a question is sent even with no scan"
}

# The page says none of it is dropped, and search only sees what was served.
# NOTHING IS DROPPED, and not everything is shipped at once: the page opens on
# the newest window, walks back through the rest on demand, and searches all of
# it. The log gains a message on every turn end, so shipping the whole of it on
# every poll is the freeze this page exists to end.
test_every_captured_message_is_reachable_without_serving_them_all() {
  local home port body oldest n
  home="$TMP_ROOT/msgmany"
  seed_home "$home"
  mkdir -p "$home/data"
  python3 - "$home/data/captain-messages.jsonl" <<'PYEOF'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    for i in range(700):
        fh.write(json.dumps({"id": "m%03d" % i, "at": "2026-01-01T00:00:00Z",
                             "title": "message %d" % i, "text": "body %d" % i}) + "\n")
PYEOF
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT

  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  n=$(printf '%s' "$body" | jq '.messages | length')
  assert_equals 200 "$n" "the whole log was shipped instead of the newest window"
  assert_equals "m699" "$(printf '%s' "$body" | jq -r '.messages[0].id')" \
    "the window did not open on the newest message"
  assert_equals "true" "$(printf '%s' "$body" | jq -r '.more')" \
    "the page was not told there is more of the log behind the window"
  # The count the page shows is the log's, not the window's: a number that
  # shrinks to whatever was served is the missing-messages complaint in a badge.
  assert_equals 700 "$(printf '%s' "$body" | jq -r '.total')" \
    "the page was told the log holds only what was served to it"

  # The count is kept as the log grows, counting only what arrived: a poll that
  # credits a count to fewer bytes than it read counts them again and the total
  # never comes back down.
  python3 - "$home/data/captain-messages.jsonl" <<'PYEOF'
import json, sys
with open(sys.argv[1], "a", encoding="utf-8") as fh:
    for i in range(700, 703):
        fh.write(json.dumps({"id": "m%03d" % i, "at": "2026-01-01T00:00:00Z",
                             "title": "message %d" % i, "text": "body %d" % i}) + "\n")
PYEOF
  assert_equals 703 "$(curl -s -m 30 "http://127.0.0.1:$port/api/messages" | jq -r '.total')" \
    "the count did not follow the log as it grew"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")

  # Walking back reaches the very first message, a window at a time.
  oldest=$(printf '%s' "$body" | jq -r '.messages[-1].id')
  for _ in 1 2 3; do
    body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?before=$oldest")
    oldest=$(printf '%s' "$body" | jq -r '.messages[-1].id')
  done
  assert_equals "m000" "$oldest" \
    "walking back through the log never reached the oldest message"
  assert_equals "false" "$(printf '%s' "$body" | jq -r '.more')" \
    "the start of the log still claimed there was more behind it"

  # Search reads the log itself, not what was served.
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?q=body%200")
  stop_server
  assert_equals "m000" "$(printf '%s' "$body" | jq -r '.messages[0].id')" \
    "search did not reach a message far behind the window"
  # The hit carries the whole message, so the page can open it and reply to it
  # exactly as it would a row from the window.
  assert_equals "message 0" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "a search hit was served without the message it found"
  assert_equals 703 "$(printf '%s' "$body" | jq -r '.total')" \
    "a search answered with a different count of the log than the list does"
  pass "every captured message stays reachable without serving the whole log"
}

# He can click a reply he sent months ago on My words. The page holds a window;
# the log holds everything, so one message can be asked for by name.
test_a_message_far_behind_the_window_is_served_by_id() {
  local home port body
  home="$TMP_ROOT/msgbyid"
  seed_home "$home"
  mkdir -p "$home/data"
  python3 - "$home/data/captain-messages.jsonl" <<'PYEOF'
import json, sys
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    for i in range(400):
        fh.write(json.dumps({"id": "m%03d" % i, "at": "2026-01-01T00:00:00Z",
                             "title": "message %d" % i, "text": "body %d" % i}) + "\n")
PYEOF
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?id=m003")
  assert_equals "message 3" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "a message far behind the window could not be asked for by name"
  assert_equals "body 3" "$(printf '%s' "$body" | jq -r '.messages[0].text')" \
    "the message was served without what firstmate actually said"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?id=m999")
  stop_server
  assert_equals 0 "$(printf '%s' "$body" | jq -r '.messages | length')" \
    "the log answered with a message it does not hold"
  pass "a message far behind the window is served by name"
}

test_an_archived_message_leaves_messages_and_can_be_restored() {
  local home port id body
  home="$TMP_ROOT/archive"
  seed_home "$home"
  id=$(say "$home" "Read this" "Nothing needs a reply.") || fail "the recorder refused the message"
  printf '{"id":"torn' >>"$home/data/captain-messages.jsonl"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(post "$port" /api/archive "$(jq -cn --arg m "$id" '{msg:$m,archived:true}')")
  assert_contains "$body" '"ok":true' "the archive change was not accepted"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  assert_equals 0 "$(printf '%s' "$body" | jq '.messages | length')" \
    "an archived message stayed in Messages (was it glued onto a torn line?)"
  assert_equals "0 1" "$(printf '%s' "$body" | jq -r '"\(.total) \(.archived_total)"')" \
    "the counts did not follow the archive"
  assert_equals true "$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?archived=1&q=read" | jq -r '.messages[0].archived')" \
    "a message found in Archived was not marked archived"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?archived=1")
  assert_equals "$id" "$(printf '%s' "$body" | jq -r '.messages[0].id')" \
    "the archived message was not readable from Archived"
  assert_equals 'Nothing needs a reply.' "$(printf '%s' "$body" | jq -r '.messages[0].text')" \
    "archiving lost the message body"
  assert_equals archive "$(tail -1 "$home/data/captain-messages.jsonl" | jq -r .kind)" \
    "archive state was not recorded beside the message"
  body=$(post "$port" /api/archive "$(jq -cn --arg m "$id" '{msg:$m,archived:false}')")
  assert_contains "$body" '"ok":true' "the restore change was not accepted"
  assert_equals "$id" "$(curl -s -m 30 "http://127.0.0.1:$port/api/messages" | jq -r '.messages[0].id')" \
    "a restored message did not return to Messages"
  stop_server
  pass "archiving is durable beside the message and can be restored"
}

test_a_reply_archives_its_message_before_delivery_finishes() {
  local home port id body sid
  home="$TMP_ROOT/reply-archives"
  seed_home "$home"
  id=$(say "$home" "Reply to this" "Your reply clears this conversation.") \
    || fail "the recorder refused the message"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"Done."}')")
  assert_equals true "$(printf '%s' "$body" | jq -r .archived)" \
    "a reply did not archive its conversation with its acceptance"
  sid=$(printf '%s' "$body" | jq -r .sid)
  assert_contains "$(wait_outcome "$home" "$sid")" 'fm-inbox.sh note' \
    "the reply was not still delivered through its normal route"
  assert_equals 0 "$(curl -s -m 30 "http://127.0.0.1:$port/api/messages" | jq '.messages | length')" \
    "a replied-to message stayed in Messages"
  assert_equals "$id" "$(curl -s -m 30 "http://127.0.0.1:$port/api/messages?archived=1" | jq -r '.messages[0].id')" \
    "a replied-to message was not kept in Archived"
  stop_server
  pass "replying archives the conversation while preserving its delivery"
}

test_an_unchanged_message_poll_is_answered_without_the_log() {
  local home port tag code body
  home="$TMP_ROOT/msgetag"
  seed_home "$home"
  say "$home" "The first thing" "Body of the first thing." >/dev/null
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  tag=$(curl -s -m 30 -D - -o /dev/null "http://127.0.0.1:$port/api/messages" \
    | awk 'tolower($1) == "etag:" { print $2 }' | tr -d '\r')
  [ -n "$tag" ] || fail "the message list was served without a tag to poll against"
  # The capture's age moves with the wall clock on every request; only a change
  # the page would actually SAY may cost a re-read of the log.
  sleep 2
  code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    -H "If-None-Match: $tag" "http://127.0.0.1:$port/api/messages")
  assert_equals 304 "$code" "an unchanged poll re-served the whole message log"

  say "$home" "The second thing" "Body of the second thing." >/dev/null
  body=$(curl -s -m 30 -H "If-None-Match: $tag" "http://127.0.0.1:$port/api/messages")
  stop_server
  assert_contains "$body" "The second thing" \
    "a captured message never reached a page holding the previous tag"
  pass "an unchanged message poll costs nothing and a new message still arrives"
}

# The server is the only matcher, so a query it cannot answer is the whole
# answer. What the message CONTAINS is what he searches by - not how the record
# happens to be escaped on disk.
test_a_search_finds_text_however_the_record_escapes_it() {
  local home port body id
  home="$TMP_ROOT/msgquote"
  seed_home "$home"
  say "$home" 'The gate call' 'I refused the "gate" run, so nothing was pushed.' >/dev/null
  say "$home" 'Something else' 'A plain message with no quoting in it.' >/dev/null
  say "$home" 'The umlaut call' 'Über den Gate habe ich entschieden.' >/dev/null
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(curl -s -m 30 --get --data-urlencode 'q=the "gate"' \
    "http://127.0.0.1:$port/api/messages")
  assert_equals 1 "$(printf '%s' "$body" | jq -r '.messages | length')" \
    "a search for text the record escapes found nothing he could see"
  assert_equals "The gate call" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "the search answered with a message that does not contain what he typed"

  # He searches the message as he reads it - a phrase that runs from the title
  # into the body is one phrase to him, whatever punctuation the record has
  # between them.
  body=$(curl -s -m 30 --get --data-urlencode 'q=The gate call I refused' \
    "http://127.0.0.1:$port/api/messages")
  assert_equals "The gate call" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "a search across the title and the body of one message found nothing"

  # A thread is what firstmate said AND what he replied: he remembers his own
  # words at least as well, and searches by them.
  id=$(say "$home" 'The palette fix' 'The palette fix is ready to merge.')
  body=$(post "$port" /api/reply "$(jq -cn --arg m "$id" '{msg:$m,text:"ship the blue one"}')")
  wait_outcome "$home" "$(jq -r .sid <<<"$body")" >/dev/null \
    || fail "the reply never reached the record"
  body=$(curl -s -m 30 --get --data-urlencode 'q=ship the blue one' \
    "http://127.0.0.1:$port/api/messages?archived=1")
  assert_equals "The palette fix" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "a search by the words he replied did not find the message he replied to"

  # Nor does it stop being findable once he has typed a great deal since: the
  # thread under the message is drawn from the whole log, so the search reads
  # the same log.
  for i in $(seq 1 600); do
    jq -cn --arg i "$i" '{kind:"note",home:"main",sid:("f"+$i),
      at:"2026-01-01T00:00:00Z",text:("filler "+$i),outcome:"sent"}'
  done >> "$home/data/command-center/said.jsonl"
  body=$(curl -s -m 30 --get --data-urlencode 'q=ship the blue one' \
    "http://127.0.0.1:$port/api/messages?archived=1")
  assert_equals "The palette fix" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "a reply stopped being searchable once newer sends pushed it back"

  # Nor by how it is cased, in any alphabet: he types what he remembers seeing.
  body=$(curl -s -m 30 --get --data-urlencode 'q=über' \
    "http://127.0.0.1:$port/api/messages")
  assert_equals "The umlaut call" "$(printf '%s' "$body" | jq -r '.messages[0].title')" \
    "a search missed a message because the record capitalises it differently"
  stop_server
  pass "a search finds text however the record escapes or cases it"
}

test_an_unreadable_message_log_is_reported_not_shown_as_empty() {
  local home port body
  if [ "$(id -u)" = 0 ]; then
    pass "running as root; the unreadable-message-log case cannot be staged"
    return
  fi
  home="$TMP_ROOT/msgread"
  seed_home "$home"
  say "$home" "Something he must not lose" "The whole point of the page." >/dev/null
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  chmod 000 "$home/data/captain-messages.jsonl"
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/messages")
  chmod 600 "$home/data/captain-messages.jsonl"
  stop_server
  assert_contains "$body" 'could not be read' \
    "an unreadable message log was served as an empty one"
  pass "an unreadable message log is reported rather than shown as empty"
}

# --- automatic capture -------------------------------------------------------
# The recorder above is called by hand, and a message firstmate forgets to
# record is exactly the message he opens the page for and does not find. The
# sweep removes the remembering: it reads the conversation record itself.
SWEEP="$FIRSTMATE_ROOT/bin/fm-captain-message-sweep.py"
HOOK="$FIRSTMATE_ROOT/bin/fm-captain-message-hook.sh"

# One transcript line. Args: <req> <stop_reason> <sidechain> <at> <block-json>
entry() {
  jq -cn --arg req "$1" --arg stop "$2" --argjson side "$3" --arg at "$4" \
    --argjson block "$5" \
    '{type:"assistant", requestId:$req, uuid:($req+"-u"), isSidechain:$side,
      timestamp:$at, sessionId:"sess-1", gitBranch:"fm/capture",
      message:{role:"assistant", stop_reason:$stop, content:[$block]}}'
}

seed_transcripts() {  # <dir> [at for real messages] [at for pre-floor history]
  local at=${2:-2026-01-03T10:00:00.000Z} old=${3:-2026-01-01T09:00:00.000Z}
  mkdir -p "$1"
  {
    # Mid-turn narration before a tool call is not a message he was sent.
    entry r-nar tool_use false "$at" \
      '{"type":"text","text":"Let me look at the config first."}'
    # One response split across entries: thinking, then its text in two blocks.
    entry r-split end_turn false "$at" \
      '{"type":"thinking","thinking":"private reasoning"}'
    entry r-split end_turn false "$at" \
      '{"type":"text","text":"The fix landed. "}'
    entry r-split end_turn false "$at" \
      '{"type":"text","text":"CI is green."}'
    # A subagent transcript entry is never his chat.
    entry r-side end_turn true "$at" \
      '{"type":"text","text":"sidechain chatter"}'
    # Markdown decoration must not reach the title he scans.
    entry r-md end_turn false "$at" \
      '{"type":"text","text":"# Done\n**Shipped** the palette fix."}'
    # History from before the floor must not resurface as a new message.
    entry r-old end_turn false "$old" \
      '{"type":"text","text":"ancient history"}'
    # The harness authors its own assistant entries; firstmate did not say them.
    entry r-synth end_turn false "$at" \
      '{"type":"text","text":"No response requested."}' \
      | jq -c '.message.model = "<synthetic>"'
  } > "$1/sess-1.jsonl"
}

# Three turns: one whose tool call named exactly one task's record, one that
# named two, and one that names a task only in its prose.
seed_turn_transcript() {  # <file>
  local prompt tool
  prompt='{"type":"user","sessionId":"sess-t","message":{"role":"user","content":"go"}}'
  turn_tool() {  # <req> <input-json>
    jq -cn --arg req "$1" --argjson input "$2" \
      '{type:"assistant", requestId:$req, sessionId:"sess-t", timestamp:"2026-01-03T10:00:00.000Z",
        message:{role:"assistant", stop_reason:"tool_use",
                 content:[{type:"tool_use", name:"Bash", input:$input}]}}'
  }
  mkdir -p "$(dirname "$1")"
  {
    printf '%s\n' "$prompt"
    turn_tool t-a1 '{"command":"cat state/cc-one.meta"}'
    printf '%s\n' '{"type":"user","sessionId":"sess-t","message":{"role":"user","content":[{"type":"tool_result","content":"state/cc-two.meta"}]}}'
    entry r-one end_turn false 2026-01-03T10:00:00.000Z '{"type":"text","text":"About one task."}'
    printf '%s\n' "$prompt"
    turn_tool t-b1 '{"command":"cat state/cc-one.meta state/cc-two.status"}'
    entry r-two end_turn false 2026-01-03T10:00:00.000Z '{"type":"text","text":"About two tasks."}'
    printf '%s\n' "$prompt"
    entry r-prose end_turn false 2026-01-03T10:00:00.000Z '{"type":"text","text":"See state/cc-one.meta."}'
  } > "$1"
}

seed_turn_home() {  # <home>
  mkdir -p "$1/state" "$1/data"
  git init -q "$1/wt-one"
  git -C "$1/wt-one" checkout -q -b fm/one
  printf 'project=/home/captain/p/demo\nworktree=%s\n' "$1/wt-one" > "$1/state/cc-one.meta"
  printf 'project=/home/captain/p/other\nworktree=/wt/two\n' > "$1/state/cc-two.meta"
}

assert_turn_attribution() {  # <log> <what> [branch]
  local log=$1
  assert_equals "cc-one|demo|${log%/data/*}/wt-one|${3:-null}" \
    "$(jq -r 'select(.req == "r-one") | [.task, .project, .worktree, (.branch // "null")] | join("|")' "$log")" \
    "$2: a turn that touched exactly one task was not recorded against it"
  assert_equals "null|null" \
    "$(jq -r 'select(.req == "r-two") | [(.task // "null"), (.project // "null")] | join("|")' "$log")" \
    "$2: a turn that touched two tasks was attributed to one"
  assert_equals "null|null" \
    "$(jq -r 'select(.req == "r-prose") | [(.task // "null"), (.project // "null")] | join("|")' "$log")" \
    "$2: a task named only in the message's words was attributed"
}

test_a_captured_message_carries_the_one_task_its_turn_touched() {
  local home tdir
  home="$TMP_ROOT/turn-capture"
  tdir="$TMP_ROOT/turn-capture-transcripts"
  seed_turn_home "$home"
  seed_turn_transcript "$tdir/sess-t.jsonl"
  sweep "$home" "$tdir" || fail "the sweep failed on a turn transcript"
  assert_turn_attribution "$home/data/captain-messages.jsonl" "catch-up capture"

  home="$TMP_ROOT/turn-capture-hook"
  seed_turn_home "$home"
  jq -cn --arg p "$tdir/sess-t.jsonl" '{transcript_path:$p}' \
    | python3 "$SWEEP" --home "$home" --from-payload --since 2026-01-02T00:00:00Z \
    || fail "the sweep failed on a payload-named turn transcript"
  assert_turn_attribution "$home/data/captain-messages.jsonl" "turn-end capture" fm/one
  pass "a captured message carries the one task its own turn touched, its branch only at turn end, and no guess otherwise"
}

test_message_backfill_attributes_by_the_same_turn_evidence() {
  local home cfg result
  home="$TMP_ROOT/turn-backfill"
  cfg="$TMP_ROOT/turn-backfill-config"
  seed_turn_home "$home"
  seed_turn_transcript "$cfg/projects/$(printf '%s' "$home" | sed 's/[^A-Za-z0-9]/-/g')/sess-t.jsonl"
  for req in r-one r-two r-prose; do
    jq -cn --arg req "$req" '{id:("c-"+$req), req:$req, session:"sess-t", task:null,
      project:null, worktree:null, branch:null, source:"transcript"}'
  done > "$home/data/captain-messages.jsonl"
  result=$(CLAUDE_CONFIG_DIR="$cfg" FM_HOME="$home" "$BACKFILL") || fail "the message backfill failed"
  assert_equals 1 "$(jq -r .changed <<<"$result")" \
    "the backfill did not change exactly the one attributable row"
  assert_turn_attribution "$home/data/captain-messages.jsonl" "backfill"
  assert_equals 0 "$(CLAUDE_CONFIG_DIR="$cfg" FM_HOME="$home" "$BACKFILL" | jq -r .changed)" \
    "a second backfill pass was not convergent"
  pass "the backfill attributes a captured row only by its own turn's single task"
}

sweep() {  # <home> <transcripts>
  python3 "$SWEEP" --home "$1" --transcripts "$2" --since 2026-01-02T00:00:00Z
}

test_every_chat_message_is_captured_without_anyone_recording_it() {
  local home tdir log
  home="$TMP_ROOT/capture"
  tdir="$TMP_ROOT/capture-transcripts"
  mkdir -p "$home/state"
  seed_transcripts "$tdir"

  sweep "$home" "$tdir" || fail "the sweep failed on a seeded transcript"
  log="$home/data/captain-messages.jsonl"
  assert_equals 2 "$(wc -l < "$log")" \
    "the sweep did not record exactly the two messages he was sent"
  assert_equals "The fix landed. CI is green." \
    "$(jq -r 'select(.req == "r-split") | .text' "$log")" \
    "a response split across transcript entries was not joined back into one message"
  assert_equals "Done" \
    "$(jq -r 'select(.req == "r-md") | .title' "$log")" \
    "the title he scans still carries markdown decoration"
  # The transcript's gitBranch is the firstmate home's own branch, identical on
  # every row and unrelated to what the message is about, so it is not recorded.
  assert_equals "null" "$(jq -r 'select(.req == "r-md") | .branch' "$log")" \
    "the home's own branch was recorded as if it were the message's"
  assert_not_contains "$(cat "$log")" 'Let me look at the config' \
    "mid-turn narration was recorded as if it were a message he was sent"
  assert_not_contains "$(cat "$log")" 'sidechain chatter' \
    "a subagent's output was recorded as firstmate's own message"
  assert_not_contains "$(cat "$log")" 'private reasoning' \
    "hidden reasoning was recorded as part of a message"
  assert_not_contains "$(cat "$log")" 'ancient history' \
    "history from before the floor resurfaced as a new message"
  assert_not_contains "$(cat "$log")" 'No response requested' \
    "a synthetic harness entry was recorded as firstmate's own message"

  # Running again - or recovering from a lost cursor - must never duplicate.
  sweep "$home" "$tdir"
  rm "$home/state/.captain-message-sweep"
  sweep "$home" "$tdir"
  assert_equals 2 "$(wc -l < "$log")" \
    "a repeated or cursor-less sweep recorded the same message twice"

  assert_equals "true" \
    "$(jq -r .ok "$home/state/.captain-message-capture")" \
    "a clean sweep did not report itself healthy"
  pass "every chat message is captured once, verbatim, with nothing that is not a message"
}

# A question firstmate records by hand is the only row that knows where his
# reply goes; the capture of the same turn's final message must not add a bare,
# unroutable copy beside it - and must not swallow a later turn that says the
# same words with no hand record behind them.
test_a_hand_recorded_question_is_not_captured_a_second_time() {
  local home tdir log id id2 before after
  home="$TMP_ROOT/handdedupe"
  tdir="$TMP_ROOT/handdedupe-transcripts"
  seed_home "$home"
  mkdir -p "$tdir"
  before=$(date -u -d '-60 sec' +%Y-%m-%dT%H:%M:%S.000Z)
  id=$(say "$home" "Blue or green?" "The colour call is yours.
Blue or green?" --task cc-live --project demo --question) || fail "the recorder refused the message"
  after=$(date -u -d '+60 sec' +%Y-%m-%dT%H:%M:%S.000Z)
  {
    jq -cn --arg at "$before" '{type:"user",timestamp:$at,sessionId:"sess-1",
      message:{role:"user",content:"what next?"}}'
    entry r-q end_turn false "$after" \
      '{"type":"text","text":"The colour call is yours.\nBlue or green?"}'
    jq -cn --arg at "$(date -u -d '+120 sec' +%Y-%m-%dT%H:%M:%S.000Z)" \
      '{type:"user",timestamp:$at,sessionId:"sess-1",
        message:{role:"user",content:"say it again"}}'
    entry r-again end_turn false "$(date -u -d '+180 sec' +%Y-%m-%dT%H:%M:%S.000Z)" \
      '{"type":"text","text":"The colour call is yours.\nBlue or green?"}'
  } > "$tdir/sess-1.jsonl"

  sweep "$home" "$tdir" || fail "the sweep failed"
  rm "$home/state/.captain-message-sweep"
  sweep "$home" "$tdir" || fail "the cursor-less sweep failed"
  log="$home/data/captain-messages.jsonl"
  assert_equals "$id,r-again" "$(jq -rs 'map(.req // .id) | join(",")' "$log")" \
    "the hand-recorded question was duplicated, or a later turn was swallowed"
  assert_equals "true" "$(jq -r "select(.id == \"$id\") | .question" "$log")" \
    "the routed row did not survive as the question"

  # The page's own capture runs mid-turn and reads the prompt long before the
  # turn ends, so the routed row must still stand for the message on a sweep
  # that sees only the reply.
  id2=$(say "$home" "Merge the PR?" "The review is clean. Merge the PR?" \
    --task cc-live --project demo --question) || fail "the recorder refused the second message"
  jq -cn --arg at "$(date -u -d '+240 sec' +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{type:"user",timestamp:$at,sessionId:"sess-1",
      message:{role:"user",content:"and the PR?"}}' >> "$tdir/sess-1.jsonl"
  sweep "$home" "$tdir" || fail "the sweep of the prompt failed"
  entry r-pr end_turn false "$(date -u -d '+300 sec' +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{"type":"text","text":"The review is clean. Merge the PR?"}' >> "$tdir/sess-1.jsonl"
  sweep "$home" "$tdir" || fail "the mid-turn sweep failed"
  assert_equals "$id,r-again,$id2" "$(jq -rs 'map(.req // .id) | join(",")' "$log")" \
    "a routed question was duplicated by a sweep that began after the prompt"
  pass "a hand-recorded question stands for its captured message, however the sweep is split"
}

# THE REPORTED COMPLAINT: a session started from somewhere else writes its
# transcript where the derived directory is not looking, so what firstmate said
# there never reaches the page - and nothing says so. The hook payload names
# the file; that name is what makes the list vouchable.
test_a_transcript_the_payload_names_is_captured_wherever_it_lives() {
  local home elsewhere log
  home="$TMP_ROOT/pinned"
  elsewhere="$TMP_ROOT/pinned-elsewhere"
  mkdir -p "$home/state" "$elsewhere"
  seed_transcripts "$elsewhere" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

  # Nothing has named a transcript yet, so the capture record must not claim a
  # directory it only worked out for itself is the whole story.
  python3 "$SWEEP" --home "$home" --transcripts "$TMP_ROOT/pinned-nowhere" \
    || fail "the directory sweep failed"
  assert_equals 0 "$(jq -r '.named' "$home/state/.captain-message-capture")" \
    "a capture nothing confirmed the location of reported a confirmed one"

  printf '{"transcript_path":"%s"}' "$elsewhere/sess-1.jsonl" \
    | python3 "$SWEEP" --home "$home" --from-payload \
    || fail "the sweep failed on a payload-named transcript"
  log="$home/data/captain-messages.jsonl"
  assert_grep 'CI is green.' "$log" \
    "a transcript the payload named was not captured because of where it lives"
  assert_equals 1 "$(jq -r '.named' "$home/state/.captain-message-capture")" \
    "the transcript a session named was not remembered as confirmed"

  # And the directory runs keep reading it afterwards, wherever it lives.
  entry r-later end_turn false "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{"type":"text","text":"Said after the session was known."}' \
    >> "$elsewhere/sess-1.jsonl"
  python3 "$SWEEP" --home "$home" --transcripts "$TMP_ROOT/pinned-nowhere" \
    || fail "the directory sweep failed"
  assert_grep 'Said after the session was known.' "$log" \
    "a named transcript was forgotten by the sweep that reads the directory"

  # And the page is told: a list every session has confirmed the location of
  # must not carry the band that says it may be incomplete.
  start_server "$home" || fail "the server did not start"
  assert_equals 1 "$(curl -s -m 30 "http://127.0.0.1:$SERVER_PORT/api/messages" \
      | jq -r '.capture.named')" \
    "the page was never told a session had confirmed where it records"
  stop_server
  pass "a transcript the payload names is captured wherever it lives"
}

# The server sweeps every few seconds, so it is routinely the one that reads a
# turn's bytes first. The hook's run then has nothing new to read - and the
# payload it carries is still the only thing that knows where this session
# writes, so that must survive a run with no new bytes in it.
test_a_named_transcript_is_remembered_even_with_nothing_new_to_read() {
  local home elsewhere
  home="$TMP_ROOT/pinned-late"
  elsewhere="$TMP_ROOT/pinned-late-transcripts"
  mkdir -p "$home/state" "$elsewhere"
  seed_transcripts "$elsewhere" "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)"

  python3 "$SWEEP" --home "$home" --transcripts "$elsewhere" \
    || fail "the directory sweep failed"
  assert_equals 0 "$(jq -r '.named' "$home/state/.captain-message-capture")" \
    "a directory sweep claimed a session had confirmed its transcript"

  printf '{"transcript_path":"%s"}' "$elsewhere/sess-1.jsonl" \
    | python3 "$SWEEP" --home "$home" --from-payload \
    || fail "the sweep failed on a payload-named transcript"
  python3 "$SWEEP" --home "$home" --transcripts "$TMP_ROOT/pinned-late-nowhere" \
    || fail "the directory sweep failed"
  assert_equals 1 "$(jq -r '.named' "$home/state/.captain-message-capture")" \
    "a session that named its transcript was forgotten because it had nothing new to say"
  pass "a named transcript is remembered even when it has nothing new to read"
}

# One response can reach the transcript as several lines, and a sweep can land
# between them. The log's own requestIds are what stops the second batch from
# recording the same response again under the same id - two rows sharing one id
# collide on everything the page keys by it.
test_a_response_read_across_two_sweeps_is_recorded_once() {
  local home tdir now
  home="$TMP_ROOT/split"
  tdir="$TMP_ROOT/split-transcripts"
  mkdir -p "$home/state" "$tdir"
  now=$(date -u +%Y-%m-%dT%H:%M:%S.000Z)
  entry r-straddle end_turn false "$now" \
    '{"type":"text","text":"The first half."}' > "$tdir/sess-1.jsonl"
  python3 "$SWEEP" --home "$home" --transcripts "$tdir" \
    || fail "the first sweep failed"

  entry r-straddle end_turn false "$now" \
    '{"type":"text","text":" And the second."}' >> "$tdir/sess-1.jsonl"
  python3 "$SWEEP" --home "$home" --transcripts "$tdir" \
    || fail "the second sweep failed"

  assert_equals 1 "$(jq -s '[.[] | select(.req == "r-straddle")] | length' \
      "$home/data/captain-messages.jsonl")" \
    "a response read across two sweeps was recorded twice under one id"
  pass "a response read across two sweeps is recorded once"
}

# The Stop hook kills the sweep on its bound, so a write can stop mid-row. The
# torn row costs itself; what the next sweep records must not be glued onto it
# and lost with it.
test_a_torn_row_costs_itself_and_nothing_after_it() {
  local home tdir log
  home="$TMP_ROOT/torn"
  tdir="$TMP_ROOT/torn-transcripts"
  mkdir -p "$home/state" "$home/data" "$tdir"
  # A log whose last write stopped in the middle of a record.
  printf '%s\n' '{"id":"m1","at":"2026-01-01T00:00:00Z","title":"Whole","text":"A complete record."}' \
    > "$home/data/captain-messages.jsonl"
  printf '%s' '{"id":"m2","at":"2026-01-01T00:00:00Z","title":"Torn","te' \
    >> "$home/data/captain-messages.jsonl"

  entry r-after end_turn false "$(date -u +%Y-%m-%dT%H:%M:%S.000Z)" \
    '{"type":"text","text":"Said after the torn write."}' > "$tdir/sess-1.jsonl"
  python3 "$SWEEP" --home "$home" --transcripts "$tdir" \
    || fail "the sweep failed on a log whose last row was torn"

  log="$home/data/captain-messages.jsonl"
  # The log is one JSON object per line - that is the contract the page reads
  # it by, so what it holds is read the same way here.
  assert_equals "Whole|Said after the torn write." \
    "$(python3 - "$log" <<'PYEOF'
import json, sys
kept = []
for line in open(sys.argv[1], encoding="utf-8"):
    try:
        kept.append(json.loads(line))
    except ValueError:
        continue
print("|".join(r.get("title", "") for r in kept))
PYEOF
)" "a message recorded after a torn row was glued onto it and lost with it"
  pass "a torn row costs itself and nothing after it"
}

test_a_home_with_no_conversation_record_reports_capture_inactive() {
  local home
  home="$TMP_ROOT/no-record"
  mkdir -p "$home/state"
  python3 "$SWEEP" --home "$home" --transcripts "$TMP_ROOT/no-such-dir" \
    || fail "the sweep failed on a home with no conversation record"
  assert_equals "false" \
    "$(jq -r .active "$home/state/.captain-message-capture")" \
    "a home whose conversation cannot be read claimed capture was active"
  pass "a home with no conversation record reports capture inactive, for the page to say so"
}

# THE GUARANTEE ITSELF: the server alone, with no agent involved anywhere,
# brings the message he was sent onto the page and vouches for the capture.
test_the_server_captures_the_conversation_with_no_agent_involved() {
  local home cfg enc port body
  home="$TMP_ROOT/auto"
  seed_home "$home"
  cfg="$TMP_ROOT/auto-claude"
  enc=$(python3 -c 'import re,sys; print(re.sub(r"[^A-Za-z0-9]","-",sys.argv[1]))' "$home")
  # The server applies the sweep's own floor (today), so the messages he must
  # see are dated now, and the pre-floor fixture line keeps its old date.
  seed_transcripts "$cfg/projects/$enc" "$(date -u +%FT%T).000Z"

  CLAUDE_CONFIG_DIR="$cfg" start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  wait_for "the message firstmate sent him never appeared on the page" \
    bash -c "curl -s -m 10 'http://127.0.0.1:$port/api/messages' \
      | jq -e '[.messages[] | select(.text | contains(\"Shipped\"))] | length > 0'"
  body=$(curl -s -m 10 "http://127.0.0.1:$port/api/messages")
  stop_server
  assert_equals "true" "$(jq -r '.capture.ok' <<<"$body")" \
    "the page was not told the capture is healthy"
  assert_not_contains "$body" 'sidechain chatter' \
    "the page was served something that is not a message he was sent"
  pass "the server captures the conversation itself, with no agent involved"
}

test_a_delivery_orphaned_by_a_restart_reads_back_as_unknown() {
  local home port body etag code
  home="$TMP_ROOT/orphan"
  seed_home "$home"
  mkdir -p "$home/data/command-center"
  {
    printf '{"sid":"orphaned1","at":"2026-01-03T10:00:00Z","kind":"answer","item":"t-1","text":"lost words","outcome":"sending"}\n'
    printf '{"sid":"finished1","at":"2026-01-03T10:01:00Z","kind":"answer","item":"t-2","text":"kept words","outcome":"sending"}\n'
    printf '{"kind":"outcome","of":"finished1","at":"2026-01-03T10:01:05Z","outcome":"sent","route":"fm-captain-hold.sh answer t-2","mode":"close"}\n'
  } > "$home/data/command-center/said.jsonl"
  start_server "$home" || fail "the server did not start"
  port=$SERVER_PORT
  body=$(curl -s -m 30 "http://127.0.0.1:$port/api/said")
  stop_server

  assert_equals 2 "$(jq '.said | length' <<<"$body")" \
    "the outcome bookkeeping line was served as a record of its own"
  assert_equals "sent|fm-captain-hold.sh answer t-2" \
    "$(jq -r '.said[] | select(.item == "t-2") | [.outcome, .route] | join("|")' <<<"$body")" \
    "a finished delivery's outcome was not folded back onto his words"
  assert_equals "unknown" \
    "$(jq -r '.said[] | select(.item == "t-1") | .outcome' <<<"$body")" \
    "a delivery orphaned by a restart still claimed to be in progress"
  assert_contains "$(jq -r '.said[] | select(.item == "t-1") | .detail' <<<"$body")" \
    'restarted' "the orphaned delivery did not say why it is unknown"
  # A tab that was open across the restart polls with the tag the dead server
  # gave it. The same bytes now read differently, so that tag cannot answer
  # "nothing changed" over a row that has stopped being in progress.
  start_server "$home" || fail "the server did not start again"
  port=$SERVER_PORT
  etag=$(curl -s -m 30 -D - -o /dev/null "http://127.0.0.1:$port/api/said" \
    | tr -d '\r' | sed -n 's/^ETag: //p')
  [ -n "$etag" ] || fail "the record was served without a change check"
  code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    -H "If-None-Match: $etag" "http://127.0.0.1:$port/api/said")
  assert_equals 304 "$code" "an unchanged record was re-served to the same server"
  stop_server
  start_server "$home" || fail "the server did not start a third time"
  code=$(curl -s -m 30 -o /dev/null -w '%{http_code}' \
    -H "If-None-Match: $etag" "http://127.0.0.1:$SERVER_PORT/api/said")
  stop_server
  assert_equals 200 "$code" \
    "a tag from before the restart answered 304 over a delivery nothing is carrying out"
  pass "a delivery orphaned by a restart reads back as unknown, never as still running"
}

# The Stop hook fires in every worktree of this repo, so it must capture in a
# genuine primary checkout and stay inert everywhere else.
test_the_stop_hook_captures_in_a_primary_and_stays_inert_elsewhere() {
  local prim wt cfg enc
  prim="$TMP_ROOT/hook-primary"
  fm_git_identity
  fm_git_init_commit "$prim" >/dev/null 2>&1
  mkdir -p "$prim/bin" "$prim/state"
  touch "$prim/AGENTS.md"
  cfg="$TMP_ROOT/hook-claude"
  enc=$(python3 -c 'import re,sys; print(re.sub(r"[^A-Za-z0-9]","-",sys.argv[1]))' "$prim")
  seed_transcripts "$cfg/projects/$enc"

  # The payload NAMES the transcript, and that is the only thing that knows it:
  # the turn's own message is in the log by the time the hook returns, with no
  # cursor and nothing else having run first.
  entry r-hook end_turn false "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    '{"type":"text","text":"Said as the turn ended."}' >> "$cfg/projects/$enc/sess-1.jsonl"
  printf '{"transcript_path":"%s"}' "$cfg/projects/$enc/sess-1.jsonl" \
    | FM_ROOT_OVERRIDE="$prim" CLAUDE_CONFIG_DIR="$cfg" bash "$HOOK" \
    || fail "the hook exited nonzero in a primary checkout"
  assert_grep 'Said as the turn ended.' "$prim/data/captain-messages.jsonl" \
    "the hook did not capture the message the turn ended with"

  # A payload that names no transcript leaves the whole-directory backfill to
  # the server rather than holding a turn end on it.
  local bare="$TMP_ROOT/hook-bare"
  fm_git_init_commit "$bare" >/dev/null 2>&1
  mkdir -p "$bare/bin" "$bare/state"
  touch "$bare/AGENTS.md"
  printf '{}' | FM_ROOT_OVERRIDE="$bare" CLAUDE_CONFIG_DIR="$cfg" bash "$HOOK" \
    || fail "the hook exited nonzero on a payload naming no transcript"
  [ ! -e "$bare/state/.captain-message-capture" ] \
    || fail "the hook swept a whole directory for a payload that named nothing"

  wt="$TMP_ROOT/hook-worktree"
  git -C "$prim" worktree add -q "$wt" -b hook-wt
  mkdir -p "$wt/bin" "$wt/state"
  touch "$wt/AGENTS.md"
  printf '{}' | FM_ROOT_OVERRIDE="$wt" CLAUDE_CONFIG_DIR="$cfg" bash "$HOOK" \
    || fail "the hook exited nonzero in a task worktree"
  [ ! -e "$wt/state/.captain-message-capture" ] \
    || fail "the hook ran the sweep inside a child task worktree"

  local fresh="$TMP_ROOT/hook-cursor-host"
  fm_git_init_commit "$fresh" >/dev/null 2>&1
  mkdir -p "$fresh/bin" "$fresh/state"
  touch "$fresh/AGENTS.md"
  printf '{"cursor_version":"1.0"}' | FM_ROOT_OVERRIDE="$fresh" CLAUDE_CONFIG_DIR="$cfg" bash "$HOOK" \
    || fail "the hook exited nonzero on a foreign-host payload"
  [ ! -e "$fresh/state/.captain-message-capture" ] \
    || fail "a Cursor-delivered payload still ran the Claude-owned sweep"
  pass "the Stop hook captures in a primary checkout and stays inert everywhere else"
}

trap stop_server EXIT

test_only_live_captain_holds_are_carded
test_body_survives_the_record_separator
test_a_title_keeps_a_trailing_parenthetical
test_only_captain_kind_holds_are_his_to_answer
test_an_unreadable_backlog_is_reported_not_shown_as_empty
test_a_home_with_no_backlog_yet_is_empty_not_unreadable
test_deferred_hold_reports_its_date
test_branch_states_are_honest
test_status_decisions_are_carded_with_their_verb
test_status_decision_since_prefers_the_opening_line_timestamp
test_steering_records_report_delivered_and_picked_up
test_a_scan_that_cannot_read_everything_fails_instead_of_truncating
test_fingerprint_changes_only_when_a_record_moves
test_work_scan_reports_the_four_bearings_sections
test_work_scan_names_a_local_tasks_context
test_server_serves_the_page_and_the_records
test_the_work_board_is_served
test_server_refuses_bad_input_before_running_anything
test_a_server_with_no_scan_yet_refuses_both_the_list_and_a_send
test_answering_a_hold_records_the_captains_words_and_clears_the_item
test_answering_held_work_releases_it_instead_of_closing_it
test_a_held_row_with_no_kind_still_reaches_firstmate_as_a_note
test_a_note_of_just_a_dash_is_queued_and_never_hangs_the_server
test_a_send_whose_words_cannot_be_recorded_is_refused
test_an_unreadable_log_is_reported_not_shown_as_empty
test_the_send_outcome_is_decided_by_the_exit_code_alone
test_concurrent_polls_produce_one_scan
test_the_pages_decision_rules_hold
test_the_server_serves_the_pages_decision_rules
test_a_message_names_the_project_the_worktree_and_the_branch
test_a_taskless_message_is_matched_to_the_one_task_it_names
test_a_message_naming_two_tasks_is_left_blank_rather_than_guessed
test_a_message_for_a_task_whose_meta_is_gone_gets_its_backlog_repo
test_a_message_matched_to_a_registered_project_when_it_names_no_task
test_a_message_shows_every_project_a_turns_tool_calls_touched
test_a_worker_evidenced_project_is_not_joined_by_a_keyword_guess
test_message_backfill_resolves_only_context_keyed_by_a_task_record
test_message_backfill_attributes_by_the_same_turn_evidence
test_a_captured_message_carries_the_one_task_its_turn_touched
test_a_field_nothing_knows_is_recorded_as_unknown_not_guessed
test_a_recorded_message_never_glues_onto_a_torn_row
test_the_recorder_refuses_a_message_with_no_title_or_no_text
test_every_message_sent_while_he_was_away_comes_back_in_order
test_a_reply_takes_the_answer_route_when_the_task_is_still_waiting
test_a_reply_with_nothing_waiting_is_queued_for_firstmate
test_a_reply_to_a_message_this_home_never_recorded_is_refused
test_a_reply_never_resolves_its_task_against_another_home
test_a_reply_to_a_message_that_is_not_a_question_never_answers_a_decision
test_a_reply_is_never_delivered_as_a_note_while_no_scan_has_been_read
test_his_own_words_are_served_whole_and_never_shortened_quietly
test_the_click_returns_before_the_command_finishes
test_a_failed_read_is_never_cached_as_the_state_of_the_log
test_the_recorder_takes_a_body_that_looks_like_a_flag
test_the_ask_user_machine_line_is_stated_plainly_and_real_questions_are_not
test_a_send_whose_bonus_route_cannot_run_at_all_still_reaches_firstmate
test_a_reply_that_is_not_a_question_is_sent_even_with_no_scan
test_every_captured_message_is_reachable_without_serving_them_all
test_a_message_far_behind_the_window_is_served_by_id
test_an_archived_message_leaves_messages_and_can_be_restored
test_a_reply_archives_its_message_before_delivery_finishes
test_an_unchanged_message_poll_is_answered_without_the_log
test_a_search_finds_text_however_the_record_escapes_it
test_an_unreadable_message_log_is_reported_not_shown_as_empty
test_every_chat_message_is_captured_without_anyone_recording_it
test_a_hand_recorded_question_is_not_captured_a_second_time
test_a_transcript_the_payload_names_is_captured_wherever_it_lives
test_a_named_transcript_is_remembered_even_with_nothing_new_to_read
test_a_response_read_across_two_sweeps_is_recorded_once
test_a_torn_row_costs_itself_and_nothing_after_it
test_a_home_with_no_conversation_record_reports_capture_inactive
test_the_server_captures_the_conversation_with_no_agent_involved
test_a_delivery_orphaned_by_a_restart_reads_back_as_unknown
test_the_stop_hook_captures_in_a_primary_and_stays_inert_elsewhere
