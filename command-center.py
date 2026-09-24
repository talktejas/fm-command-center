#!/usr/bin/env python3
# command-center.py - the captain's permanent command center.
#
# One page at a fixed address showing everything waiting on the captain across
# every local firstmate home. His Waiting-on-you answer goes straight to the
# MAIN home's captain inbox (fm-inbox.sh note, FM_HOME always the main home)
# and nowhere else - no fm-captain-hold.sh, no fm-send.sh, from this send
# path - whatever home the item itself belongs to: an idle second mate (b2b,
# interact, ...) keeps no watcher running, so a note left in its own inbox
# waits unread. The note is prefixed with the item's own home and id (e.g.
# "[b2b · kk-xyz] ") so main firstmate forwards it on with fm-send, which does
# ring an idle second mate. bin/command-center-scan.sh is the reading half;
# docs/command-center.md is the operator guide.
#
# Usage:
#   command-center.py --home <FM_HOME> [--port 8765] [--firstmate-root <dir>]
#   command-center.py --install-unit --home <FM_HOME> [--port 8765]
#
# Standalone: this repo never copies or edits firstmate's own scripts. Sends
# and the automatic message capture run firstmate's bin/ scripts by path from
# --firstmate-root (default /home/tds/p/firstmate, or $FM_FIRSTMATE_ROOT).
#
# STDLIB ONLY, BY DESIGN. No dependency to install, no lockfile to refresh, no
# build step, nothing that rots between uses. The whole server is http.server,
# json and subprocess.
#
# POLLING, NOT A HELD CONNECTION. The page asks for /api/items every few seconds
# and gets 304 when nothing moved. Server-sent events would hold one connection
# per open tab, and a browser allows only six per origin - the same limit that
# already stalls this fleet's review pages once six are open. A held stream also
# pins a ThreadingHTTPServer thread that is only reclaimed on the next write, so
# a forgotten tab leaks. The change check is a stat sweep costing ~30ms, so the
# expensive scan runs once per actual change however many tabs are open.
#
# IT STORES TWO THINGS, AND ONLY BECAUSE NOTHING ELSE DOES.
#
# data/captain-messages.jsonl is what firstmate SAID to the captain. The
# terminal was the only other copy and a terminal scrolls, so the page's
# default list is that log: it is the whole point of this surface, and
# firstmate's own work records are not a substitute for it. It is filled two
# ways: automatically, by bin/fm-captain-message-sweep.py reading the
# conversation record (run by the Claude Stop hook and by this server, so no
# agent has to remember anything), and by hand with bin/fm-captain-message.sh
# for messages said outside that record. The page carries the capture's own
# health and says when the list may be incomplete.
#
# A SEND RETURNS BEFORE IT DELIVERS. His words are appended durably first, the
# page hears "accepted" at once, and the command that owns delivery runs in a
# thread behind it (accept_said); the outcome lands on the record when known
# and the page's next poll shows it. He never watches a spinner over a scan or
# a slow steer.
#
# data/command-center/said.jsonl is what HE said back. Firstmate already keeps
# the questions and the answers that close a decision, so copying those here
# would create a second truth that can drift. What firstmate does NOT keep is
# the captain's own words in three cases: a steer to a worker is deleted with
# the task's steering inbox at teardown (bin/fm-teardown.sh), an unsent draft
# never existed, and terminal text is only scrollback. So this appends every
# word he sends to that log, and stores nothing else.
#
# Drafts and read state stay in the browser, because they are his and this runs
# on his machine.
#
# TRUST BOUNDARY. It binds loopback only and runs firstmate's own scripts with
# the captain's authority, which is the point of it; it is not an authenticated
# multi-user surface and must never be bound to a routable address. Every
# request field that reaches a command is validated against the scanned record
# set first, and text reaches scripts as an argument or a file, never a shell
# string.
import argparse
import collections
import hashlib
import json
import os
import re
import subprocess
import sys
import threading
import time
import urllib.parse
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

BIN = os.path.dirname(os.path.abspath(__file__))
WEB = os.path.join(BIN, "web")
PAGE = os.path.join(WEB, "command-center.html")
# The page's decision rules, in their own file so tests can execute them.
RULES = os.path.join(WEB, "command-center-state.js")
SCAN = os.path.join(BIN, "command-center-scan.sh")
WORK = os.path.join(BIN, "command-center-work.sh")

DEFAULT_FIRSTMATE_ROOT = "/home/tds/p/firstmate"

# This repo is standalone: it never copies or edits firstmate's own scripts,
# it calls them by path from a configurable firstmate checkout. Read from
# $FM_FIRSTMATE_ROOT at import time so a caller that uses this module directly
# (without going through main()) still gets a sane default; main() overrides
# it from --firstmate-root.
FIRSTMATE_ROOT = os.environ.get("FM_FIRSTMATE_ROOT", DEFAULT_FIRSTMATE_ROOT)


def firstmate_bin(name):
    return os.path.join(FIRSTMATE_ROOT, "bin", name)


# The automatic capture of what firstmate said (its header owns the mechanics).
def sweep_path():
    return firstmate_bin("fm-captain-message-sweep.py")

# tasks-axi's own limit on a recorded decision (bin/fm-captain-hold.sh).
MAX_TEXT = 8192
ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
SCAN_TIMEOUT = 240
SEND_TIMEOUT = 120
SCAN_WAIT = 30


def dump(obj):
    """Compact JSON for the wire: no filler whitespace on a 3-second poll."""
    return json.dumps(obj, separators=(",", ":")).encode()


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class Records:
    """The scanned view, refreshed only when a record actually moved.

    `fingerprint` is a cheap stat sweep; `payload` is the full scan. Callers get
    a (etag, json-bytes) pair, so an unchanged poll answers 304 with no body.
    """

    def __init__(self, home):
        self.home = home
        self.etag = None
        self.body = b"{}"
        self.error = None
        self.checked = float("-inf")
        # ThreadingHTTPServer gives every open tab its own thread, so the etag
        # and the body it names must become visible together or a reader can
        # store a new etag against an old list and 304 on it forever.
        self.lock = threading.Lock()
        # And one scan per change however many tabs poll, as the header promises:
        # a thread that cannot take this serves the snapshot instead of forking
        # its own jq-per-item scan beside the one already running.
        self.scan = threading.Lock()

    def snapshot(self):
        with self.lock:
            return self.etag, self.body

    def invalidate(self):
        # Force the next scan without unpublishing: a null etag means "never
        # scanned" and nothing else, or a poll right after a send would be told
        # records it has been reading for hours have never been read.
        self.checked = float("-inf")

    def _run(self, args, timeout):
        env = dict(os.environ, FM_HOME=self.home, FM_FIRSTMATE_ROOT=FIRSTMATE_ROOT)
        return subprocess.run(
            args, capture_output=True, text=True, timeout=timeout, env=env,
            stdin=subprocess.DEVNULL, check=False
        )

    def refresh(self, min_interval=1.0):
        if self.etag is not None and time.monotonic() - self.checked < min_interval:
            return
        if self.scan.acquire(blocking=False):
            try:
                self._refresh_locked(min_interval)
            finally:
                self.scan.release()
            return
        # Someone is already scanning these very records: wait for THEIR result
        # rather than starting a second scan beside it or repeating it after.
        if self.scan.acquire(timeout=SCAN_WAIT):
            self.scan.release()

    def _refresh_locked(self, min_interval):
        now = time.monotonic()
        if now - self.checked < min_interval:
            return
        self.checked = now
        try:
            fp = self._run([SCAN, "--fingerprint"], 30)
        except subprocess.SubprocessError as exc:
            self.error = f"change check failed: {exc}"
            return
        if fp.returncode != 0:
            self.error = f"change check failed: {fp.stderr.strip()[:400]}"
            return
        etag = hashlib.sha256(fp.stdout.encode()).hexdigest()[:32]
        if etag == self.etag:
            self.error = None
            return
        try:
            out = self._run([SCAN], SCAN_TIMEOUT)
        except subprocess.SubprocessError as exc:
            self.error = f"scan failed: {exc}"
            return
        if out.returncode != 0:
            self.error = f"scan failed: {out.stderr.strip()[:400]}"
            return
        try:
            data = json.loads(out.stdout)
        except json.JSONDecodeError as exc:
            self.error = f"scan produced unreadable output: {exc}"
            return
        self.error = None
        with self.lock:
            self.etag = etag
            self.body = dump(data)

    def view(self):
        return json.loads(self.body)

    def home_path(self, home_id):
        for home in self.view().get("homes", []):
            if home["id"] == home_id:
                return home["path"]
        return None

    def waiting_question(self, task_id, key):
        """The decision a recorded QUESTION asked about, or None when it is settled.

        Only the decision the message itself named can answer it. A task
        collects several messages over its life - a question, then a PR, then a
        result - so answering whatever decision the task happens to be stopped
        on now would write his reply to a question he was not looking at. A key
        names a stopped worker's own decision; no key means the captain hold
        this home filed.

        Only THIS home's items can answer it. The message log belongs to the
        home this server was started on, and two homes on one machine can hold
        the same task id (bin/fm-backend-hometag-lib.sh), so matching across
        them would deliver his words to an unrelated worker.
        """
        if not task_id or not ID_RE.match(task_id):
            return None
        view = self.view()
        mine = {h["id"] for h in view.get("homes", [])
                if os.path.realpath(h["path"]) == os.path.realpath(self.home)}
        for it in view.get("items", []):
            if it["id"] != task_id or it["home"] not in mine:
                continue
            if key:
                if it["source"] == "status" and (it.get("key") or "") == key:
                    return it
            elif it["source"] == "hold":
                return it
        return None

    def item(self, home_id, task_id, source, key):
        # A task can be waiting twice at once - captain-held AND stopped on its
        # own status record - and the two are answered by different commands, so
        # the record it came from is part of its identity, not a detail of it.
        for it in self.view().get("items", []):
            if (it["home"], it["id"], it["source"], it.get("key") or "") \
                    == (home_id, task_id, source, key):
                return it
        return None


def item_key(item):
    """The identity the page uses too (itemKey in bin/command-center.html)."""
    return "/".join([item["home"], item["source"], item["id"], item.get("key") or ""])


class Work:
    """The /bearings lavish board's four sections, cached on their own clock.

    bin/command-center-work.sh shells out to fm-bearings-snapshot.sh, which does
    bounded remote-ledger reads and is too slow to run on the 3-second /api/items
    cadence, so this refreshes on a plain time interval rather than a change
    check. A stale board a few seconds behind is a fair price for a compact
    poll; an /api/items request blocked behind a fleet-wide scan is not.
    """

    MIN_INTERVAL = 15.0

    def __init__(self, home):
        self.home = home
        self.lock = threading.Lock()
        self.body = None
        self.error = None
        self.checked = float("-inf")
        self.scan = threading.Lock()

    def refresh(self):
        if self.body is not None and time.monotonic() - self.checked < self.MIN_INTERVAL:
            return
        if not self.scan.acquire(blocking=False):
            return  # someone else is already refreshing; this poll shows what stands
        # The shell-out beneath this (fm-bearings-snapshot.sh) can run for tens
        # of seconds; a caller's own click must never wait behind it, only its
        # own last-known board. The FIRST refresh (self.body is still None) is
        # the one exception - there is no stale board yet to serve.
        if self.body is not None:
            threading.Thread(target=self._refresh_release, daemon=True).start()
            return
        try:
            self._refresh_locked()
        finally:
            self.scan.release()

    def _refresh_release(self):
        try:
            self._refresh_locked()
        finally:
            self.scan.release()

    def _refresh_locked(self):
        if self.body is not None and time.monotonic() - self.checked < self.MIN_INTERVAL:
            return
        self.checked = time.monotonic()
        env = dict(os.environ, FM_HOME=self.home, FM_FIRSTMATE_ROOT=FIRSTMATE_ROOT)
        try:
            proc = subprocess.run(
                [WORK], capture_output=True, text=True, timeout=90,
                env=env, stdin=subprocess.DEVNULL, check=False)
        except (OSError, subprocess.SubprocessError) as exc:
            self.error = f"the work board could not be read: {exc}"
            return
        if proc.returncode != 0:
            self.error = f"the work board could not be read: {proc.stderr.strip()[:400]}"
            return
        try:
            json.loads(proc.stdout)
        except json.JSONDecodeError as exc:
            self.error = f"the work board produced unreadable output: {exc}"
            return
        self.error = None
        with self.lock:
            self.body = proc.stdout.encode()

    def snapshot(self):
        with self.lock:
            return self.body


class MessageCapture:
    """Keeps the automatic message capture running and reports its health.

    The sweep itself (bin/fm-captain-message-sweep.py) is fired by the Claude
    Stop hook at every turn end; this server runs it as a BACKSTOP - for a
    session no hook reported, and for a turn that ended without a Stop
    (interrupt, crash, kill) - and so the page can say when capture is broken
    rather than quietly showing a short list.

    It runs the script the way every other caller does, as its own process off
    the request path: the sweep's own file lock serializes the two, and nothing
    the sweep can do to itself can take this page down. A minute between runs
    is a backstop's cadence and leaves an interpreter start-up beneath notice.
    """

    MIN_INTERVAL = 60.0

    def __init__(self, home):
        self.home = home
        self.lock = threading.Lock()
        self.last = float("-inf")
        self.thread = None
        self.run_error = None

    def ensure(self):
        with self.lock:
            if self.thread and self.thread.is_alive():
                return
            if time.monotonic() - self.last < self.MIN_INTERVAL:
                return
            self.last = time.monotonic()
            self.thread = threading.Thread(target=self._run, daemon=True)
            self.thread.start()

    def _run(self):
        try:
            proc = subprocess.run(
                [sys.executable, sweep_path(), "--home", self.home],
                capture_output=True, text=True, timeout=SEND_TIMEOUT,
                stdin=subprocess.DEVNULL, check=False)
            self.run_error = None if proc.returncode == 0 else (
                f"the sweep exited {proc.returncode}: "
                f"{proc.stderr.strip()[:200]}".strip())
        except (OSError, subprocess.SubprocessError) as exc:
            self.run_error = str(exc)

    def status(self):
        """What the page's incompleteness rule decides from (captureBand in
        bin/command-center-state.js). The sweep's own record is the truth of
        the last capture whoever ran it; run_error only says this server's own
        attempts are failing too."""
        path = os.path.join(self.home, "state", ".captain-message-capture")
        try:
            with open(path, encoding="utf-8") as fh:
                data = json.load(fh)
            if not isinstance(data, dict):
                raise ValueError("not a record")
        except (OSError, ValueError):
            return {"present": False, "run_error": self.run_error}
        at = data.get("at")
        try:
            age = int(time.time()) - int(datetime.strptime(
                at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp())
        except (TypeError, ValueError):
            age = None
        return {"present": True, "ok": data.get("ok"), "error": data.get("error"),
                "active": data.get("active"), "named": data.get("named"),
                "at": at, "age_secs": age, "run_error": self.run_error}


def message_log(home):
    """What firstmate said to him, captured automatically by the sweep and
    recorded by hand with bin/fm-captain-message.sh."""
    return os.path.join(home, "data", "captain-messages.jsonl")


def said_log(home):
    """The one log, in the home this server was started on.

    Every entry lands here whichever home the answer went to - the record
    carries that - because this is the only log /api/said reads back.
    """
    return os.path.join(home, "data", "command-center", "said.jsonl")


def message_context_cache_path(home):
    """Where each message's resolved project/worktree/branch is cached, keyed
    by message id, so /api/messages does not re-read the backlog and every
    matching transcript on every poll (see enrich_messages)."""
    return os.path.join(home, "data", "command-center", "message-context.json")


def parked_log(home):
    """Where Archive and Hold live for a Waiting-on-you item or a My words
    conversation - browser localStorage was fragile (gone on a refresh in a
    private window, invisible from another browser), so this is the
    command center's own durable record, the same promise said.jsonl already
    makes for what he typed. A message's own Archive stays on the log it
    already had (captain-messages.jsonl, record_archive) since that already
    works and is shared with Messages/Archived; only a message's Hold - which
    never had a server record at all - lands here too, target "message".
    """
    return os.path.join(home, "data", "command-center", "parked.jsonl")


def record_parked(home, target, key, state):
    """Append one parking amendment. `state` is "archived", "held" or "none"
    (back to its ordinary list) - the latest amendment for a (target, key)
    pair wins, read back by read_parked.
    """
    entry = {"kind": "park", "target": target, "of": key,
             "state": state, "at": utc_now()}
    try:
        path = parked_log(home)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        return f"the archive/hold record could not be written: {exc}"
    return None


def read_parked(home):
    """{(target, key): "archived"|"held"} for every row still parked - a row
    whose latest amendment is "none" is left out entirely, the same as one
    never parked at all. Newest first, so the first amendment seen per pair
    is the one that stands.
    """
    rows, _error, _dropped = read_log(parked_log(home), limit=200000)
    seen = set()
    parked = {}
    for row in rows:
        pair = (row.get("target"), row.get("of"))
        if pair in seen or not pair[1]:
            continue
        seen.add(pair)
        if row.get("state") in ("archived", "held"):
            parked[pair] = row["state"]
    return parked


# Appends to said.jsonl come from request threads and delivery threads alike;
# one lock keeps each line whole. SENDING holds the ids of deliveries this
# process is still running, so a "sending" record with no outcome yet is
# distinguishable from one a restart orphaned.
RUN = uuid.uuid4().hex
SAID_LOCK = threading.Lock()
SENDING = set()

RESTART_DETAIL = ("the command center restarted while this was being delivered "
                  "- it may or may not have arrived, so check before sending it again")


def record_said(home, entry):
    """Append one line to the convenience view this server keeps.

    Returns None, or what to tell him when the line did not land. An amendment
    that cannot be written is bookkeeping his delivery does not depend on, so
    those callers ignore it; the acceptance of a send does not - see
    accept_said. A failed send is recorded too: what he typed is what this file
    is for.
    """
    path = said_log(home)
    try:
        with SAID_LOCK:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except OSError as exc:
        sys.stderr.write(f"command-center: could not write {path}: {exc}\n")
        return f"what you typed could not be recorded: {exc}"
    return None


def accept_said(home, entry, deliver):
    """The fast half of a send: his words on disk first, delivery behind.

    Returns (sid, error). The entry is appended with outcome "sending" BEFORE
    this returns, so the words are durable by the time the page says accepted;
    when that append fails nothing is delivered and the error comes back, so
    the page can keep his words in the box rather than clear them over a send
    no record holds. `deliver` then runs in its own thread and must return the
    fields of the outcome record - at least outcome, route and detail - which
    is appended as an amendment (kind "outcome") that read_said folds back into
    the entry. A delivery that raises is recorded as unknown rather than lost:
    the command may have run before whatever threw, so the page must not offer
    to send the same words again as though nothing had left this machine.
    """
    sid = uuid.uuid4().hex[:12]
    with SAID_LOCK:
        SENDING.add(sid)
    error = record_said(home, dict(entry, sid=sid, at=utc_now(), outcome="sending"))
    if error:
        with SAID_LOCK:
            SENDING.discard(sid)
        return None, error

    def run():
        try:
            update = deliver()
        except Exception as exc:  # noqa: BLE001 - the record must say something
            update = {"outcome": "unknown", "route": "", "detail": str(exc)}
        # The amendment lands before the id leaves SENDING, so no read can see
        # a live delivery as a restart-orphaned one.
        record_said(home, dict(update, kind="outcome", of=sid, at=utc_now()))
        with SAID_LOCK:
            SENDING.discard(sid)

    # Not a daemon: his words were accepted, and a delivery already started
    # must finish even if the server is asked to stop.
    threading.Thread(target=run).start()
    return sid, None


def read_log(path, limit=500):
    """Returns (rows, error, dropped), newest first.

    A log that is not there yet is honestly empty; one that cannot be READ is a
    different state, and reporting it as empty would tell the captain he has
    never typed anything - or that firstmate never said anything to him.

    `dropped` is every line the list does not carry, whether the limit cut it
    or it could not be parsed at all, because a list shortened without saying
    so is the same silent loss this page exists to end.

    Only `limit` rows are ever held at once: the log is append-only and never
    pruned, so materialising all of it to keep the tail would make the cap a
    comment rather than a bound.
    """
    rows = collections.deque(maxlen=limit)
    lines = 0
    try:
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                lines += 1
                try:
                    rows.append(json.loads(line))
                except json.JSONDecodeError:
                    continue
    except FileNotFoundError:
        return [], None, 0
    except OSError as exc:
        return [], f"the record could not be read: {exc}", 0
    return list(rows)[::-1], None, max(0, lines - len(rows))


def log_etag(path):
    """A change check over the log's own (mtime, size), not its contents.

    The page polls this on the item cadence, so an unchanged log must cost a
    stat rather than a full parse and re-serialize of every message.
    """
    try:
        st = os.stat(path)
    except OSError:
        return None
    return hashlib.sha256(
        f"{st.st_mtime_ns}/{st.st_size}".encode()).hexdigest()[:32]


# He reads his own words, not a page of them: the whole said log is served, and
# the cap is only there so an unbounded file cannot exhaust this process. The
# reply thread under a message is read out of the said log, so a shortened said
# log would make an answered message read as unanswered. A send writes two lines
# there - his words, then their outcome - so the cap is counted in lines.
LOG_LIMIT = 40000


def resolve_send_home(records, home_ref):
    """The filesystem path a send's "home" field names - "main" is this
    server's own home (records.home is already a path), anything else is a
    fleet home id looked up the way every other route does."""
    if not home_ref or home_ref == "main":
        return records.home
    return records.home_path(home_ref)


def inbox_fingerprint(home_path):
    """(mtime, size) of state/inbox and state/inbox/handled - an ack moves a
    note between them, so this changes the moment firstmate drains, without
    parsing said.jsonl first to find out which note ids are even outstanding.
    """
    parts = []
    for sub in ("state/inbox", "state/inbox/handled"):
        try:
            st = os.stat(os.path.join(home_path, sub))
            parts.append(f"{st.st_mtime_ns}:{st.st_size}")
        except OSError:
            parts.append("-")
    return "/".join(parts)


def note_received(home_path, note_id):
    """True once firstmate has acked the note (fm-inbox.sh drain --ack moves
    it from state/inbox/ to state/inbox/handled/) - the yellow-dot fact.
    """
    if not home_path or not note_id:
        return False
    return os.path.exists(
        os.path.join(home_path, "state", "inbox", "handled", f"{note_id}.note"))


def parse_note_file(path):
    """(id, at, body) from a state/inbox .note file, or None if unreadable.
    Format written by fm-inbox.sh's queue_note: header lines, a bare "--"
    line, then the body - see bin/fm-inbox.sh.
    """
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as fh:
            raw = fh.read()
    except OSError:
        return None
    head, sep, body = raw.partition("\n--\n")
    if not sep:
        return None
    at = None
    for line in head.splitlines():
        if line.startswith("at="):
            at = line[len("at="):]
            break
    note_id = os.path.splitext(os.path.basename(path))[0]
    return note_id, at, body


def find_queued_note(home_path, text, at, window_seconds=900):
    """Recover a note id for a send that was queued but whose outcome came
    back "unknown" - e.g. the decode failure this file used to hit on a
    multi-byte reply (see send_note). Looks in both state/inbox (not yet
    acked) and state/inbox/handled (already acked) for a note whose body
    carries his exact words and whose own timestamp is close to when this
    send was accepted. Never invented: no match, no id.
    """
    if not home_path or not text or not text.strip():
        return None
    try:
        sent_at = datetime.fromisoformat((at or "").replace("Z", "+00:00"))
    except ValueError:
        sent_at = None
    needle = text.strip()
    best_id, best_delta = None, None
    for sub in ("state/inbox", "state/inbox/handled"):
        try:
            names = os.listdir(os.path.join(home_path, sub))
        except OSError:
            continue
        for name in names:
            if not name.endswith(".note"):
                continue
            parsed = parse_note_file(os.path.join(home_path, sub, name))
            if not parsed:
                continue
            note_id, note_at, body = parsed
            if needle not in body:
                continue
            if sent_at is None or not note_at:
                delta = 0
            else:
                try:
                    delta = abs((datetime.fromisoformat(
                        note_at.replace("Z", "+00:00")) - sent_at).total_seconds())
                except ValueError:
                    delta = 0
                if delta > window_seconds:
                    continue
            if best_delta is None or delta < best_delta:
                best_id, best_delta = note_id, delta
    return best_id


def read_said(records, limit=LOG_LIMIT):
    """His words, newest first, with each delivery's outcome folded back in.

    A send is two lines: the entry written as it was accepted (outcome
    "sending") and the outcome amendment written when delivery finished. They
    are folded here so the page sees one record per send. An entry still
    "sending" that this process is not delivering was orphaned by a restart:
    delivery is genuinely unknown, and unknown is what it says.
    """
    home = records.home
    # Sampled on BOTH sides of the read and unioned: a delivery that finished
    # during the read is still in the first sample, one that started during it
    # is in the second, so neither a live nor a finished send can be read back
    # as restart-orphaned.
    with SAID_LOCK:
        in_flight = set(SENDING)
    rows, error, dropped = read_log(said_log(home), limit)
    with SAID_LOCK:
        in_flight |= SENDING
    if error:
        return [], error, 0
    outcomes = {}
    for row in rows:                       # newest first, so first wins
        if row.get("kind") == "outcome" and row.get("of"):
            outcomes.setdefault(row["of"], row)
    merged = []
    for row in rows:
        if row.get("kind") == "outcome":
            continue
        sid = row.get("sid")
        update = outcomes.get(sid) if sid else None
        if update:
            row = dict(row, **{k: v for k, v in update.items()
                               if k not in ("kind", "of", "at", "sid")})
            if update.get("resolved"):
                row["kind"] = update["resolved"]
        elif row.get("outcome") == "sending" and sid not in in_flight:
            row = dict(row, outcome="unknown", detail=RESTART_DETAIL)
        merged.append(row)
    parked = read_parked(home)
    merged = [dict(r, archived=parked.get(("word", word_conversation_key(r))) == "archived",
                   held=parked.get(("word", word_conversation_key(r))) == "held")
              for r in merged]
    merged = [_repair_unknown_outcome(records, r) for r in merged]
    merged = [dict(r, received=bool(r.get("note_id")) and note_received(
                  resolve_send_home(records, r.get("home")), r.get("note_id")))
              for r in merged]
    return merged, None, dropped


def _repair_unknown_outcome(records, row):
    """An "unknown" outcome from before send_note decoded subprocess output
    with errors="replace" can hide a note that was actually queued (see
    find_queued_note) - show it as sent, not NOT SENT, once its id can be
    found. Never invented: a row this can't place stays unknown.
    """
    if row.get("outcome") != "unknown" or row.get("note_id"):
        return row
    home_path = resolve_send_home(records, row.get("home"))
    note_id = find_queued_note(home_path, row.get("text"), row.get("at"))
    if not note_id:
        return row
    return dict(row, outcome="sent", note_id=note_id)


def word_conversation_key(row):
    """The same grouping key My words itself uses (wordConversationKey in
    web/command-center-state.js): a message it replied to, or the item/note
    key otherwise. Archive and Hold are per conversation, not per send, so
    every row in one conversation shares one parked state.
    """
    if row.get("msg"):
        return "msg/" + row["msg"]
    return row.get("item_key") or row.get("key") or ""


# --- message context enrichment ----------------------------------------------
# What firstmate itself resolves (bin/fm-captain-message-sweep.py at capture
# time, bin/fm-captain-message-backfill.py after) is only ever the ONE task a
# turn touched, and only from that task's live state/<id>.meta - by design,
# neither guesses further than that. Most messages still deserve a project,
# worktree and branch whenever the fleet's own records make exactly one
# reading honest: a task whose meta is gone (its backlog line, or the live
# scan, still knows its repo), and a message that named no task at all
# (matched against every task id and project slug the fleet knows, kept only
# when exactly one matches). Nothing here is written back to firstmate's log -
# it is recomputed from the current records on every read that actually
# serves a body, the same promise the rest of this page makes.
BACKLOG_LINE_RE = re.compile(r'^- \[[ x]\] (\S+) - ')
BACKLOG_REPO_RE = re.compile(r'\(repo: ([^()]*)\)')
PROJECTS_LINE_RE = re.compile(r'^- (\S+)(?:\s+\[[^\]]*\])?\s*-\s*(.*)$')
PROJECTS_REPO_RE = re.compile(r'talktejas/([A-Za-z0-9._-]+)')

# Words the captain uses for a project that its own data/projects.md line
# never spells out (a nickname, a module, a page name) - his own list, kept
# by hand rather than guessed from the record.
FIXED_PROJECT_ALIASES = {
    "jt2627s": {"jeweltrek", "currency", "diamond", "metals", "manufacturing",
                "sale", "sales order"},
    "interactp": {"interact"},
    "b2becom": {"karatcraft", "b2b"},
    "fm-command-center": {"command center", "archive", "work tab", "waiting on you",
                          "capture", "message-capture"},
    "firstmate": {"firstmate"},
    "mp": {"bangkok", "mp-bkk"},
}


def _tasks_toml_backlog_rel(firstmate_root):
    """The backlog file's path relative to a HOME, or None off the markdown
    backend (bin/command-center-scan.sh's backlog_path, read again here)."""
    try:
        with open(os.path.join(firstmate_root, ".tasks.toml"), encoding="utf-8") as fh:
            text = fh.read()
    except OSError:
        return "data/backlog.md"
    backend = "markdown"
    m = re.search(r'^backend\s*=\s*"([^"]*)"', text, re.MULTILINE)
    if m:
        backend = m.group(1)
    if backend != "markdown":
        return None
    m = re.search(r'^path\s*=\s*"([^"]*)"', text, re.MULTILINE)
    return m.group(1) if m and m.group(1) else "data/backlog.md"


def backlog_index(firstmate_root, home):
    """task id -> repo, for every task line the backlog names, open or
    closed - unlike bin/command-center-scan.sh's held_tasks, which only ever
    reads the open captain holds it cards."""
    idx = {}
    rel = _tasks_toml_backlog_rel(firstmate_root)
    if not rel:
        return idx
    try:
        with open(os.path.join(home, rel), encoding="utf-8") as fh:
            for line in fh:
                m = BACKLOG_LINE_RE.match(line)
                if not m:
                    continue
                rm = BACKLOG_REPO_RE.search(line)
                idx[m.group(1)] = rm.group(1) if rm else None
    except OSError:
        pass
    return idx


def brief_task_ids(home):
    """Every task id with its own data/<id>/ folder and a launch brief - the
    universe transcript and message-text matching search beyond the backlog
    and the live scan, since a one-off deliverable (research, a scrape) gets
    a folder and a brief but never a tracked backlog line at all."""
    try:
        names = os.listdir(os.path.join(home, "data"))
    except OSError:
        return set()
    return {name for name in names if len(name) > 2
            and (os.path.isfile(os.path.join(home, "data", name, "launch-brief.md"))
                 or os.path.isfile(os.path.join(home, "data", name, "brief.md")))}


def project_aliases(home):
    """slug -> the words that name it: its own slug, its repo name(s) from
    data/projects.md (so a PR URL's talktejas/<repo> matches by the same
    word-boundary search as any other word), the plain-English name leading
    its description, and FIXED_PROJECT_ALIASES - the vocabulary a message's
    own words are matched against when it names no task."""
    aliases = {slug: set(words) for slug, words in FIXED_PROJECT_ALIASES.items()}
    try:
        with open(os.path.join(home, "data", "projects.md"), encoding="utf-8") as fh:
            lines = fh.readlines()
    except OSError:
        lines = []
    for line in lines:
        m = PROJECTS_LINE_RE.match(line)
        if not m:
            continue
        slug, desc = m.group(1), m.group(2)
        bucket = aliases.setdefault(slug, set())
        bucket.add(slug)
        for repo in PROJECTS_REPO_RE.findall(line):
            bucket.add(repo)
        name = re.split(r'[,;(]', desc, maxsplit=1)[0].strip()
        if name:
            bucket.add(name)
    return aliases


def _word_present(haystack, token, ignore_case=False):
    """Is `token` in `haystack` as its own word (or phrase), not as a slice of
    a longer one? An id, slug, repo name or alias phrase is never a substring
    match away from a false one."""
    if not token:
        return False
    flags = re.IGNORECASE if ignore_case else 0
    return re.search(r'(?<![A-Za-z0-9_-])' + re.escape(token) + r'(?![A-Za-z0-9_-])',
                      haystack, flags) is not None


def _item_for_task(view, task_id):
    for it in view.get("items", []):
        if it.get("id") == task_id:
            return it
    return None


BRIEF_WORKTREE_RE = re.compile(r'disposable git worktree of (\S+?)[,.\s]')


def _task_brief_project(home, task_id, project_aliases_map):
    """The project named in a task's own launch brief - `You are in a
    disposable git worktree of <repo>` - for a task whose meta is gone AND
    whose backlog line, closed or not, was never written (a task the
    captain gave a folder and a brief but no tracked backlog id, e.g. a
    one-off research deliverable). Read straight from data/<id>/, never
    firstmate's own state."""
    for name in ("launch-brief.md", "brief.md"):
        try:
            with open(os.path.join(home, "data", task_id, name), encoding="utf-8") as fh:
                text = fh.read()
        except OSError:
            continue
        m = BRIEF_WORKTREE_RE.search(text)
        if not m:
            continue
        token = os.path.basename(m.group(1))
        for slug, aliases in project_aliases_map.items():
            if token == slug or token in aliases:
                return slug
    return None


def _task_context(task_id, view, backlog_idx, home=None, project_aliases_map=None):
    """(project, worktree, branch) known about one task id, from the live
    scan first (it already carries the same fields command-center-scan.sh
    computes for every waiting item), the backlog's repo next (a Done row
    keeps its `(repo: X)` exactly like a Queued one), and its own brief's
    named worktree last, for a task the backlog never carried at all."""
    item = _item_for_task(view, task_id)
    if item:
        return item.get("project"), item.get("worktree"), item.get("branch")
    if task_id in backlog_idx:
        return backlog_idx[task_id], None, None
    if home is not None and project_aliases_map is not None:
        p = _task_brief_project(home, task_id, project_aliases_map)
        if p:
            return p, None, None
    return None, None, None


def _projects_named_in(haystack, project_aliases_map):
    """Every project whose own vocabulary (slug, repo name, description name,
    fixed alias) appears in `haystack` as a standalone word or phrase -
    never just one arbitrarily picked when several are named."""
    return {slug for slug, aliases in project_aliases_map.items()
            if any(len(a) > 2 and _word_present(haystack, a, ignore_case=True)
                   for a in aliases)}


def transcript_dir(home):
    """Where the Claude conversation record for this home's own sessions
    lives - the same derivation bin/fm-captain-message-sweep.py's
    default_transcript_dir uses, so a captured row's own `session` is found
    in the one place it was ever written."""
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.expanduser("~/.claude")
    encoded = re.sub(r"[^A-Za-z0-9]", "-", os.path.abspath(home))
    return os.path.join(base, "projects", encoded)


def _turn_is_prompt(entry):
    content = (entry.get("message") or {}).get("content")
    if isinstance(content, str):
        return True
    return isinstance(content, list) and not any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def session_turns(a_transcript_dir, session):
    """requestId -> the raw text of that turn: the user/system turn that
    triggered it (a prompt entry resets the turn, exactly as
    bin/fm-captain-message-sweep.py's own turn boundary does) plus every tool
    call input made since. Read fresh from the transcript on every call and
    never written anywhere - the same one-step-further-at-read-time promise
    the rest of this page's enrichment makes."""
    turns = {}
    parts = []
    try:
        with open(os.path.join(a_transcript_dir, session + ".jsonl"), encoding="utf-8") as fh:
            for raw in fh:
                try:
                    entry = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if not isinstance(entry, dict) or entry.get("isSidechain"):
                    continue
                etype = entry.get("type")
                if etype == "user":
                    if _turn_is_prompt(entry):
                        parts = [json.dumps((entry.get("message") or {}).get("content"),
                                            ensure_ascii=False)]
                    continue
                if etype != "assistant":
                    continue
                message = entry.get("message")
                if not isinstance(message, dict):
                    continue
                for block in message.get("content") or []:
                    if isinstance(block, dict) and block.get("type") == "tool_use":
                        parts.append(json.dumps(block.get("input"), ensure_ascii=False))
                req = entry.get("requestId") or entry.get("uuid") or ""
                if req:
                    turns[req] = "\n".join(parts)
    except OSError:
        pass
    return turns


def transcript_task_ids(row, a_transcript_dir, known_ids, cache):
    """Every known task id the transcript turn behind this message's own
    req/session touched - a state/<id>.* path, a data/<id>/ path, a
    fm-*.sh <id> argument, a wake line naming it, or anything else that puts
    the id in the turn's own tool calls or the words that started it, since a
    known id is never a boundary match away from a false one wherever it
    appears. A row with no session, or one this machine has no transcript
    for (another home's crewmate, a hand-written row), yields nothing."""
    session, req = row.get("session"), row.get("req")
    if not session or not req:
        return set()
    if session not in cache:
        cache[session] = session_turns(a_transcript_dir, session)
    text = cache[session].get(req)
    if not text:
        return set()
    return {tid for tid in known_ids if _word_present(text, tid)}


# Before this moment the command center was still code inside firstmate's own
# tree, not yet the separate fm-command-center repo (added to data/projects.md
# at this same moment) - a message about "the command center" from before it
# read as firstmate, and still does here.
COMMAND_CENTER_SPLIT = "2026-09-21T09:30:00Z"


def message_context(row, view, backlog_idx, project_aliases_map,
                     a_transcript_dir=None, transcript_cache=None, home=None,
                     brief_ids=frozenset()):
    """(project, worktree, branch, source) to fill in beyond what the row
    already carries, or all-None when nothing more can be said honestly.
    The captain's own order of precedence: which worker/task the turn that
    said this was handling - its explicit task, or every id its transcript
    turn touched - mapped through that task's own record, is checked FIRST
    and is the only source used once it names anything at all. Only when
    that finds nothing does the message's own words get checked, against
    every task id and every registered project's vocabulary. `project` may
    name several projects, joined by " · ", when that tier's own evidence
    names more than one; `worktree`/`branch` are only ever filled when
    exactly one task resolves them. `source` names where a filled value
    came from, for a quiet note beside it - never set when nothing was
    actually filled."""
    have = {f: bool(row.get(f)) for f in ("project", "worktree", "branch")}
    if all(have.values()):
        return None, None, None, None

    haystack = (row.get("title") or "") + "\n" + (row.get("text") or "")
    known_ids = ({t for t in backlog_idx if len(t) > 2}
                 | {it["id"] for it in view.get("items", []) if len(it.get("id") or "") > 2}
                 | set(brief_ids))

    def task_context(task_id):
        return _task_context(task_id, view, backlog_idx, home, project_aliases_map)

    # Tier 1: the worker/task itself, the most correct source there is.
    task = row.get("task")
    task_ids = {task} if task else set()
    sources = []
    if task:
        sources.append("task %s" % task)
    if a_transcript_dir is not None:
        from_transcript = transcript_task_ids(
            row, a_transcript_dir, known_ids,
            transcript_cache if transcript_cache is not None else {})
        new_ids = from_transcript - task_ids
        if new_ids:
            sources.append("matched task %s from where it was said"
                           % " · ".join(sorted(new_ids)))
            task_ids |= new_ids

    worktree = branch = None
    projects = set()
    if task_ids:
        if len(task_ids) == 1:
            only = next(iter(task_ids))
            p, worktree, branch = task_context(only)
            if p:
                projects.add(p)
        else:
            for tid in task_ids:
                p, _, _ = task_context(tid)
                if p:
                    projects.add(p)
    else:
        # Tier 2, only reached when the worker/task named nothing at all:
        # the message's own words. A word matching several task ids at once
        # is exactly as ambiguous as a word matching none - left blank rather
        # than guessed - but its words may still name a project outright.
        matched_in_text = {t for t in known_ids if _word_present(haystack, t)}
        if len(matched_in_text) == 1:
            only = next(iter(matched_in_text))
            p, worktree, branch = task_context(only)
            if p:
                projects.add(p)
            if p or worktree or branch:
                sources.append("matched task %s in the message" % only)

        named = _projects_named_in(haystack, project_aliases_map)
        extra_named = named - projects
        if extra_named:
            sources.append("matched project %s in the message" % " · ".join(sorted(extra_named)))
        projects |= named

    at = row.get("at") or ""
    if "fm-command-center" in projects and at and at < COMMAND_CENTER_SPLIT:
        projects.discard("fm-command-center")
        projects.add("firstmate")

    project = " · ".join(sorted(projects)) if projects else None
    source = "; ".join(sources) or None

    return (None if have["project"] else project,
            None if have["worktree"] else worktree,
            None if have["branch"] else branch,
            source)


def enrich_message(row, view, backlog_idx, project_aliases_map,
                    a_transcript_dir=None, transcript_cache=None, home=None,
                    brief_ids=frozenset()):
    project, worktree, branch, source = message_context(
        row, view, backlog_idx, project_aliases_map, a_transcript_dir, transcript_cache,
        home, brief_ids)
    if not (project or worktree or branch):
        return row
    out = dict(row)
    if project:
        out["project"] = project
    if worktree:
        out["worktree"] = worktree
    if branch:
        out["branch"] = branch
    if source:
        out["context_source"] = source
    return out


def _epoch(at):
    try:
        return datetime.strptime(at, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc).timestamp()
    except (TypeError, ValueError):
        return None


NEARBY_TURN_WINDOW = 900  # 15 minutes, the captain's own figure


def fill_from_nearby_turn(rows):
    """A short status ping's own turn touches no task at all, so every tier
    above comes up empty - but its nearest EARLIER turn in the SAME session,
    within 15 minutes, so often does. Borrows that turn's project only, never
    a worktree or branch it did not itself resolve, and never a later turn -
    a ping reports on what already happened, not what comes after it."""
    by_session = {}
    for r in rows:
        sess, t = r.get("session"), _epoch(r.get("at"))
        if sess and t is not None:
            by_session.setdefault(sess, []).append((t, r))
    out = []
    for r in rows:
        if r.get("project"):
            out.append(r)
            continue
        sess, t = r.get("session"), _epoch(r.get("at"))
        best = None
        for ot, other in (by_session.get(sess) or [] if sess and t is not None else []):
            if other is r or not other.get("project") or ot >= t or t - ot > NEARBY_TURN_WINDOW:
                continue
            if best is None or ot > best[0]:
                best = (ot, other)
        if not best:
            out.append(r)
            continue
        row = dict(r, project=best[1]["project"],
                   context_source="the nearest earlier turn in the same session (%s)"
                                  % best[1].get("id", ""))
        out.append(row)
    return out



# How long a message with no full resolution yet is still worth retrying on
# every request - the live scan or the backlog can still catch up while the
# task it names is recent. Past this, an unresolved message reads as settled:
# whatever was going to fill it in already would have.
CONTEXT_SETTLE_SECS = 3600


def load_message_context_cache(home):
    try:
        with open(message_context_cache_path(home), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError):
        return {}
    return data if isinstance(data, dict) else {}


def save_message_context_cache(home, cache):
    path = message_context_cache_path(home)
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = path + f".tmp{os.getpid()}"
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump(cache, fh)
        os.replace(tmp, path)
    except OSError as exc:
        sys.stderr.write(f"command-center: could not write {path}: {exc}\n")


def enrich_messages(rows, records):
    """Fill in each message's project/worktree/branch (message_context), but
    only for a message this cache has never resolved, or one still recent
    enough that the live scan or the backlog could still fill it in further -
    see CONTEXT_SETTLE_SECS. Everything else is durably cached, keyed by
    message id, so a 200-row poll does not re-read the backlog and every
    matching transcript turn on every single request (that was slow enough
    to queue every click behind it - see AGENTS.md).
    """
    cache = load_message_context_cache(records.home)
    now = time.time()

    def settled(row):
        entry = cache.get(row.get("id"))
        if entry is None:
            return False
        if entry.get("project") and entry.get("worktree") and entry.get("branch"):
            return True
        age = now - (_epoch(row.get("at")) or 0)
        return age > CONTEXT_SETTLE_SECS

    to_resolve = [r for r in rows if r.get("id") and not settled(r)]
    if to_resolve:
        view = records.view() if records.etag is not None else {"items": []}
        backlog_idx = backlog_index(FIRSTMATE_ROOT, records.home)
        aliases = project_aliases(records.home)
        a_transcript_dir = transcript_dir(records.home)
        brief_ids = brief_task_ids(records.home)
        transcript_cache = {}
        for row in to_resolve:
            enriched = enrich_message(row, view, backlog_idx, aliases, a_transcript_dir,
                                      transcript_cache, records.home, brief_ids)
            cache[row["id"]] = {"project": enriched.get("project"),
                                "worktree": enriched.get("worktree"),
                                "branch": enriched.get("branch"),
                                "context_source": enriched.get("context_source")}
        save_message_context_cache(records.home, cache)

    def apply_cached(row):
        entry = cache.get(row.get("id"))
        if not entry:
            return row
        out = dict(row)
        for field in ("project", "worktree", "branch", "context_source"):
            if entry.get(field) and not out.get(field):
                out[field] = entry[field]
        return out

    enriched = [apply_cached(row) for row in rows]
    return fill_from_nearby_turn(enriched)


MESSAGE_WINDOW = 200


def messages_etag(home, capture):
    """What an unchanged /api/messages poll is allowed to skip re-reading.

    The log is append-only, so its size, mtime and readability decide whether
    its contents can have changed; the capture health travels in the same
    response and its band's own facts are part of the tag, because the band
    that says this list may be incomplete must never be held back by a quiet
    log. A message's Hold lives in parked.jsonl, a different file, so its own
    stat is folded in too - a hold with nothing else changing must still bust
    a poll that would otherwise answer 304 over the stale flag.
    """
    path = message_log(home)
    try:
        st = os.stat(path)
        key = f"{st.st_size}-{st.st_mtime_ns}-{os.access(path, os.R_OK)}"
    except FileNotFoundError:
        key = "none"
    except OSError:
        return None
    key += "/" + (log_etag(parked_log(home)) or "none")
    return '"m' + hashlib.sha1(
        (key + dump(band_facts(capture)).decode("utf-8")).encode("utf-8")
    ).hexdigest()[:16] + '"'


def band_facts(capture):
    """The capture facts the page's band actually speaks from (captureBand in
    bin/command-center-state.js).

    The status also carries the last sweep's timestamp and its age in seconds,
    both recomputed on every request; hashing those would make every tag
    unique and leave the log re-read on every poll. Only the staleness the band
    would SAY counts - it crosses the threshold and then changes by the minute.
    """
    age = capture.get("age_secs")
    stale = isinstance(age, (int, float)) and age > 900
    return [capture.get("present"), capture.get("ok"), capture.get("error"),
            capture.get("active"), capture.get("run_error"),
            bool(capture.get("named")),
            round(age / 60) if stale else None]


def archived_messages(home):
    """The current archive state recorded beside each message in its log.

    Archive changes are amendments in captain-messages.jsonl, not a separate
    store.  The latest amendment for an id wins, so a restore is durable too.
    """
    states = {}
    try:
        with open(message_log(home), encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("kind") in ("archive", "unarchive") and row.get("of"):
                    states[row["of"]] = row["kind"] == "archive"
    except OSError:
        pass
    return states


def message_totals(home):
    """How many current and archived messages the log holds, in one read.

    The page's counts are these numbers, not the size of the window, so they
    stay true as the log grows past what is loaded. Counted from the file
    every time it is asked for: only a poll that found the log changed gets
    this far, and the file is the one thing that cannot disagree with itself.

    A held message is excluded from both counts, the same as visibleMessages()
    (web/command-center-state.js) excludes it from both the Messages and
    Archived lists - a message the captain parked belongs to On hold alone, so
    its badge must never also swell whichever of the other two it happens to
    sit in.
    """
    ids = []
    states = {}
    try:
        with open(message_log(home), encoding="utf-8") as fh:
            for line in fh:
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("kind") in ("archive", "unarchive") and row.get("of"):
                    states[row["of"]] = row["kind"] == "archive"
                elif row.get("id") and "text" in row:
                    ids.append(row["id"])
    except OSError:
        pass
    held = read_parked(home)
    ids = [i for i in ids if held.get(("message", i)) != "held"]
    archived = sum(1 for i in ids if states.get(i))
    return len(ids) - archived, archived


def reversed_lines(fh, block=65536):
    """The file's non-empty lines from the end, a block at a time.

    Every read of the captured log wants its newest end: the window the page
    opens on, the message a reply names, the newest matches of a search. The
    log only grows, so reading it forwards makes the cheapest question the most
    expensive one - this reads backwards and stops when the caller has enough.
    """
    fh.seek(0, os.SEEK_END)
    pos = fh.tell()
    tail = b""
    while pos > 0:
        step = min(block, pos)
        pos -= step
        fh.seek(pos)
        chunk = fh.read(step) + tail
        parts = chunk.split(b"\n")
        tail = parts.pop(0)
        for part in reversed(parts):
            if part.strip():
                yield part
    if tail.strip():
        yield tail


def json_id(raw):
    """The id of one recorded line, or None when it is not a record at all."""
    try:
        row = json.loads(raw)
    except json.JSONDecodeError:
        return None
    return row.get("id") if isinstance(row, dict) else None


def replies_by_message(home):
    """What he typed under each message, keyed by the message it answered.

    A thread is a message AND his replies to it, so both are searched; they
    live in the other log, which is read once per search rather than per line.
    """
    rows, error, _ = read_log(said_log(home), LOG_LIMIT)
    threads = {}
    if error:
        return threads
    for row in rows:
        msg = row.get("msg")
        if msg and row.get("text"):
            threads.setdefault(msg, []).append(str(row["text"]))
    return threads


def matches(row, needle, replies):
    """Is this message one he is searching for? The fields he can see.

    The one matcher every search goes through, line by line. A faster path over
    the raw bytes would be a second spelling of this rule, and a search that
    disagrees with it says "nothing matches" over words he is looking at.
    """
    haystack = [str(row.get(f) or "") for f in (
        "title", "text", "project", "worktree", "branch", "task")]
    haystack += replies.get(row.get("id"), [])
    return needle in " ".join(haystack).lower()


def read_messages(home, limit=MESSAGE_WINDOW, before=None, query=None, archived=False):
    """The newest messages, newest first. Returns (rows, more, error).

    NOTHING IS DROPPED: the whole log stays on disk and every line of it is
    reachable - `before` walks back through it a window at a time and `query`
    searches all of it. What this does not do is ship the whole of it on every
    poll, because the log now gains a message on every turn end.

    A log that is not there yet is honestly empty; one that cannot be READ is a
    different state, and reporting it as empty would tell the captain firstmate
    never said anything to him.
    """
    needle = query.strip().lower() if query else None
    replies = replies_by_message(home) if needle else {}
    skipping = bool(before)
    # The id is looked for as a value, then confirmed by reading the record:
    # what a line looks like is the writer's business, not this reader's.
    mark = b'"' + before.encode() + b'"' if before else b""
    rows = []
    archive_state = {}
    held = read_parked(home)
    try:
        with open(message_log(home), "rb") as fh:
            for raw in reversed_lines(fh):
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if row.get("kind") in ("archive", "unarchive") and row.get("of"):
                    archive_state.setdefault(row["of"], row["kind"] == "archive")
                    continue
                if not row.get("id") or "text" not in row:
                    continue
                if skipping:
                    if mark in raw and row.get("id") == before:
                        skipping = False
                    continue
                if bool(archive_state.get(row["id"])) != archived:
                    continue
                if needle and not matches(row, needle, replies):
                    continue
                if len(rows) == limit:
                    return rows, True, None
                rows.append(dict(row, archived=archived,
                                  held=held.get(("message", row["id"])) == "held"))
    except FileNotFoundError:
        return [], False, None
    except OSError as exc:
        return [], False, f"the record could not be read: {exc}"
    return rows, False, None


def find_message(home, msg_id):
    """The message a reply names, read back from the log rather than trusted.

    Read from the newest end and stopped at the match, so replying to what he
    is looking at costs the tail of the log, not the whole of it; a reply to a
    message this home never recorded is refused.
    """
    mark = b'"' + msg_id.encode() + b'"'
    try:
        with open(message_log(home), "rb") as fh:
            for raw in reversed_lines(fh):
                if mark not in raw:
                    continue
                try:
                    row = json.loads(raw)
                except json.JSONDecodeError:
                    continue
                if row.get("id") == msg_id:
                    return row, None
    except FileNotFoundError:
        return None, None
    except OSError as exc:
        return None, f"the record could not be read: {exc}"
    return None, None


NOTE_QUEUED_RE = re.compile(r'^queued (\S+)', re.MULTILINE)


def send_note(home_path, text):
    # Approved proposal section 3: the captain's words are logged even when they
    # answer no item, so a note with no addressee is a channel this surface owes.
    proc = subprocess.run(
        # The body goes over stdin, not argv: a note of exactly "-" is
        # fm-inbox.sh's own read-from-stdin selector, and as an argument it
        # would take that branch and queue nothing. The pipe closes after the
        # write, so a child that reads stdin still cannot hang the server.
        [firstmate_bin("fm-inbox.sh"), "note", "-"],
        input=text, capture_output=True, text=True, timeout=SEND_TIMEOUT,
        errors="replace", env=dict(os.environ, FM_HOME=home_path), check=False,
    )
    detail = (proc.stdout + proc.stderr).strip()[:600]
    # fm-inbox.sh publishes the note record BEFORE it wakes firstmate and exits
    # nonzero if only the wake failed, so its exit code cannot tell nothing-saved
    # from saved-but-unannounced. Saying "not queued" about words already on disk
    # is the false claim this page exists to end, and a second note is not the
    # same note - queue_note mints a fresh id, so this route is not idempotent.
    # A "queued <id>" line means the note is on disk regardless of what else is
    # in the output (or the exit code) - decode noise from a multi-byte reply
    # must never turn an already-queued note into a false "unknown".
    m = NOTE_QUEUED_RE.search(proc.stdout)
    note_id = m.group(1) if m else None
    outcome = "sent" if (proc.returncode == 0 or note_id) else "unknown"
    return outcome, "fm-inbox.sh note", detail, note_id


def deliver_to_inbox(main_home_path, item, text):
    """Deliver a Waiting-on-you answer straight to the MAIN home's captain
    inbox, whatever home the item itself belongs to, and nothing else.

    An idle second mate (b2b, interact, ...) keeps no watcher running, so a
    note written into its own inbox would sit unread. The main firstmate is
    always watching, so every answer goes there instead, prefixed with the
    item's own home and id (e.g. "[b2b · kk-xyz] ") so main firstmate can
    forward it to that second mate with fm-send, which does ring an idle one.

    fm-captain-hold.sh and fm-send.sh both own a real decision record, but
    both are bounded by work a click must not wait on (a remote ledger read,
    a worker's own steering inbox) - so neither runs from this send path any
    more. His words reach firstmate the same way a Messages reply already
    does (send_note): durable and woken the moment this returns. Firstmate
    reads the note and closes the decision itself; this page only has to say
    his words got there.

    The note carries the item's home, id and title, never just his bare
    answer - without that, nothing reading the note back could tell which
    decision it resolves, or which home to forward it to.

    Returns (outcome, route, detail, note_id). Only two outcomes ever reach
    him: "sent" (the note is durably queued) or "failed" (it never made it,
    so he keeps his words to try again).
    """
    body = (f"[{item['home']} · {item['id']}] "
            f"Answer to {item['id']} — {item.get('title') or '(no title)'}:\n{text}")
    try:
        outcome, route, detail, note_id = send_note(main_home_path, body)
    except Exception as exc:  # noqa: BLE001 - a failed wake must never look like a lost answer
        outcome, route, detail, note_id = "unknown", "fm-inbox.sh note", str(exc), None
    return ("sent" if outcome == "sent" else "failed"), route, detail, note_id


def record_archive(home, msg_id, archived):
    """Append one archive amendment beside the message it changes."""
    data = (json.dumps({"kind": "archive" if archived else "unarchive",
                        "of": msg_id, "at": utc_now()}) + "\n").encode("utf-8")
    try:
        with open(message_log(home), "a+b", buffering=0) as fh:
            if fh.seek(0, os.SEEK_END) > 0:
                fh.seek(-1, os.SEEK_END)
                if fh.read(1) != b"\n":
                    data = b"\n" + data
            fh.write(data)
    except OSError as exc:
        return f"the archive record could not be written: {exc}"
    return None


class Handler(BaseHTTPRequestHandler):
    server_version = "firstmate-command-center"
    protocol_version = "HTTP/1.1"
    records = None
    capture = None
    work = None

    def log_message(self, fmt, *args):  # quieter than the stdlib default
        if self.path.startswith("/api/items"):
            return
        sys.stderr.write("%s %s\n" % (self.log_date_time_string(), fmt % args))

    # --- plumbing ------------------------------------------------------------
    def _send(self, code, body, ctype="application/json; charset=utf-8", etag=None):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        if etag:
            self.send_header("ETag", etag)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def query_param(self, name):
        """One query value, or None. A repeat is the first one, never a list."""
        _, _, query = self.path.partition("?")
        values = urllib.parse.parse_qs(query).get(name) or []
        return values[0] if values and values[0] else None

    def _json(self, code, obj):
        self._send(code, dump(obj))

    def _log_response(self, name, path, read, extra_path=None, extra_fingerprint=None):
        """Serve one log under a change check, but never cache a FAILED read.

        A read error carries no rows, and its (mtime, size) is the same one a
        successful read of the repaired file would have: caching it would answer
        304 to every later poll and leave the page saying his record could not
        be read long after it could.

        The tag names this process too. What a row says is partly this
        process's own knowledge - a delivery it is still carrying out reads
        differently from one a restart orphaned - so a tag issued before a
        restart must not answer 304 for a log that now reads differently.

        `extra_path`: a second log this response's rows also depend on (said
        rows carry Archive/Hold folded in from parked.jsonl) - its own stat
        is folded into the tag too, so a park action busts a poll that would
        otherwise answer 304 over the now-stale flag.

        `extra_fingerprint`: a callable for a fact this response depends on
        that lives outside any log this process writes (said rows also carry
        `received`, folded in from firstmate's own state/inbox/handled/ - see
        Handler._said_fingerprint) - its string is folded into the tag too.
        """
        etag = log_etag(path)
        if etag:
            etag = hashlib.sha256(
                (RUN + etag + (log_etag(extra_path) or "none" if extra_path else "")
                 + (extra_fingerprint() if extra_fingerprint else "")
                 ).encode()).hexdigest()[:32]
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        rows, error, dropped = read(self.records)
        self._send(200, dump({name: rows, "error": error, "dropped": dropped}),
                   etag=None if error else etag)

    def _said_fingerprint(self):
        """Every home a send could have gone to, not just this one: a reply or
        an answer can route to any home the fleet knows about (item["home"]),
        and the received dot for THAT note only moves when THAT home's own
        inbox is drained.
        """
        records = self.records
        homes = {records.home}
        if records.etag is not None:
            homes.update(h["path"] for h in records.view().get("homes", []))
        return "|".join(inbox_fingerprint(h) for h in sorted(homes))

    def _body(self):
        """Read the declared body first, on every path including a refusal.

        The connection is kept alive, so bytes left unread become the head of
        the next request: a refusal that skips the body hands the sender a way
        to smuggle a request that looks same-origin in behind the refused one.
        Anything that cannot be drained exactly closes the connection instead.
        """
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = -1
        if length < 0 or length > 1 << 20 or self.headers.get("Transfer-Encoding"):
            self.close_connection = True
            return None
        raw = self.rfile.read(length) if length else b""
        if len(raw) != length:
            self.close_connection = True
            return None
        try:
            return json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError):
            return None

    def _local_request(self):
        """Hold the loopback trust boundary at the door.

        Binding to 127.0.0.1 keeps the network out but not the captain's own
        browser: any page he visits can post here, and a rebound hostname can
        read here. Both arrive with a Host, Origin or Sec-Fetch-Site that is not
        this server's, so that is what is checked.
        """
        port = self.server.server_address[1]
        if self.headers.get("Host") not in (f"127.0.0.1:{port}", f"localhost:{port}"):
            return False
        site = self.headers.get("Sec-Fetch-Site")
        if site is not None and site not in ("same-origin", "none"):
            return False
        origin = self.headers.get("Origin")
        return origin is None or origin in (
            f"http://127.0.0.1:{port}", f"http://localhost:{port}")

    def _text_field(self, payload):
        """Validate the one free-text field at the trust boundary."""
        text = payload.get("text")
        if not isinstance(text, str):
            return None, "no text"
        text = text.strip()
        if not text:
            return None, "an empty answer is not an answer"
        if len(text.encode()) > MAX_TEXT:
            return None, f"too long: the limit is {MAX_TEXT} bytes"
        return text, None

    # --- routes --------------------------------------------------------------
    def do_GET(self):
        path = self.path.split("?", 1)[0]
        if not self._local_request():
            self._send(403, b"not your server", "text/plain; charset=utf-8")
            return
        if path in ("/", "/command-center-state.js"):
            src = PAGE if path == "/" else RULES
            ctype = ("text/html" if path == "/" else "text/javascript")
            try:
                with open(src, "rb") as fh:
                    body = fh.read()
            except OSError as exc:
                self._send(500, f"cannot read {src}: {exc}".encode(),
                           "text/plain; charset=utf-8")
                return
            self._send(200, body, ctype + "; charset=utf-8")
            return

        if path == "/api/items":
            self.records.refresh()
            etag, body = self.records.snapshot()
            if etag is None:
                # Never serve the unscanned placeholder: an empty list reads as
                # "nothing is waiting on you", which is the one claim this page
                # exists to stop making without evidence.
                self._json(503, {"error": self.records.error
                                 or "the records have not been read yet"})
                return
            # Archive/Hold for an item lives in parked.jsonl, not the scan: a
            # park action must bust a poll that would otherwise answer 304
            # over the now-stale flag, so its own stat is folded into the tag.
            combined_etag = hashlib.sha256(
                (etag + (log_etag(parked_log(self.records.home)) or "none")
                 ).encode()).hexdigest()[:32]
            if self.headers.get("If-None-Match") == combined_etag and not self.records.error:
                self.send_response(304)
                self.send_header("ETag", combined_etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            view = json.loads(body)
            view["error"] = self.records.error
            parked = read_parked(self.records.home)
            for it in view.get("items", []):
                key = item_key(it)
                it["archived"] = parked.get(("item", key)) == "archived"
                it["held"] = parked.get(("item", key)) == "held"
            self._send(200, dump(view), etag=combined_etag)
            return

        if path == "/api/messages":
            # Each poll also keeps the automatic capture running (off-thread),
            # and carries its health so the page can say when this list may be
            # incomplete rather than quietly showing a short one.
            self.capture.ensure()
            capture = self.capture.status()
            query = self.query_param("q")
            before = self.query_param("before")
            msg_id = self.query_param("id")
            archived = self.query_param("archived") == "1"
            if self.query_param("archived") not in (None, "0", "1"):
                self._json(400, {"error": "unknown message list"})
                return
            if (before and not ID_RE.match(before)) \
                    or (msg_id and not ID_RE.match(msg_id)):
                self._json(400, {"error": "unknown message"})
                return
            if msg_id:
                # One message, read straight out of the log: what the page
                # holds is a window, and he can click through to a message
                # from anywhere - his own reply to it, months back.
                row, error = find_message(self.records.home, msg_id)
                if row is not None:
                    row = dict(row, archived=archived_messages(self.records.home).get(msg_id, False),
                               held=read_parked(self.records.home).get(("message", msg_id)) == "held")
                    row = enrich_messages([row], self.records)[0]
                current, archived_total = message_totals(self.records.home)
                self._send(200, dump({"messages": [row] if row else [],
                                      "more": False, "error": error,
                                      "total": archived_total if archived else current,
                                      "archived_total": archived_total,
                                      "capture": capture}))
                return
            # Only the plain window is polled, so only it is worth a tag; a
            # search and a walk back through the log are asked for once.
            etag = messages_etag(self.records.home, capture) \
                if not (query or before) else None
            if etag and self.headers.get("If-None-Match") == etag:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            rows, more, error = read_messages(self.records.home,
                                              before=before, query=query,
                                              archived=archived)
            if not error:
                rows = enrich_messages(rows, self.records)
            # A read that FAILED is not the state of the log: serving it under a
            # change check would answer 304 to every later poll and leave the
            # page saying this record could not be read long after it could.
            current, archived_total = message_totals(self.records.home)
            self._send(200, dump({"messages": rows, "more": more,
                                  "total": archived_total if archived else current,
                                  "archived_total": archived_total,
                                  "error": error, "capture": capture}),
                       etag=None if error else etag)
            return

        if path == "/api/said":
            self._log_response("said", said_log(self.records.home), read_said,
                               extra_path=parked_log(self.records.home),
                               extra_fingerprint=self._said_fingerprint)
            return

        if path == "/api/work":
            self.work.refresh()
            body = self.work.snapshot()
            if body is None:
                self._json(503, {"error": self.work.error
                                 or "the work board has not been read yet"})
                return
            self._send(200, body)
            return

        self._send(404, b"not found", "text/plain; charset=utf-8")

    do_HEAD = do_GET

    def do_POST(self):
        path = self.path.split("?", 1)[0]
        payload = self._body()
        ctype = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        if not self._local_request() or ctype != "application/json":
            self._json(403, {"ok": False, "error": "refused: not this page"})
            return
        if payload is None or not isinstance(payload, dict):
            self._json(400, {"ok": False, "error": "unreadable request"})
            return
        if path == "/api/archive":
            msg_id = payload.get("msg")
            archived = payload.get("archived")
            if not isinstance(msg_id, str) or not ID_RE.match(msg_id) \
                    or not isinstance(archived, bool):
                self._json(400, {"ok": False, "error": "unknown message"})
                return
            message, error = find_message(self.records.home, msg_id)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            if message is None:
                self._json(404, {"ok": False, "error": "no such message"})
                return
            error = record_archive(self.records.home, msg_id, archived)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            self._json(200, {"ok": True, "archived": archived})
            return
        if path == "/api/park":
            # Archive and Hold for a Waiting-on-you item or a My words
            # conversation, and Hold for a message (its Archive stays on
            # /api/archive above): one durable record instead of browser
            # storage, so it survives a refresh and reads the same from any
            # browser. No confirmation and no undo route beyond sending the
            # opposite state - the same one-click shape /api/archive already
            # has.
            target = payload.get("target")
            key = payload.get("key")
            state = payload.get("state")
            if target not in ("item", "word", "message") \
                    or not isinstance(key, str) or not key or len(key) > 400 \
                    or state not in ("archived", "held", "none"):
                self._json(400, {"ok": False, "error": "unknown park request"})
                return
            error = record_parked(self.records.home, target, key, state)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            self._json(200, {"ok": True, "target": target, "key": key, "state": state})
            return
        text, err = self._text_field(payload)
        if err:
            self._json(400, {"ok": False, "error": err})
            return

        if path == "/api/note":
            # Approved proposal section 3: a note attached to no item still goes
            # in the captain's log, so this endpoint is part of that promise.
            # fm-inbox.sh publishes the note AND wakes firstmate before it
            # exits, so - as on the other two send surfaces - his words are
            # made durable, the send is accepted, and delivery runs behind it.
            records = self.records

            def deliver_note():
                try:
                    outcome, route, detail, note_id = send_note(records.home, text)
                except subprocess.SubprocessError as exc:
                    outcome, route, detail, note_id = "unknown", "fm-inbox.sh note", str(exc), None
                return {"outcome": outcome, "route": route, "detail": detail, "note_id": note_id}

            sid, error = accept_said(self.records.home,
                                     {"kind": "note", "home": "main", "text": text},
                                     deliver_note)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            self._json(202, {"ok": True, "sid": sid, "outcome": "sending"})
            return

        if path == "/api/reply":
            # A reply to something firstmate SAID. Where it goes is decided by
            # the recorded message, never by the browser: a message the
            # recorder marked as a QUESTION is answered as that question and
            # takes the answer route unchanged, and anything else reaches
            # firstmate as a note, because a reply with nowhere to be delivered
            # is still his words. A message that is not a question is never
            # written as the answer to some other decision. The route is
            # decided here, from the snapshot the page itself is showing, so
            # the item a steer may reach is locked from the moment it is
            # accepted; only the delivery runs behind the acceptance
            # (accept_said), and the outcome lands on the record when known.
            msg_id = payload.get("msg")
            if not isinstance(msg_id, str) or not ID_RE.match(msg_id):
                self._json(400, {"ok": False, "error": "unknown message"})
                return
            message, log_error = find_message(self.records.home, msg_id)
            if log_error is not None:
                self._json(503, {"ok": False, "error": log_error})
                return
            if message is None:
                self._json(404, {"ok": False, "error": "no such message"})
                return
            records = self.records
            item = unread = None
            if message.get("question"):
                # Only a QUESTION has an answer route to rule out. With no
                # scan it cannot be ruled out, and falling through to the note
                # route would record his steer as delivered while the worker
                # stayed stopped - so nothing is sent and it is reported as
                # failed, which is what it is: resending is safe.
                if records.etag is None:
                    unread = records.error or "the records have not been read yet"
                else:
                    item = records.waiting_question(message.get("task"),
                                                    message.get("question_key") or "")
            # Delivery always goes to the MAIN home's inbox, whatever home the
            # item itself belongs to - an idle second mate keeps no watcher
            # running to notice a note left in its own inbox.
            main_home_path = records.home_path("main") if item else None
            if not main_home_path:
                item = None

            def deliver_reply():
                if unread:
                    return {"outcome": "failed", "route": "", "home": "main",
                            "detail": unread}
                if item:
                    outcome, route, detail, note_id = deliver_to_inbox(main_home_path, item, text)
                    if outcome == "sent":
                        records.invalidate()
                    return {"resolved": "answer", "outcome": outcome,
                            "route": route, "detail": detail, "mode": "note",
                            "home": item["home"], "item": item["id"],
                            "source": item["source"], "key": item.get("key"),
                            "item_key": item_key(item), "note_id": note_id,
                            "sent_count": len(item.get("sent") or [])}
                try:
                    outcome, route, detail, note_id = send_note(records.home, text)
                except subprocess.SubprocessError as exc:
                    outcome, route, detail, note_id = "unknown", "fm-inbox.sh note", str(exc), None
                return {"resolved": "note", "outcome": outcome, "route": route,
                        "detail": detail, "home": "main", "note_id": note_id}

            entry = {"kind": "reply", "msg": msg_id,
                     "title": message.get("title"), "text": text}
            if item:
                entry["item_key"] = item_key(item)
            sid, error = accept_said(self.records.home, entry, deliver_reply)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            # A reply never moves anything to Archived on its own - only his own
            # explicit Archive click does that (/api/archive), because a reply is
            # sometimes just a comment he wants to keep checking on.
            self._json(202, {"ok": True, "sid": sid, "outcome": "sending",
                             "item_key": entry.get("item_key")})
            return

        if path == "/api/answer":
            home_id = payload.get("home")
            task_id = payload.get("id")
            source = payload.get("source")
            key = payload.get("key") or ""
            if not isinstance(home_id, str) or not isinstance(task_id, str) \
                    or not isinstance(key, str) or source not in ("hold", "status") \
                    or not ID_RE.match(task_id):
                self._json(400, {"ok": False, "error": "unknown item"})
                return
            # The lookup uses the snapshot the page itself is showing; no scan
            # runs on the send's path. Only a server that has never scanned at
            # all refreshes here, because it has no snapshot to check against.
            if self.records.etag is None:
                self.records.refresh()
            if self.records.etag is None:
                self._json(503, {"ok": False,
                                 "error": "the records have not been read yet"})
                return
            item = self.records.item(home_id, task_id, source, key)
            # Delivery always goes to the MAIN home's inbox, whatever home the
            # item itself belongs to - an idle second mate keeps no watcher
            # running to notice a note left in its own inbox.
            main_home_path = self.records.home_path("main")
            if item is None or main_home_path is None:
                self._json(404, {"ok": False,
                                 "error": "that item is no longer waiting for you"})
                return
            records = self.records

            def deliver_answer():
                outcome, route, detail, note_id = deliver_to_inbox(main_home_path, item, text)
                if outcome == "sent":
                    records.invalidate()     # force a rescan on the next poll
                return {"outcome": outcome, "route": route, "detail": detail,
                        "mode": "note", "note_id": note_id}

            sid, error = accept_said(self.records.home, {
                "kind": "answer", "home": home_id, "item": task_id,
                "source": item["source"], "key": item.get("key"),
                "item_key": item_key(item), "title": item.get("title"),
                "text": text, "sent_count": len(item.get("sent") or []),
            }, deliver_answer)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            self._json(202, {"ok": True, "sid": sid, "outcome": "sending"})
            return

        self._json(404, {"ok": False, "error": "not found"})


UNIT = """\
[Unit]
Description=Firstmate command center
After=default.target

[Service]
ExecStart={python} {script} --port {port} --home {home} --firstmate-root {firstmate_root}
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
"""


def install_unit(home, port, firstmate_root):
    """Write the user unit, and print the two commands only the captain can run.

    Enabling and lingering change his session, so this writes the file and stops
    there rather than reaching into systemd on his behalf.
    """
    directory = os.path.expanduser("~/.config/systemd/user")
    os.makedirs(directory, exist_ok=True)
    path = os.path.join(directory, "firstmate-command-center.service")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(UNIT.format(python=sys.executable, script=os.path.abspath(__file__),
                             port=port, home=home, firstmate_root=firstmate_root))
    print(f"wrote {path}")
    print("now run:")
    print("  systemctl --user daemon-reload")
    print("  systemctl --user enable --now firstmate-command-center")
    print("  loginctl enable-linger $USER   # so it starts at boot, before you log in")
    print(f"then bookmark http://127.0.0.1:{port}")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description="The captain's permanent command center.")
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--home", default=os.environ.get("FM_HOME"),
                        help="operational home to read (default: $FM_HOME)")
    parser.add_argument("--firstmate-root",
                        default=os.environ.get("FM_FIRSTMATE_ROOT", DEFAULT_FIRSTMATE_ROOT),
                        help="firstmate checkout whose bin/ scripts answer sends and "
                             "captures messages (default: $FM_FIRSTMATE_ROOT, else "
                             f"{DEFAULT_FIRSTMATE_ROOT})")
    parser.add_argument("--install-unit", action="store_true",
                        help="write the systemd user unit and exit")
    args = parser.parse_args(argv)

    global FIRSTMATE_ROOT
    FIRSTMATE_ROOT = os.path.abspath(os.path.expanduser(args.firstmate_root))

    if not args.home:
        print("command-center: --home (or $FM_HOME) is required", file=sys.stderr)
        return 1
    home = os.path.abspath(os.path.expanduser(args.home))
    if not os.path.isdir(home):
        print(f"command-center: no such home: {home}", file=sys.stderr)
        return 1
    if args.install_unit:
        return install_unit(home, args.port, FIRSTMATE_ROOT)
    for needed in (PAGE, RULES):
        if not os.path.exists(needed):
            print(f"command-center: a page file is missing: {needed}", file=sys.stderr)
            return 1

    Handler.records = Records(home)
    Handler.capture = MessageCapture(home)
    Handler.work = Work(home)
    # Start capture straight away so the list is complete - today's messages
    # backfilled on the first ever run - before the page is even opened.
    Handler.capture.ensure()
    # Loopback only. This runs firstmate's scripts as the captain and has no
    # authentication of its own, so it must never listen on a routable address.
    httpd = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    httpd.daemon_threads = True
    print(f"command center on http://127.0.0.1:{args.port}  (home: {home})")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
