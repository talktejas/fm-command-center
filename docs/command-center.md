# Command center

One permanent page showing everything firstmate has said to you, newest first, with a box to reply in, and beside it everything it is still waiting on you for across every local home.
Its default list is the conversation, because the terminal was the only other copy of it and a terminal scrolls.
Everything else on it is a view over firstmate's own records, not a second place where work lives.

## Start it

```sh
python3 command-center.py --home "$FM_HOME"
```

Then open `http://127.0.0.1:8765`.
That address never changes, so bookmark it once.

Nothing to install: it is Python 3 standard library only, with no build step and no dependency to keep current.
`jq` and `git` are already firstmate requirements and are used by the reading half.

## Keep it running

```sh
python3 command-center.py --install-unit --home "$FM_HOME"
systemctl --user daemon-reload
systemctl --user enable --now firstmate-command-center
loginctl enable-linger "$USER"
```

The last line is what makes it start at boot rather than at your first login.
After this the page is simply there, at the same address, across a server restart, a firstmate restart and a reboot.

`--port` changes the port for both the server and the generated unit.
Re-run `--install-unit` after changing it, then `systemctl --user daemon-reload && systemctl --user restart firstmate-command-center`.

## What it shows

The left list has five tabs.

**Messages** is the default and is what firstmate said to you: one row per message, newest first, each with its title and its time. A captured message's words are never read for which work it is about. When the turn it was said in named exactly one task's own record (`state/<id>.meta` or `.status`) in a tool call, it is recorded against that task with the project and worktree that record names; a turn that named none or several reads "Not recorded". That record holds no branch, so the capture reads it live from the task's worktree when the turn has just ended; a message captured later, or backfilled, reads "Not recorded" for its branch rather than today's branch of that worktree. A message written by hand with `bin/fm-captain-message.sh --task` carries all three. `bin/fm-captain-message-backfill.py` applies the same turn rule to older rows and fills project and worktree for any row carrying a task id whose record still names them; it never guesses from message text, and never derives a past branch from a worktree's current one.
Firstmate's own capture and backfill stop there by design, so this page goes one step further on every read: whatever they still left blank is filled here, from the current records, and never written back to firstmate's log. The captain's own order of precedence: the worker/task this turn was actually handling is checked FIRST, and is the only source used once it names anything at all. That is the row's own `task` when firstmate recorded exactly one, or - when it did not - every task id the turn's own transcript touched: its tool calls (a `state/<id>.*` path, a `data/<id>/` path, an `fm-*.sh <id>` argument, a wake line naming it) and the words that started the turn, read straight from the session's own Claude conversation record (the row's `session`/`req`) and never firstmate's own file. Each id found this way is mapped through its `state/<id>.meta`, its backlog line's `repo:` (open or closed - a Done row keeps its `(repo: X)`) once the meta is gone, or - for a task the backlog never carried at all, a one-off deliverable with only a folder and a brief - the worktree its own `data/<id>/launch-brief.md` or `brief.md` names ("You are in a disposable git worktree of `<repo>`"); a worktree or branch is only ever filled when exactly one id resolves, and several resolved projects all show, joined by " · " (e.g. "fm-command-center · jt2627s"). Only when the worker/task names nothing at all does the message's own words get checked: every task id (backlog, live scan, or brief-only), and a per-project alias table built from `data/projects.md` (each project's own key, its `repo:` name(s), and the plain-English name leading its description) plus a short list of fixed aliases for names a project record never spells out (`jt2627s` also answers to JewelTrek, currency, diamond, metals, manufacturing, sale/sales order; `interactp` to INTERACT; `b2becom` to KaratCraft, b2b; `fm-command-center` to command center, Archive, Work tab, Waiting on you, capture, message-capture; `firstmate` to firstmate itself; `mp` to Bangkok, mp-bkk), matched case-insensitively; a PR URL's repo name is caught by the same word match. A message about "the command center" from before `fm-command-center` existed as its own repo (added to `data/projects.md` 2026-09-21T09:30Z) reads `firstmate` instead - that work was still inside firstmate's own tree then. Only once every tier above comes up with nothing does a short status ping (no task, no words naming anything) borrow the project of the nearest EARLIER message in the same session, within 15 minutes, that resolved one - never a worktree or branch it did not itself resolve, and never a later message. Nothing is ever invented: a row every tier leaves blank still reads "Not recorded", exactly as it does today for a worktree or branch no record carries. Wherever this page filled in more than firstmate itself recorded, a small quiet line under Project/Worktree/Branch names where it came from.
Click one and the whole message opens with a box to reply in.
The list opens on the newest 200 and `Show older messages` walks back through the rest a window at a time, saying how many of the log's messages are loaded: the tab's own count is the whole log, and not shipping all of it at once is not the same as dropping any of it. Search is answered from the whole log, however far back a match is, not only from what is on screen, and a message is found by your own replies to it as well as by its own words.
Where a reply goes depends on how the message was recorded. A message firstmate recorded by hand as a question (`bin/fm-captain-message.sh --question`) is answered as that question: your reply goes to the worker or held task still waiting on that decision, and to firstmate itself once nothing is. A message capture recorded on its own is never a question, so a reply to it always reaches firstmate as a note, never a worker.
The reply box says which of these it is before you send.
Your replies appear under the message, so the exchange reads as a conversation.
An open message has an `Archive` button for a note you have read and need not answer; it moves the message to **Archived**, where the same button reads `Restore to Messages` and moves it back.
Sending a reply archives the message too, once your reply is accepted, so a conversation you have answered leaves Messages on its own; a later delivery failure does not bring it back.
Archived keeps its own count and its own search and `Show older messages`, answered from the whole log like Messages.

These are captured automatically: `bin/fm-captain-message-sweep.py` reads the Claude conversation record on disk, which holds every message verbatim, and records every reply firstmate gave - no agent chooses or remembers to record anything. Only what firstmate said to you counts: its working narration between tool calls, a subagent's chatter, and the lines the harness wrote itself are not replies and never become messages.
It runs from two places, and they know different things. The Claude Stop hook (`bin/fm-captain-message-hook.sh`) fires as each turn ends and hands over the hook payload, which NAMES the transcript that session writes; the sweep reads that one file and nothing else, so the hook is bounded to a few seconds and never holds a turn end. This server sweeps on its own poll cadence, over the directory it derives from the home's path plus every transcript a payload has named - that is what catches turns that ended unusually (interrupted, errored, killed) once their session moves on, and what backfills at startup.
Until some session has named its transcript, the only thing capture has is that derived directory, which is a guess - a session started from somewhere else writes where nothing is looking - so the Messages list says so rather than showing a green band over a list it cannot vouch for.
The messages already in the log are the dedupe record, so the two runners can never record the same message twice.
Its first ever run backfills the log from today's local midnight, so the list starts complete for the day it arrives rather than from the moment it landed.
When capture cannot be shown healthy - it failed, never ran, has not run recently, or found no conversation record to read (a firstmate running on a harness whose conversation record it cannot read) - the Messages list says it may be incomplete rather than quietly showing a short one.
On such a harness, and for anything said outside the recorded conversation, `bin/fm-captain-message.sh` remains the by-hand recorder (`AGENTS.md` section 9).
It is also how a question is routed on a Claude primary: firstmate records a question tied to a decision by hand, and a captured message whose words a by-hand row already carries is not added beside it - each by-hand row stands for one captured message and no more, so saying the same thing again later is still recorded.

**Waiting on you** is the queue firstmate is still holding, from two kinds of durable record:

- A **captain hold** on a backlog task, in any local home: a question filed for you.
- An **open status decision**: a worker that stopped on `needs-decision` or `blocked` and is waiting.
  These never appear as held tasks, which is why a surface built on holds alone cannot reach them.

A stopped worker's row carries the worker's own note, exactly as it wrote it, because the options you are being asked to choose between are the whole value of that row.
The one exception is the machine line a no-mistakes ask-user gate reports itself with, `ask-user findings=<ids> file=<path>`, which is ids and a path with the content deliberately left in the file: that row is stated plainly instead, as which project it is and that a worker there stopped and needs a decision or cannot go on.

**Work** is the fleet-wide picture `/bearings lavish` shows, so answering it never needs a separate page: **Captain's Call** (open decisions), **Underway** (live work), **Recently landed** (what just shipped) and **Charted next** (what is queued or gated), worded exactly as `bin/fm-bearings-board.sh` words them. Its rows come straight from the firstmate root's `bin/fm-bearings-snapshot.sh --json`, enriched here with each row's project, worktree and branch the same way **Waiting on you** reads them, and with a full PR link wherever the snapshot names one. It is read on its own 15-second cadence (`bin/command-center-work.sh`, cached by `command-center.py`'s `Work` class), separately from the 3-second `/api/items` poll, because the snapshot does bounded remote-ledger reads too slow for that cadence. Answering a Captain's Call row, or naming your merge choice, sends `<task id>: <your words>` through `bin/fm-inbox.sh note` — the same note route a reply with nowhere else to go already takes — so firstmate reads it as an ordinary note and acts on it; the command center itself never calls `fm-captain-hold.sh` or a merge command for these rows.

**My words** is everything you have typed here and where it went.

Every row names its project, its worktree and its branch, or says the record does not carry them.
`Group by` arranges the list by project, project and worktree, or project and branch. `Latest first` and `Oldest first` drop the grouping for one flat list in time order, and `Nothing — one flat list` drops it for one list in the order the records were read, making no ordering claim at all.

The messages lead with the last thing firstmate said and the waiting queue with what has waited longest; `Latest first` and `Oldest first` override both.

Beside it, `Filter by state` narrows the waiting list to what is stuck, sent but not acted on, or has nobody listening. Its default view leaves out rows firstmate has already deferred to a date still in the future — they are waiting, but not on you today — and `Deferred` is the one view that shows them.

In every ordered view, rows whose records carry no usable time are never given a guessed position: they follow the dated rows and the list says how many there are. The unsorted flat list orders nothing, so it says nothing about them either.

## What it can and cannot prove

The page never shows a state the records cannot support.

| Shown | Proved by |
|---|---|
| Delivered | the steering record exists under `state/<id>.inbox/` |
| Picked up | the worker moved that record into `handled/`, which is the acknowledgement itself |
| Acted on | the answer itself, which settles the decision in the same act — reported under **My words** |

Nothing is reported between delivered and picked up, because nothing between them is observable.
An item is in the waiting list only while its decision is still open, so the live track carries the first two facts only; the settlement appears under **My words**, written by the act that settled it.
The doorbell ring that `fm-send.sh` types into a pane is best effort and is never treated as proof that anything was read.

The lamp beside each row is `bin/fm-busy-lib.sh`'s classification of whether anyone is listening: **working**, **waiting**, **cannot tell**, **not running**, or **no worker** for a question firstmate itself owns.
A missing or stale signal classifies as *cannot tell* and is never shown as healthy.

Something you sent a worker that has not been picked up is called stuck after 270 seconds, the page's own threshold, chosen to match firstmate's retry ladder: `FM_TASK_INBOX_GRACE_SECS` (default 90) between rings times `FM_TASK_INBOX_RING_MAX` (default 3) rings.
Nothing serves that environment to the browser, so setting either variable changes firstmate's ringing and not this page; to keep the two in step, edit `GRACE_SECS` and `RING_MAX` in `web/command-center.html` as well.

Above the list, every notice that applies is shown as its own band, because two independent facts never share one slot and none of them pushes another off the screen: whatever has gone wrong between the page and the records, a backlog whose holds are hidden, the homes firstmate is not watching, and the homes it is — each named, each with its own last beat from `state/.last-watcher-beat`.
If a home has gone quiet, an answer you send there is still recorded but nothing will ring it, and the page says so rather than looking normal.
Three things can go wrong between the page and the records, and each says what you can do about it. **It cannot reach the server** — nothing can be sent until it is back. **The server answers but no scan has ever succeeded** — there is no list, and the server refuses sends until there is one. **A scan failed over a list an earlier one read** — the list may be incomplete, and everything on it can still be answered.
In all three the health bands stay on screen but stop speaking in the present: they say what was true at the last successful read, and when that read was. A poll merely being in flight changes nothing — the bands keep saying what the last answer established until a new one arrives.

The page itself arrives as two files from the same address: the page, and `command-center-state.js`, the decision rules every band and every send verdict above is made by.
The server refuses to start if either is missing, but a file can still fail to be served under it — during a self-update, say — so if the rules do not arrive the page says it did not load completely and sends nothing, rather than showing an empty list and a live beat it cannot stand behind. Reload; if that does not fix it, restart the command center.

## Where your answer goes

Every answer in **Waiting on you** goes to firstmate's captain inbox first, through `bin/fm-inbox.sh note` — the exact path a plain note already takes — so firstmate is woken and reads your words no matter what happens next. That is the guarantee: once the inbox write succeeds the item reads sent, and it never reads "not sent" again over anything that happens after.

Only then, as a bonus, does the item's own keyed decision route also run:

| You answered | The bonus route |
|---|---|
| a question held for you (`kind: captain`) | `bin/fm-captain-hold.sh answer`, which records your exact words and closes the call in the same act |
| work held pending your answer (any other kind) | `bin/fm-captain-hold.sh answer --release`, which records your words and lifts the hold so the work resumes — it is never marked done |
| a stopped worker | `bin/fm-send.sh --resolve-key`, which puts your words in the worker's steering inbox and closes the decision |

When the bonus route lands, that is what the item shows you — which route ran, and whether it closed the decision or lifted a hold. When it does not — a held row that records no kind at all cannot be told apart from work, a script is missing, a call fails — that failure is folded into the detail of a send that already landed: the worst case is that a person has to finish filing the decision by hand, never a lost answer. Answering a no-kind row directly with `fm-captain-hold.sh`, which can see the task itself, still works and still closes it properly.

A note that answers nothing (typed with no item open) goes through `bin/fm-inbox.sh note` alone, the same as it always has.

## Where your reply to a message goes

| The message was recorded as | It runs |
|---|---|
| the question on a decision still waiting on you | whatever that row would have run under **Where your answer goes** above, unchanged |
| the question on a decision already settled | `bin/fm-inbox.sh note`, queued for firstmate's next turn |
| not a question | `bin/fm-inbox.sh note`, queued for firstmate's next turn |

Whether a message is a question is recorded when it is written, with `--question`, and never guessed from the task it names.
A task collects several messages over its life - the question, then the PR, then the result - so a reply routed by task id alone would be written as the answer to whatever decision that task happens to be stopped on, which is a wrong answer delivered to a worker.
Only the decision the message itself named can be answered by a reply to it.
The reply box says which of the three rows above your reply is about to take, before you send it.
Until the records have been read it says the route cannot be told yet rather than naming one, because the page never claims what the records do not support.

The server decides the route from the recorded message and the current scan, never from the browser.
A reply naming a message this home never recorded is refused, and a task id is only ever matched against the home this page was started on, because two homes on one machine can hold the same one.
A reply to a recorded question whose scan could not be read is not sent at all and reads as failed, so your words come back and sending again is safe; it is never quietly delivered as a note, because a reply that cannot rule out the answer route must not become one.
A reply to a message that is not a question is routed by the record alone: no scan can change where it goes, so a backlog that will not parse has nothing to say about it.
A reply carries the same do-not-resend protection an answer does: on an unconfirmed delivery it keeps your words, stops offering Reply, and waits until you say to send it anyway.
When the reply steers a worker still waiting, that protection covers the item too, so the same worker cannot be reached a second time by answering it from the waiting list instead.

## What it stores

`<home>/data/captain-messages.jsonl`, an append-only log of what firstmate said to you: when, the title, the text, and the project, worktree, branch and task it named, each recorded as unknown rather than guessed when nothing knows it.
It has two writers: the automatic capture above (`bin/fm-captain-message-sweep.py`, which stamps each record with the conversation it came from so it is never recorded twice), and `bin/fm-captain-message.sh` by hand, whose `--task` fills the project, worktree and branch from that task's own record so all three are one flag rather than three chances to leave one out.
`bin/fm-captain-message-backfill.py` never adds a record; it only fills a row's missing task, project and worktree in place (see Messages above). It and both writers share the log's write lock (`state/.captain-message-sweep.lock`), so the backfill's rewrite never loses a concurrent append.
On the by-hand writer, `--question` marks a message as the question waiting on you, and `--question-key` names the stopped worker's own decision it asks about.
The page itself appends one more kind of row: an `archive` or `unarchive` amendment naming the message it changes, and the latest one for a message decides whether it is archived.

`<home>/data/command-center/said.jsonl`, an append-only log of what you typed and where it went.
Every send - an answer, a reply, or a note that answers nothing - returns the moment your words are on disk, so you move to the next item at once and never wait on delivery.
Your words are written there before the click returns, so the click never waits on a shell command: you send, it is recorded, and you move straight to the next item while the delivery is carried out behind you.
That is why one send writes two rows under the same `sid`: **sending** when your words were taken, and the outcome when the command answered.
The page folds the pair and shows the outcome in place on the row you answered, so nothing is claimed about delivery until the command has said it.
Until then the box says your words were written down and are going out, never that they arrived, and the button that sent them does not offer to send them again.

The outcome is read from the exit code of the command that ran and nothing else: **sent**, **failed** (a captain hold refused the record and nothing left this machine — answering it again is safe, and `fm-captain-hold.sh` documents an exact retry as idempotent), or **unknown** (the command reported neither, so the page never guesses which: the page reads only a confirmed `fm-send.sh` exit as sent, and every other exit is unknown to it — including the one that says the answer was delivered but its decision close failed, which the page does not yet report as a state of its own; and `fm-inbox.sh` saves a note before it wakes firstmate, so its failure may mean only that the wake did not land).
An answer in **Waiting on you** never reads **failed** once it has actually been sent: the guaranteed inbox note (see **Where your answer goes**) makes **sent** the floor, and the only way one reads anything else is if that guaranteed note itself could not be confirmed, which reads **unknown** exactly as any other unconfirmed `fm-inbox.sh` send does. A reply that steers an item gets the same guarantee, with one exception that is decided before either route ever runs: a reply to a question whose scan could not be read is refused outright and reads **failed**, because nothing can rule out the answer route without it (see **Where your reply to a message goes**).
On **unknown** the page keeps your text, says plainly that delivery could not be confirmed, and does not offer Send again until the steering record appears — or until you say so yourself, knowing it may be a second copy.
On any other non-success it keeps your text too, so nothing you typed is cleared by a send that did not land.
A record still marked as being delivered by a server that is no longer delivering it - it restarted in between - reads back as **unknown**, because that delivery may or may not have happened.
Your words stay in the box until the outcome row says the send landed; when it says failed or unknown they are put back where you typed them, the row you sent from is flagged `not sent`, and a note that did not land says so on its own button.
An outcome only ever acts on the words it was about: if the box has moved on to something you typed since, that newer text is left alone and the notice says what you sent is kept under **My words** instead.
Each surface says where your words are for its own box, so a reply that steered a worker never claims they are still in a box that never held them.
If no outcome ever arrives, because the server or the page stopped while the command was still running, the page releases that send itself once the send window has passed: your words come back unless the box already holds something you typed since, the controls work again, and the row says plainly that nothing ever reported what became of it.
It releases nothing while it cannot read that log, and a read the server reports as failed is not a read, so an outcome already written is never buried under an outcome the page invented.
Saying to send it anyway releases that send on every surface it was held against, so the same send is never dismissed twice, and it releases the lock without rewriting what happened, so a send the page gave up on goes on reading as given up on under **My words**.

An open item shows one line derived from this record: the last thing you sent about it and what became of it, and a message shows every reply you sent to it.
Your own words are served whole, and if that list is ever shortened the page says so and says how many rows are missing, because a reply missing from a thread reads as a message you never answered.

If that log cannot be written the send is refused before anything is delivered: the page says it was not sent and keeps your words in the box, because a send it called accepted while recording nothing would be the one way this page could lose them.

That exists because firstmate keeps an answer that closes a decision but does not keep the rest of your words: a steer to a worker is removed with the task's steering inbox at cleanup, and an unsent draft was never recorded anywhere.
Everything else on the page is read fresh from firstmate's records, so there is no second copy to drift.

Two things stay in this browser, in its local storage, because they are yours and this runs on your machine: unsent drafts (an answer in progress and an unsent note alike), and which rows you have already opened.
They are per-browser and per-profile: they do not follow you to another browser, another machine or a private window, and clearing site data deletes them. What that costs you is a draft you had not sent; everything you did send is in firstmate's own records and in the log above.

## Cost and limits

The page polls `/api/items` every three seconds and is answered `304` when nothing moved.
The change check is a stat sweep over every status log, task meta, steering inbox and backlog across all homes, which takes about 30ms, so the full scan runs once per real change however many tabs are open.

Server-sent events were rejected deliberately: a browser allows six connections per origin, and a held stream per tab is what already stalls this fleet's review pages once six are open.

It binds loopback only.
It runs firstmate's scripts with your authority and has no authentication of its own, so it must never be bound to a routable address.

Remote secondmate homes are not polled: reaching one needs the remote transport, which is not a cost a three-second poll may pay.
Only local homes appear.

A home whose holds are hidden from the page — one on a non-markdown backlog backend, or one whose backlog file is there but cannot be read — reports `backlog_readable: false`, and the page says so in its own band rather than letting the list look short. A markdown home whose backlog file does not exist yet is a different thing: it holds nothing, so it reports readable and empty and gets no band.

## Reading it without the page

`command-center-scan.sh` prints the waiting view as JSON, and `--fingerprint` prints only the change check.
`<home>/data/captain-messages.jsonl` is one JSON object per line - a message or an archive amendment - and needs nothing to read it: the whole of it is on disk whatever the page has loaded.
Both honour `FM_HOME`.
