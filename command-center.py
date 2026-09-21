#!/usr/bin/env python3
# command-center.py - the captain's permanent command center.
#
# One page at a fixed address showing everything waiting on the captain across
# every local firstmate home, with his answer going straight back through the
# scripts that already own delivery. bin/command-center-scan.sh is the reading
# half; docs/command-center.md is the operator guide.
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
import tempfile
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


def read_said(home, limit=LOG_LIMIT):
    """His words, newest first, with each delivery's outcome folded back in.

    A send is two lines: the entry written as it was accepted (outcome
    "sending") and the outcome amendment written when delivery finished. They
    are folded here so the page sees one record per send. An entry still
    "sending" that this process is not delivering was orphaned by a restart:
    delivery is genuinely unknown, and unknown is what it says.
    """
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
    return merged, None, dropped


MESSAGE_WINDOW = 200


def messages_etag(home, capture):
    """What an unchanged /api/messages poll is allowed to skip re-reading.

    The log is append-only, so its size, mtime and readability decide whether
    its contents can have changed; the capture health travels in the same
    response and its band's own facts are part of the tag, because the band
    that says this list may be incomplete must never be held back by a quiet
    log.
    """
    path = message_log(home)
    try:
        st = os.stat(path)
        key = f"{st.st_size}-{st.st_mtime_ns}-{os.access(path, os.R_OK)}"
    except FileNotFoundError:
        key = "none"
    except OSError:
        return None
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
                rows.append(dict(row, archived=archived))
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


def send_answer(home_path, item, text):
    """Deliver one answer through the script that owns its delivery.

    A captain hold and a stopped worker are different records answered by
    different commands, and the item's own `source` decides which - the server
    never guesses. Both record the captain's words durably as part of the same
    act that closes the decision.

    Returns (outcome, route, detail, mode), the outcome read from the exit code
    and nothing else.
    The output carries the captain's own answer back (fm-send.sh echoes its argv
    on the remote leg), so reading prose here would let his words decide whether
    his send was delivered. A killed child is the same question by another name,
    so each route answers it here too rather than anywhere else.
    """
    env = dict(os.environ, FM_HOME=home_path)
    if item["source"] == "hold":
        # bin/fm-captain-hold.sh mints a question of its own with `--kind
        # captain`; a WORK item it holds keeps its own kind. Answering the
        # question closes it, but answering the gate must LIFT the hold so the
        # work resumes - closing it would mark unstarted work complete.
        kind = item.get("kind") or ""
        if not kind:
            return ("failed", f"fm-captain-hold.sh answer {item['id']}",
                    "this row records no kind, so the command center cannot tell a "
                    "question from work held pending your answer; nothing was sent. "
                    "Answer it with fm-captain-hold.sh, which can see the task itself.",
                    "none")
        mode = "close" if kind == "captain" else "release"
        args = [firstmate_bin("fm-captain-hold.sh"), "answer", item["id"]]
        if mode == "release":
            args.append("--release")
        route = " ".join(["fm-captain-hold.sh", "answer", item["id"]]
                         + (["--release"] if mode == "release" else []))
        fd, tmp = tempfile.mkstemp(prefix="cc-decision-", text=True)
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as fh:
                fh.write(text)
            proc = subprocess.run(
                args + ["--decision-file", tmp],
                capture_output=True, text=True, timeout=SEND_TIMEOUT,
                env=env, stdin=subprocess.DEVNULL, check=False,
            )
        except subprocess.SubprocessError as exc:
            return "failed", route, str(exc), mode
        finally:
            os.unlink(tmp)
        # A hold is a LOCAL record write with no delivery plane, and
        # bin/fm-captain-hold.sh documents an exact retry as idempotent, so a
        # refusal or a killed child is a plain failure he may simply send again.
        outcome = "sent" if proc.returncode == 0 else "failed"
    else:
        mode = "close"
        route = f"fm-send.sh {item['id']}"
        args = [firstmate_bin("fm-send.sh"), item["id"]]
        if item.get("key"):
            args += ["--resolve-key", item["key"]]
        args.append(text)
        try:
            proc = subprocess.run(
                args, capture_output=True, text=True, timeout=SEND_TIMEOUT,
                env=env, stdin=subprocess.DEVNULL, check=False,
            )
        except subprocess.SubprocessError as exc:
            # Killed mid-flight: the steer may already sit on the worker's
            # inbox, and saying "not sent" is what invites a second delivery.
            return "unknown", route, str(exc), mode
        # fm-send.sh reports confirmed (0), typed-plane unconfirmed (3) and
        # inbox-plane delivered-but-not-closed (4); its remaining nonzero exits
        # conflate a refusal with a delivery it could not read back, so delivery
        # is genuinely unknown and unknown is what a surface that never guesses
        # has to say. Exit 4 is a delivered steer whose decision-close append
        # failed, and this server still reads it as unknown; reporting it as its
        # own outcome is a separate change.
        outcome = {0: "sent", 3: "unknown"}.get(proc.returncode, "unknown")
    detail = (proc.stdout + proc.stderr).strip()
    return outcome, route, detail[:600], mode


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
        env=dict(os.environ, FM_HOME=home_path), check=False,
    )
    detail = (proc.stdout + proc.stderr).strip()[:600]
    # fm-inbox.sh publishes the note record BEFORE it wakes firstmate and exits
    # nonzero if only the wake failed, so its exit code cannot tell nothing-saved
    # from saved-but-unannounced. Saying "not queued" about words already on disk
    # is the false claim this page exists to end, and a second note is not the
    # same note - queue_note mints a fresh id, so this route is not idempotent.
    outcome = "sent" if proc.returncode == 0 else "unknown"
    return outcome, "fm-inbox.sh note", detail


def deliver_certainly(home_path, item, text):
    """Deliver a Waiting-on-you answer the way this page promises: certain,
    never "not sent".

    His words go to firstmate's captain inbox FIRST, through the exact path
    the Messages reply box already uses (send_note) - so firstmate is woken
    and reads them no matter what happens next. Only after that, as a bonus,
    this also tries the item's own keyed decision route (send_answer:
    fm-captain-hold.sh answer for a hold, fm-send.sh for a stopped worker).
    When the bonus lands, its own route and mode are what he is told, because
    that is the more useful truth. When it does not, the failure is never
    reported as "not sent" - the guaranteed note already reached firstmate,
    so the worst case is a person finishing the filing by hand, not a lost
    answer - and mode "note" tells the page not to claim a decision closed
    that only a note carried.

    Either call can raise something other than SubprocessError (a missing
    script is a bare OSError, not that) - caught broadly here for the same
    reason accept_said catches broadly around a delivery thread: the note is
    the guarantee, so nothing the bonus route does, including raising, may
    take that guarantee away.
    """
    try:
        note_outcome, note_route, note_detail = send_note(home_path, text)
    except Exception as exc:  # noqa: BLE001 - the guarantee must survive whatever this throws
        note_outcome, note_route, note_detail = "unknown", "fm-inbox.sh note", str(exc)

    try:
        bonus_outcome, bonus_route, bonus_detail, bonus_mode = send_answer(home_path, item, text)
    except Exception as exc:  # noqa: BLE001 - a bonus failure must never look like a lost answer
        bonus_outcome, bonus_route, bonus_detail, bonus_mode = "failed", "", str(exc), "none"

    if bonus_outcome == "sent":
        return "sent", bonus_route, bonus_detail, bonus_mode

    detail = note_detail
    if bonus_detail:
        detail = f"{detail} — the decision route also ran and said: {bonus_detail}"
    return note_outcome, note_route, detail[:600], "note"


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

    def _log_response(self, name, path, read):
        """Serve one log under a change check, but never cache a FAILED read.

        A read error carries no rows, and its (mtime, size) is the same one a
        successful read of the repaired file would have: caching it would answer
        304 to every later poll and leave the page saying his record could not
        be read long after it could.

        The tag names this process too. What a row says is partly this
        process's own knowledge - a delivery it is still carrying out reads
        differently from one a restart orphaned - so a tag issued before a
        restart must not answer 304 for a log that now reads differently.
        """
        etag = log_etag(path)
        if etag:
            etag = hashlib.sha256((RUN + etag).encode()).hexdigest()[:32]
        if etag and self.headers.get("If-None-Match") == etag:
            self.send_response(304)
            self.send_header("ETag", etag)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        rows, error, dropped = read(self.records.home)
        self._send(200, dump({name: rows, "error": error, "dropped": dropped}),
                   etag=None if error else etag)

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
            if self.headers.get("If-None-Match") == etag and not self.records.error:
                self.send_response(304)
                self.send_header("ETag", etag)
                self.send_header("Content-Length", "0")
                self.end_headers()
                return
            view = json.loads(body)
            view["error"] = self.records.error
            self._send(200, dump(view), etag=etag)
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
                    row = dict(row, archived=archived_messages(self.records.home).get(msg_id, False))
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
            self._log_response("said", said_log(self.records.home), read_said)
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
                    outcome, route, detail = send_note(records.home, text)
                except subprocess.SubprocessError as exc:
                    outcome, route, detail = "unknown", "fm-inbox.sh note", str(exc)
                return {"outcome": outcome, "route": route, "detail": detail}

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
            home_path = records.home_path(item["home"]) if item else None
            if not home_path:
                item = None

            def deliver_reply():
                if unread:
                    return {"outcome": "failed", "route": "", "home": "main",
                            "detail": unread}
                if item:
                    outcome, route, detail, mode = deliver_certainly(home_path, item, text)
                    if outcome != "failed":
                        records.invalidate()
                    return {"resolved": "answer", "outcome": outcome,
                            "route": route, "detail": detail, "mode": mode,
                            "home": item["home"], "item": item["id"],
                            "source": item["source"], "key": item.get("key"),
                            "item_key": item_key(item),
                            "sent_count": len(item.get("sent") or [])}
                try:
                    outcome, route, detail = send_note(records.home, text)
                except subprocess.SubprocessError as exc:
                    outcome, route, detail = "unknown", "fm-inbox.sh note", str(exc)
                return {"resolved": "note", "outcome": outcome, "route": route,
                        "detail": detail, "home": "main"}

            entry = {"kind": "reply", "msg": msg_id,
                     "title": message.get("title"), "text": text}
            if item:
                entry["item_key"] = item_key(item)
            sid, error = accept_said(self.records.home, entry, deliver_reply)
            if error:
                self._json(503, {"ok": False, "error": error})
                return
            # A reply is the captain's completed action on this conversation, so
            # it is archived once accepted; a later delivery failure does not
            # put it back in his active list.
            archived = record_archive(self.records.home, msg_id, True) is None
            self._json(202, {"ok": True, "sid": sid, "outcome": "sending",
                             "item_key": entry.get("item_key"), "archived": archived})
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
            home_path = self.records.home_path(home_id)
            if item is None or home_path is None:
                self._json(404, {"ok": False,
                                 "error": "that item is no longer waiting for you"})
                return
            records = self.records

            def deliver_answer():
                outcome, route, detail, mode = deliver_certainly(home_path, item, text)
                if outcome != "failed":
                    records.invalidate()     # force a rescan on the next poll
                return {"outcome": outcome, "route": route, "detail": detail,
                        "mode": mode}

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
