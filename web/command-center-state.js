// command-center-state.js - the command center's decision rules, as pure
// functions of state.
//
// What is here is what got the rules wrong, or what a wrong rule would cost him
// silently: what a poll's answer means for the view on screen, whether a band
// may speak in the present, what a dropped send means on each route, when a
// do-not-resend verdict is set and released, and the order each of the two
// lists is in. They touch no DOM and no network, so
// tests/command-center-state.test.js can execute the real rules rather than a
// restatement of them.
//
// The page loads this before its own script (bin/command-center.html) and
// bin/command-center.py serves it beside the page.

// --- what a poll's ANSWER means -----------------------------------------------
// Only a RESOLVED poll may change any of this. A poll being in flight says
// nothing about the view already on screen, so there is deliberately no entry
// point here for "a request is open".
//
//   answer.kind:
//     'unreachable'  the fetch itself failed - nothing can be sent
//     'unread'       reachable, but no scan has ever published - no list, and
//                    the server refuses sends too
//     'unchanged'    304: the server confirmed the view already on screen
//     'body'         a list arrived; answer.error set means the scan failed
//                    over a list an earlier scan published
function pollFacts(answer, now) {
  switch (answer.kind) {
    case 'unreachable':
      return { connected: false, offline: answer.detail || '', confirmed: false };
    case 'unread':
      return { connected: true, offline: null, unread: answer.detail || '',
               error: null, confirmed: false };
    case 'unchanged':
      // A read. It clears every reachability alarm, not the subset one branch
      // happens to remember: that enumeration is what kept leaving one standing.
      return { connected: true, offline: null, unread: null, error: null,
               confirmed: true, readAt: now };
    case 'body':
      // A body is a resolved read either way, so it always has a read time. An
      // error means the CONTENT is stale, which `confirmed` carries on its own.
      return answer.error
        ? { connected: true, offline: null, unread: null, error: answer.error,
            confirmed: false, readAt: now }
        : { connected: true, offline: null, unread: null, error: null,
            confirmed: true, readAt: now };
  }
  throw new Error('unknown poll answer: ' + answer.kind);
}

// --- may a band speak in the present? ------------------------------------------
// One question: did the last poll confirm the view on screen? Any state that
// leaves it unconfirmed inherits the historical labelling without being listed.
// The read time is the last successful READ, never the view's own `generated`,
// which is when the records last CHANGED - a dead watcher freezes that, so
// reading it as a read time turns the watcher's death into reassurance.
function tense(state, now) {
  const past = !state.confirmed;
  return { past, readAt: past && state.readAt ? state.readAt : now };
}

// --- what a dropped send means, per route ---------------------------------------
// The request never came back. Every Waiting-on-you answer and every note now
// goes only to firstmate's captain inbox - a local record write with no
// worker-facing delivery plane - so a resend is never a second steer landing
// on a worker: it is at worst a second note, and nothing here locks against it.
function transportFailure(source, detail) {
  return { error: detail };
}

// --- when a do-not-resend verdict is set, and when it ends -----------------------
// Nothing on the inbox-note route forbids a resend, so no verdict is ever set.
function verdictFor(source, outcome, detail, sentCount) {
  return null;
}

// Released on EVIDENCE, never on a clock: the item has left the list, or the
// steering record the send was unsure of has since appeared. A view the scan
// did not actually publish knows no items, so it releases nothing.
//
// A verdict against a MESSAGE is not an item's to release. The message log is
// append-only, so nothing in a scan of the work records is evidence about it,
// and a scan is not allowed to quietly re-offer a reply that may already have
// been delivered: that one ends when he says it does.
function releaseVerdicts(verdicts, view) {
  if (view.error || !Array.isArray(view.items)) return verdicts;
  const live = new Map(view.items.map(i => [itemKey(i), i]));
  const kept = {};
  for (const [key, verdict] of Object.entries(verdicts)) {
    if (key.startsWith('msg/')) { kept[key] = verdict; continue; }
    const item = live.get(key);
    if (item && (item.sent || []).length <= verdict.sent) kept[key] = verdict;
  }
  return kept;
}

// --- what a message is, and what order a list is in -----------------------------
// A recorded message (bin/fm-captain-message.sh) is given the same time and
// branch fields a scanned item has, so one grouping and one ordering serve both
// lists rather than two that can drift apart.
function shapeMessage(m) {
  const at = Date.parse(m.at || '');
  return Object.assign({}, m, {
    since_epoch: isNaN(at) ? null : Math.floor(at / 1000),
    since_kind: isNaN(at) ? 'none' : 'created',
    branch_state: m.branch ? 'branch' : 'not-started',
  });
}

// `newestDefault` is what an UNSORTED view means for each list, and the two
// differ honestly: the waiting queue leads with what has waited longest, while
// the messages lead with the last thing firstmate said. Latest and Oldest are
// explicit choices and override both. A row with no usable time is never given
// a position among the dated ones: it follows them, and the page says why.
function orderRows(rows, group, newestDefault) {
  if (group === 'none') return rows;   // as read: the flat list claims no order
  const dated = rows.filter(r => r.since_epoch);
  const undated = rows.filter(r => !r.since_epoch);
  const newest = group === 'latest' || (newestDefault && group !== 'oldest');
  dated.sort((a, b) => newest ? b.since_epoch - a.since_epoch
                              : a.since_epoch - b.since_epoch);
  return dated.concat(undated);
}

// --- stable group order across polls --------------------------------------------
// A grouped view's buckets used to be built in the order their first row was
// reached in the time-sorted list above, so a new message landing on a row
// gave that row a new time and could move its bucket to the top of a poll
// repaint out from under him (his report 2026-09-24: "the project I'm working
// on goes down"). While a Group by is active the bucket order follows the
// chosen key instead - project name, then worktree/branch - and stays put:
// a bucket already on screen keeps its place, a brand-new one is appended at
// the end, never sorted in above the one he is reading.
function stableGroupOrder(prevOrder, keys, infoOf) {
  const present = new Set(keys);
  const known = (prevOrder || []).filter(k => present.has(k));
  const knownSet = new Set(known);
  const fresh = keys.filter(k => !knownSet.has(k)).sort((a, b) => {
    const ga = infoOf(a), gb = infoOf(b);
    const c = String(ga.g1 || '').localeCompare(String(gb.g1 || ''));
    return c !== 0 ? c : String(ga.g2 || '').localeCompare(String(gb.g2 || ''));
  });
  return known.concat(fresh);
}

// --- My words, grouped by conversation -------------------------------------------
// His ruling 2026-09-21: "sort things according to my last reply" - My words
// groups by conversation (the same key its row already opens by: a message it
// replied to, or the item/note key otherwise) and orders those groups by their
// most recent reply, newest first.
function wordConversationKey(r) {
  return r.msg ? 'msg/' + r.msg : (r.item_key || r.key || '');
}

// What a My words row was actually replying to, so it never has to be opened
// just to learn that (his report 2026-09-24: "why i am just getting my
// replies without the original message and context ... i would know what i
// replied to what"). null only for a genuine standalone note - nothing else
// named it, so there is truly nothing to show.
function wordOriginal(r, items, messages) {
  const item = (items || []).find(it => itemKey(it) === (r.item_key || r.key));
  if (item) return { key: itemKey(item), title: item.title, text: item.detail,
    project: item.project, worktree: item.worktree, branch: item.branch };
  const msgId = r.msg || (String(r.key || '').startsWith('msg/') ? r.key.slice(4) : null);
  const msg = (messages || []).find(m => m.id === msgId || 'msg/' + m.id === r.key);
  if (msg) return { key: 'msg/' + msg.id, title: msg.title, text: msg.text,
    project: msg.project, worktree: msg.worktree, branch: msg.branch };
  return null;
}

// `rows` arrives newest first (read_said), so the first row seen for a
// conversation key is already its most recent reply: collecting keys in that
// order and grouping every row under its key's first appearance needs no
// separate sort by time at all.
function orderWordsByLastReply(rows) {
  const order = [];
  const byKey = new Map();
  for (const r of rows || []) {
    const key = wordConversationKey(r);
    if (!byKey.has(key)) { byKey.set(key, []); order.push(key); }
    byKey.get(key).push(r);
  }
  return order.flatMap(key => byKey.get(key));
}

// --- two rows, one send ---------------------------------------------------------
// The click may not wait on a shell command, so the server writes his words to
// the durable record the moment it accepts them and writes the same record
// again under the same `sid` when the command answers (deliver in
// bin/command-center.py). The rows arrive newest first, so the first row for a
// sid is the later one: the outcome supersedes the acceptance.
function foldSaid(rows) {
  const seen = new Set();
  const kept = [];
  for (const r of rows || []) {
    if (r.sid) {
      if (seen.has(r.sid)) continue;
      seen.add(r.sid);
    }
    kept.push(r);
  }
  return kept;
}

// --- the surfaces one send touches ----------------------------------------------
// The box he typed it in, and - when a reply took the answer route - the item
// it steered as well. Everything the page says about a send is said on all of
// them and taken back from all of them, or one surface warns him about a
// delivery the other has already confirmed.
function sendKeys(box, item) {
  return [box, item]
    .filter(Boolean)
    .filter((k, i, all) => all.indexOf(k) === i);
}

// --- every surface one send was held against ------------------------------------
// Found from the surface he is looking at, through the record of the send: a
// reply that took the answer route was locked on the message he typed it in AND
// on the item it steered. One deliberate decision to send again releases it
// everywhere, rather than making him dismiss the same send twice on two
// surfaces.
function heldWith(key, rows, pending) {
  const found = new Set([key]);
  const add = (box, item) => {
    const surfaces = sendKeys(box, item);
    if (surfaces.includes(key)) surfaces.forEach(k => found.add(k));
  };
  for (const r of rows || []) add(r.msg ? 'msg/' + r.msg : '', r.item_key);
  for (const p of Object.values(pending || {})) add(p.key, p.item);
  return [...found];
}

// --- what one send is, taking the page's own surrender into account --------------
// The record is written when the click is accepted and again when the command
// answers, so a row still reading `sending` is a send with no answer yet. But
// once the page has given up on that send (mayRelease below), no surface may
// still say it is on its way: the row and the warning beside it would be
// describing one send two contradictory ways.
function sendState(row, pending) {
  const outcome = (row || {}).outcome;
  if (outcome !== 'sending') return outcome;
  const held = (pending || {})[(row || {}).sid];
  return held && held.released ? 'given-up' : 'sending';
}

// --- was the record actually READ? ----------------------------------------------
// The server answers 200 with no rows and an `error` when it could not read one
// of the logs (_log_response in bin/command-center.py). That is not a read: it
// carries no rows and no news about a send in flight, and holding it as the
// record is exactly how a send whose outcome is already on disk gets released
// as unconfirmed by mayRelease below. Both halves of that invariant live here,
// because the half that lived in the page is the half that broke.
function logRead(body, field) {
  const error = (body && body.error) || null;
  if (error) return { read: false, error: error, rows: null, dropped: 0 };
  return { read: true, error: null, rows: (body && body[field]) || [],
           dropped: (body && body.dropped) || 0 };
}

// --- may a send still marked as going out be released? --------------------------
// The click is answered before the command runs, so a process killed under the
// delivery thread leaves an acceptance row with no outcome row after it. Past
// the send window that is a send nobody can confirm, and the page says so
// rather than leaving a box he can never type in again.
//
// `read` is whether the RECORD THE DECISION IS MADE ON was just read
// successfully. A read that threw leaves the page holding an old list, and
// releasing off that is how a delivery that really did land gets buried under
// an unknown outcome the page invented while it could not see.
function mayRelease(read, held, row, now, windowMs) {
  if (!read || !held || held.released) return false;
  if (held.at && now - held.at < windowMs) return false;
  if (row && row.outcome !== 'sending') return false;   // the record answered it
  return true;
}

// --- did anything actually change? ----------------------------------------------
// A log that does not exist yet is served with no change check, so every poll
// of it is a fresh 200 and "the response arrived" says nothing about whether
// the list moved. Both logs only ever grow at one end, so their length plus
// their newest row is their identity; a poll that finds the same one must not
// re-render, or the open reply box is rebuilt under his cursor every few
// seconds.
function listSignature(rows) {
  const newest = (rows || [])[0] || {};
  return [(rows || []).length, newest.sid || newest.id || '',
          newest.outcome || '', newest.at || ''].join('/');
}

// --- what an arrived outcome does to the words he typed -------------------------
// The click is accepted before the command runs, so the record's outcome row is
// what decides the fate of his draft. Only a send that LANDED may take his
// words out of the box: on failed or unknown they go back where he typed them
// and the row he sent from is flagged, because docs/command-center.md promises
// nothing he typed is cleared by a send that did not land. `null` means the
// outcome has not arrived yet and nothing may happen to them.
// It may only act on the words it is ABOUT. The box keeps his text after the
// click, so by the time the command answers the box may hold something he has
// typed since - a next thought, or a retyped resend. Removing or overwriting
// that is the loss this whole surface exists to end, so unless the box still
// holds exactly what was sent, his words are left alone.
function wordsAfter(row, inBox, sent) {
  if (!row || !row.sid || row.outcome === 'sending') return null;
  if (!sameWords(inBox, sent)) return 'leave';
  return row.outcome === 'sent' ? 'clear' : 'restore';
}

// One owner of "are these the same words he typed". The box holds what he
// typed and a send holds what was sent, and a send is trimmed, so comparing
// them raw makes an ordinary trailing newline in a textarea look like a
// different thought - which would leave every arrived outcome unable to act on
// the send it is about. It answers "is the box empty" too, for the same reason:
// a box holding only whitespace holds nothing he typed.
function sameWords(a, b) {
  return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
}

// --- whose words are in the box? ------------------------------------------------
// A draft the record already speaks for: the words of a send in flight, or of
// one the page gave up on. Only while the box still holds THOSE words - once he
// has typed something else, what is in the box really is unsent and says so.
// Without this the same send reads two ways at once on My words: the record's
// row saying it may already have arrived, and a draft row saying "not sent".
function spokenFor(pending, key, text) {
  return Object.values(pending || {})
    .some(p => (p.key === key || p.item === key) && sameWords(p.text, text));
}

// --- where a reply is about to go -----------------------------------------------
// The same rule the server routes by (waiting_question in
// bin/command-center.py), so the pane can tell him what his reply will do
// BEFORE he sends it rather than after.
//
// Only a message the recorder marked as a question is answerable, and only
// against the decision it named: a task collects several messages over its
// life, so routing by task id alone would write his reply as the answer to
// whatever decision that task happens to be stopped on. Everything else is a
// note to firstmate, which is his words reaching firstmate without being
// delivered as an answer to a question he was not looking at.
function replyTarget(message, items) {
  if (!message.question) return { kind: 'note' };
  const key = message.question_key || '';
  const item = (items || []).find(it => it.home === 'main' && it.id === message.task
    && (key ? it.source === 'status' && (it.key || '') === key
            : it.source === 'hold'));
  return item ? { kind: 'answer', item } : { kind: 'note', settled: true };
}

// --- does a captured message need him to decide something? ----------------------
// A message the recorder marked as a QUESTION always does (message.question,
// set by fm-captain-message-sweep.py, read by replyTarget above). His report
// 2026-09-24: "I see many messages in the Messages group that need my input
// but are not in the Waiting on You group" - a message can plainly ask him to
// decide/approve/choose without ever being recorded as one. Rather than
// guessing at intent, this looks for a literal question or the same handful
// of phrases firstmate itself uses to hand him a decision.
const DECISION_PHRASES = ['reply 1 or 2', 'reply "', "reply '", 'say the word',
  'your call', 'waiting on your', 'tell me', 'let me know'];
function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const low = t.toLowerCase();
  return DECISION_PHRASES.some(p => low.includes(p))
    || /\bmerge\b[^.!]*\?/.test(low) || /\bshould i\b[^.!]*\?/.test(low);
}

// A reply that only asks firstmate something back is not a decision: his
// report 2026-09-24 - "an item must never leave Waiting on you because his
// reply was a QUESTION. Only a reply that decides ... removes it."
const CLARIFY_PHRASES = ['what do you mean', 'explain', 'more info', 'which one', 'why'];
function looksLikeClarifyingReply(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const low = t.toLowerCase();
  return CLARIFY_PHRASES.some(p => low.includes(p));
}

// Waiting on you only while unanswered: once something in the said log
// answers this message (repliesTo in bin/command-center.html: r.msg ===
// message.id) it leaves Waiting on you but stays in Messages, same as an
// answered captain hold leaves the waiting queue but stays in the backlog.
// saidRows is newest first (bin/command-center.py's read_said), so the first
// match naming this message is his LATEST reply to it - and a latest reply
// that only asks firstmate something back never counts as the answer this
// message is waiting on, so it stays exactly as if unanswered.
function messageNeedsReply(message, saidRows) {
  if (!message) return false;
  const flagged = Boolean(message.question) || looksLikeQuestion(message.text)
    || looksLikeQuestion(message.title);
  if (!flagged) return false;
  const latest = (saidRows || []).find(r => r.msg === message.id);
  return !latest || looksLikeClarifyingReply(latest.text);
}

// --- threading firstmate's later answer under his reply --------------------
// His report 2026-09-24: "i rec'd no answer for this yet" - he replied to a
// message and firstmate's actual answer landed as a brand-new row in Messages
// instead of appearing under his reply in the same conversation. The rule, in
// order, is his own: (1) firstmate's message was recorded against the SAME
// task and sent after this reply and before any later reply of his in the
// same conversation; (2) failing that, the message plainly quotes or names
// the same subject (what the reply itself was about); (3) otherwise it is
// never attached - a wrong thread is worse than none.

// The task a said row's own conversation is about, if any. A reply to a
// message (kind 'reply') carries no task of its own - only the message it
// replied to does - so it is looked up there; an answer to a scanned item
// (kind 'answer') already carries it directly as `item`.
function saidTaskId(row, messages) {
  if (!row) return null;
  if (row.kind === 'answer' && row.item) return row.item;
  if (row.msg) {
    const m = (messages || []).find(x => x.id === row.msg);
    if (m && m.task) return m.task;
  }
  return null;
}

// Rule 2: a plain, deliberately narrow substring test - the candidate's own
// title or text must actually contain the subject (what the reply was
// about), never a fuzzy word-overlap score that could pull in an unrelated
// message about the same handful of common words.
function quotesOrNamesSubject(candidate, subjectTitle) {
  const subject = String(subjectTitle || '').trim().toLowerCase();
  if (subject.length < 4) return false;
  const hay = (String(candidate.title || '') + '\n' + String(candidate.text || '')).toLowerCase();
  return hay.includes(subject);
}

// The one message, if any, that answers this one reply: recorded messages
// strictly after the reply and strictly before `untilAt` (the next reply in
// the same conversation, so an answer to reply 1 can never bleed into reply
// 2's own window), earliest such message first.
function matchAnswer(row, taskId, messages, untilAt) {
  const replyAt = Date.parse((row || {}).at || '');
  if (isNaN(replyAt)) return null;
  const untilEpoch = untilAt ? Date.parse(untilAt) : Infinity;
  const inWindow = (messages || []).filter(m => {
    const at = Date.parse(m.at || '');
    return m && m.id && !isNaN(at) && at > replyAt && at < untilEpoch;
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (taskId) {
    const sameTask = inWindow.find(m => m.task === taskId);
    if (sameTask) return sameTask;
  }
  return inWindow.find(m => quotesOrNamesSubject(m, row.title)) || null;
}

// The full conversation, oldest first: his reply, then (when the rule above
// finds one) firstmate's answer, then his next reply, and so on. The same
// candidate message is never claimed twice - once threaded under a reply it
// is out of the pool for every later one.
function threadRows(repliesOldestFirst, messages) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < (repliesOldestFirst || []).length; i++) {
    const row = repliesOldestFirst[i];
    out.push({ kind: 'you', row });
    const taskId = saidTaskId(row, messages);
    const next = repliesOldestFirst[i + 1];
    const pool = (messages || []).filter(m => !used.has(m.id));
    const answer = matchAnswer(row, taskId, pool, next ? next.at : null);
    if (answer) { used.add(answer.id); out.push({ kind: 'firstmate', row: answer }); }
  }
  return out;
}

// The marker the item/pane shows while a reply is outstanding: "answered"
// once firstmate's threaded answer landed after his latest reply, "awaiting
// firstmate" with the wait time otherwise. null when he has not replied at
// all yet, since there is nothing here to mark.
function threadStatus(entries) {
  if (!entries || !entries.length) return null;
  const last = entries[entries.length - 1];
  return last.kind === 'firstmate'
    ? { state: 'answered', at: last.row.at }
    : { state: 'awaiting', at: last.row.at };
}

// --- Messages vs Info -------------------------------------------------------------
// His ask 2026-09-24: "add one more info tab so from messages split into two all
// the messages like nothing new, we are progressing etc. etc. just put in info
// tab" - pure progress/no-change chatter moves to Info; anything reporting a real
// outcome, a landed change, a decision or a problem stays in Messages. Kept
// deliberately conservative (checked AFTER looksLikeQuestion, never before): a
// message that plainly asks him something is never info-only, whatever else it
// says, and nothing not matched here defaults to Info - it defaults to Messages.
const INFO_TERMINAL_PHRASES = [
  'nothing new for the captain', 'nothing new', 'nothing needs you',
  'nothing else needs you', 'nothing to report', 'still running', 'still going',
  'routine progress',
];
function looksLikeInfoOnly(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  const low = t.toLowerCase().replace(/[.!]+$/, '');
  if (/^(ack|acked|noted|ok|okay|got it)$/.test(low)) return true;
  return INFO_TERMINAL_PHRASES.some(p => low === p || low.endsWith(' ' + p) || low.endsWith(': ' + p));
}
function isInfoOnlyMessage(message) {
  if (!message) return false;
  if (message.question) return false;
  if (looksLikeQuestion(message.text) || looksLikeQuestion(message.title)) return false;
  return looksLikeInfoOnly(message.text) || looksLikeInfoOnly(message.title);
}

// --- exactly what Waiting on you counts and lists --------------------------------
// Pure over the three inputs a render already has - the scanned items, the
// captured messages, and what he has said back - so the badge and the rows can
// never drift apart, and neither can move from opening a row or typing into it:
// that touches none of these three arguments, so nothing here can change until a
// poll actually changes an item, a message, or a said record. His report
// 2026-09-24: "i had two items in waiting on you. i clicked one and was
// answering it and saw that now there was only 1" - opening and typing are UI
// state kept entirely outside this function on purpose, so that report can never
// happen again by construction, not by having remembered to guard against it.
function isItemDeferred(it, nowSecs) {
  return Boolean(it && it.deferred_until) &&
    /^\d{4}-\d{2}-\d{2}$/.test(it.deferred_until) &&
    Date.parse(it.deferred_until + 'T00:00:00Z') / 1000 > nowSecs;
}
// A scanned captain-hold item leaves Waiting on you only by an explicit
// Archive or Hold (AGENTS.md: "Replying or answering never archives or
// removes anything on its own") - unlike a message, it has no other tab to
// fall back into, so answering it, even decisively, must never make it
// disappear outright.
function waitingItems(items, nowSecs) {
  return (items || []).filter(it =>
    !isItemDeferred(it, nowSecs) && !it.archived && !it.held);
}
function waitingMessageRows(messages, saidRows) {
  return (messages || [])
    .filter(m => !m.held && messageNeedsReply(m, saidRows))
    .map(m => Object.assign({__msg: true}, m));
}
function waitingCount(items, messages, saidRows, nowSecs) {
  return waitingItems(items, nowSecs).length
    + waitingMessageRows(messages, saidRows).length;
}

// --- may the message list claim to be complete? ---------------------------------
// The messages are captured from the conversation record by
// bin/fm-captain-message-sweep.py, which writes a health record every run; the
// server serves it as `capture` on /api/messages. When capture cannot be shown
// healthy the list must say it may be incomplete, never quietly look short -
// that promise is the reason the capture exists. Returns the band's text, or
// null when the list may speak for itself. The sweep's own record is the truth
// of the last capture whoever ran it (the Stop hook runs it too); the server's
// run_error matters only when that record is missing or stale.
function captureBand(capture) {
  if (!capture || capture.present === false)
    return 'Automatic capture of what firstmate says has not reported yet'
      + (capture && capture.run_error ? ' (' + capture.run_error + ')' : '')
      + ' - this list may be incomplete.';
  if (capture.ok === false)
    return 'Automatic capture of what firstmate says is failing'
      + (capture.error ? ': ' + capture.error : '') + ' - this list may be incomplete.';
  if (capture.active === false)
    return 'No conversation record was found to capture from, so only messages '
      + 'firstmate recorded by hand appear here - this list may be incomplete.';
  // Only a Stop hook's payload names the transcript a session actually writes.
  // Until one has, capture is reading a directory worked out from the home's
  // path, and a session started elsewhere writes where nothing is looking.
  if (!capture.named)
    return 'Automatic capture is reading a conversation directory it worked out '
      + 'for itself; no session has confirmed where it records what firstmate '
      + 'says, so this list may be incomplete.';
  if (typeof capture.age_secs === 'number' && capture.age_secs > 900)
    return 'Automatic capture last ran ' + Math.round(capture.age_secs / 60)
      + ' minutes ago' + (capture.run_error ? ' and the page could not run it: '
      + capture.run_error : '') + ' - messages since then may be missing.';
  return null;
}

// --- has anything he sent changed? ----------------------------------------------
// Delivery now always finishes behind the send, so an outcome landing on the
// record is the ONLY way it reaches the screen. It can land on any record, not
// just the newest: a second send while the first is still delivering pushes the
// first one down the list. So the digest covers every row's outcome, not the
// list's head.
function saidDigest(rows) {
  // received flips with no click of his own behind it - only a poll ever
  // learns it - so it must be part of what "changed" means here, or the
  // received dot would sit stale until something else in the row changed too.
  return (rows || []).map(r => [r.sid || '', r.kind || '', r.outcome || '',
                                r.detail || '', r.received ? '1' : '0']
                                .join('\u0001')).join('\u0002');
}

// --- what the page is holding of the log ----------------------------------------
// The newest window, merged onto what the page already holds. Both are
// newest-first runs of one append-only log, so a row that has fallen out of the
// window since it was read is still his and stays - the two runs overlap and
// the result is one contiguous list.
//
// They do NOT overlap if more than a window arrived between polls (a suspended
// machine, a throttled tab) or if the log was rewritten underneath: everything
// between the two runs would be missing from a list that goes on claiming to be
// whole, and walking back pages from its oldest row, so the hole would never
// close. The stale run is dropped instead - Show older walks back from the
// window and search reads the whole log, so nothing becomes unreachable.
function mergeMessages(fresh, held) {
  const rows = fresh || [], rest = held || [];
  const have = new Set(rows.map(m => m.id));
  const kept = rest.filter(m => !have.has(m.id));
  if (rows.length && rest.length && kept.length === rest.length) return rows;
  return rows.concat(kept);
}

// The identity the server uses too (item_key in bin/command-center.py).
function itemKey(it) {
  return [it.home, it.source, it.id, it.key || ''].join('/');
}

if (typeof module === 'object' && module.exports)
  module.exports = { pollFacts, tense, transportFailure, verdictFor,
                     releaseVerdicts, itemKey, shapeMessage, orderRows,
                     stableGroupOrder, looksLikeQuestion, messageNeedsReply,
                     replyTarget, foldSaid, wordsAfter,
                     listSignature, mayRelease, logRead,
                     sendState, sendKeys, spokenFor, sameWords,
                     heldWith, captureBand, saidDigest, mergeMessages,
                     wordConversationKey, orderWordsByLastReply, wordOriginal,
                     isItemDeferred, looksLikeClarifyingReply,
                     waitingItems, waitingMessageRows, waitingCount,
                     looksLikeInfoOnly, isInfoOnlyMessage,
                     saidTaskId, matchAnswer, threadRows, threadStatus };
