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
// A field the record says it does not know - empty, or written out as
// "unknown" - is the same as one it never carried (known_value in
// command-center.py): null, so every list shows it as "Not recorded" in one
// place. No field is ever a reason to leave a row out (his ruling 2026-09-28:
// "if u cant find... u should still show me the message").
const UNKNOWN_VALUES = new Set(['', 'unknown', 'null', 'none', 'n/a', 'not recorded']);
function knownValue(v) {
  if (v == null) return null;
  const t = String(v).trim();
  return UNKNOWN_VALUES.has(t.replace(/^\(+|\)+$/g, '').trim().toLowerCase()) ? null : t;
}

function shapeMessage(m) {
  const at = Date.parse(m.at || '');
  const project = knownValue(m.project), worktree = knownValue(m.worktree),
        branch = knownValue(m.branch);
  return Object.assign({}, m, {
    project, worktree, branch,
    // A row with no title of its own still needs something to click.
    title: knownValue(m.title) || String(m.text || '').trim().split('\n')[0].slice(0, 140)
      || '(no title recorded)',
    since_epoch: isNaN(at) ? null : Math.floor(at / 1000),
    since_kind: isNaN(at) ? 'none' : 'recorded',
    branch_state: branch ? 'branch' : 'not-started',
  });
}

// `newestDefault` is what an UNSORTED view means for each list, and the two
// differ honestly: the waiting queue leads with what has waited longest, while
// the messages lead with the last thing firstmate said. Latest and Oldest are
// explicit choices and override both. A row with no usable time is never given
// a position among the dated ones: it follows them, and the page says why.
// `timeOf` is the time a list orders by - a row's own time unless the list
// says otherwise (Archived orders by archivedEpoch below).
function orderRows(rows, group, newestDefault, timeOf = r => r.since_epoch) {
  if (group === 'none') return rows;   // as read: the flat list claims no order
  const dated = rows.filter(r => timeOf(r));
  const undated = rows.filter(r => !timeOf(r));
  const newest = group === 'latest' || (newestDefault && group !== 'oldest');
  dated.sort((a, b) => newest ? timeOf(b) - timeOf(a) : timeOf(a) - timeOf(b));
  return dated.concat(undated);
}

// When a row was archived (his ask 2026-09-28: the latest archived on top),
// from the archived_at the server reads off the archive record itself. A row
// archived before that record was read back falls back to its own time.
function archivedEpoch(r) {
  const at = Math.floor(Date.parse(r.archived_at || '') / 1000);
  return at || r.since_epoch || null;
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
//
// A message Jev sorts after it was first served changes tab with neither end
// of the list moving, so how many rows sit in each sorted tab is part of the
// identity too - or that poll looks unchanged and the row never moves.
function listSignature(rows) {
  const newest = (rows || [])[0] || {};
  const sorted = SORT_TABS.map(tab => (rows || []).filter(r => sortedTab(r) === tab).length);
  // So is a project label Jev changed after the row was served.
  const relabelled = (rows || []).filter(r => r.project_by).map(r => r.project).join(',');
  return [(rows || []).length, newest.sid || newest.id || '',
          newest.outcome || '', newest.at || '', sorted.join('.'), relabelled].join('/');
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
// A decision firstmate has already closed is still served (remember_waiting),
// but it is settled, exactly as the server's waiting_question reads it: the
// reply is a note, and `item` is handed back so the pane can show what
// firstmate recorded as the answer.
function replyTarget(message, items) {
  if (!message.question) return { kind: 'note' };
  const key = message.question_key || '';
  const named = (items || []).filter(it => it.home === 'main' && it.id === message.task
    && (key ? it.source === 'status' && (it.key || '') === key
            : it.source === 'hold'));
  const open = named.find(it => !it.closed);
  if (open) return { kind: 'answer', item: open };
  return named.length ? { kind: 'note', settled: true, item: named[0] }
                      : { kind: 'note', settled: true };
}

// --- Jev's sorting ----------------------------------------------------------------
// command-center.py's Sorter asks Jev (TypeSafe's decision-only model) which of
// his three tabs a message belongs in, once per message and behind the page,
// and serves the placement as message.sort.tab: 'decision' (Waiting on you -
// the message itself asks him to act, checking a thing prepared for him included),
// 'message' (Messages) or 'info' (Info). The server has already applied the
// confidence floor - an unsure answer is served as 'message' - and never sorts
// a recorded question. No sort on a row (no key, switched off, not asked yet,
// the call failed) reads as null here, and the rules below place it exactly as
// they did before Jev: this is one more input to them, not a second set.
const SORT_TABS = ['decision', 'message', 'info'];
function sortedTab(message) {
  const tab = message && message.sort && message.sort.tab;
  return SORT_TABS.includes(tab) ? tab : null;
}

// --- does a captured message need him to decide something? ----------------------
// A message the recorder marked as a QUESTION always does (message.question,
// set by fm-captain-message-sweep.py, read by replyTarget above). His report
// 2026-09-24: "I see many messages in the Messages group that need my input
// but are not in the Waiting on You group" - a message can plainly ask him to
// decide/approve/choose without ever being recorded as one. Rather than
// guessing at intent, this looks for a literal question or the same handful
// of phrases firstmate itself uses to hand him a decision.
//
// His rule 2026-09-28: "Waiting on you is things u need input / decisions from
// me." A message that only recalls an ask made elsewhere ("Nothing new. Still
// waiting on your A, B or C") is not itself one - the message that asked is
// what waits on him - so "waiting on your ..." counts unless the message says
// it is still waiting or that nothing is new.
const DECISION_PHRASES = ['reply 1 or 2', 'reply "', "reply '", 'say the word',
  'your call', 'tell me', 'let me know'];
const RECALLED_ASK = /\bstill waiting on your\b|\bnothing (new|changed)\b/;
function looksLikeQuestion(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (t.endsWith('?')) return true;
  const low = t.toLowerCase();
  return DECISION_PHRASES.some(p => low.includes(p))
    || (low.includes('waiting on your') && !RECALLED_ASK.test(low))
    || /\breply [a-d1-9]\b/.test(low)
    || /\bmerge\b[^.!]*\?/.test(low) || /\bshould i\b[^.!]*\?/.test(low);
}

// Waiting on him until firstmate closes it. His own reply never removes it
// (his report 2026-10-06: a question typed back on an Action row made it vanish,
// "my unarchived actions going away"): it stays in Action, threaded under it,
// until he archives it (Archived) or BOTH hold: firstmate recorded an answer to
// one of his replies to this message (answeredByFirstmate), and the decision it
// names is closed - its record is gone from the open set or closed (replyTarget).
// A merge ask leaves through its pull request instead (mergeAskOnly).
function answeredByFirstmate(message, saidRows, answers) {
  const sends = (saidRows || []).filter(r => r.msg === message.id && r.note_id);
  return sends.some(r => (answers || []).some(m => m.answers === r.note_id));
}
// His rule 2026-10-07 (the tenth time): the tab is decided ONLY by what firstmate
// recorded - no reading of the words, no Jev, no repeat or opening-word rules.
// Action: a recorded question from firstmate (question or question_key); an
// automatic capture (source transcript) is never Action.
function messageNeedsReply(message, saidRows, items, answers) {
  if (!message) return false;
  if (!(message.question || message.question_key) || message.source === 'transcript') return false;
  const named = replyTarget(message, items).item;
  const closed = !named || named.closed;
  return !(closed && answeredByFirstmate(message, saidRows, answers));
}

// --- one record, one tab ----------------------------------------------------------
// His ruling 2026-09-28: "Don't duplicate the items. If an item is in Waiting
// for You, don't put the same item in the message tab" - archiving a batch in
// Messages quietly took three rows out of Waiting on you. So a message waiting
// on him is listed ONLY in Waiting on you; once answered or settled it moves to
// Messages (or Info), and only there can a batch reach it. Every badge counts
// through these same two rules, so no record is counted twice.
// A merge ask is never Input (mergeAskOnly below): while the pull request it
// names waits it is shown inside that PRs row and nowhere else; naming none
// that waits, it is a message to read.
function inMessagesTab(message, saidRows, items, prs, answers) {
  if (message.held) return false;
  if (!messageNeedsReply(message, saidRows, items, answers)) return true;
  return mergeAskOnly(message, prs) ? !prRowFor(message, prs) : false;
}

// --- pull requests: their own tab, never Input ------------------------------------
// His ruling 2026-10-05: "merge will go in seperate PR tab and not in action
// tab. action is only where u need my input." The PRs tab lists what the
// server reads from each home's task records (/api/prs, command-center.py's
// waiting_prs). A message waiting on him that is nothing but a merge ask is
// taken out of Input; the pull request's own row shows its words (prAsks).
function prText(message) {
  return String((message && (message.text || message.title)) || '');
}
function namesPr(message, pr) {
  if (!message || !pr || !pr.url) return false;
  const at = prText(message).indexOf(pr.url);
  // ".../pull/22" must not match ".../pull/224".
  return at >= 0 && !/\d/.test(prText(message).charAt(at + pr.url.length));
}
const PR_REF = /\/pull\/\d+|\bPRs? ?#?\d+|\bpull requests?\b/i;
const MERGE_ASK = /\b(your|the captain's) merge\b|\bmerge (it|them|this|word|call)\b|\bmerge\b[^.!?\n]*\?|\bready (to|for) (be )?merged?\b|\bsay ["']?merge\b|\bready (for|to) (your|the captain's) (word|merge)\b/i;
// "Nothing but": every question in it is about merging, and it offers no
// pick, options or other ask beside the merge.
// ponytail: wording heuristics over firstmate's own phrasing; if firstmate
// ever records a merge ask as its own kind, read that field instead.
// Structural first (his report 2026-10-05, "why the fuck pr is coming under
// input?"): a recorded question on a task whose pull request waits in the PRs
// data (prs) is a merge ask when its words ask for a merge and nothing else -
// no wording test on the merge itself, which missed "say merge 38". Only a
// message with no such task falls back to the wording test.
const MERGE_VERB = /\b(merge|land|approve)\b/i;
function mergeAskOnly(message, prs) {
  // Remembered by the server once it was read as a merge ask (apply_merge_asks),
  // so it stays one after its task record - and its pull request - is gone.
  if (message && message.merge_ask) return true;
  const t = prText(message);
  const low = t.toLowerCase();
  if (ASKS.some(p => low.includes(p)) || /\breply [a-d1-9]\b/.test(low)
      || /\b[a-d1-9],? or [a-d1-9]\b/.test(low)) return false;
  const onlyMerge = (t.match(/[^.!?\n]*\?/g) || []).every(q => /\bmerge/i.test(q));
  if (message && message.question && message.task
      && (prs || []).some(pr => pr.id === message.task) && MERGE_VERB.test(t)) return onlyMerge;
  return PR_REF.test(t) && MERGE_ASK.test(t) && onlyMerge;
}
// The waiting pull request row a merge ask belongs in, or null.
function prRowFor(message, prs) {
  return (prs || []).find(pr => (message && message.merge_ask
    ? message.merge_ask === pr.url
    : namesPr(message, pr) || (message && message.task === pr.id))
    && mergeAskOnly(message, [pr])) || null;
}
function prAsks(pr, messages, saidRows, items, answers) {
  return (messages || []).filter(m => !m.held && prRowFor(m, [pr]) === pr
    && messageNeedsReply(m, saidRows, items, answers || messages));
}

// --- repeats go to Ignore ---------------------------------------------------------
// His ask 2026-10-05: "these repeted messages about pr waiting to be merged
// should not come in command center... not to bog the user down with same
// details again and again". Two kinds, both judged against every EARLIER
// message the page holds: a word-for-word copy of a note already shown, and a
// note that a pull request is still waiting when that pull request was already
// reported. The first report of a pull request is never a repeat. A copy that
// asks him for something is not one either (asksHim: a pick he owes is never
// noise). Marks message.repeat in place - isInfoOnlyMessage reads it - and
// returns the same list; newest first, like everything the page holds.
const STILL_WAITING = /\bstill (open|holding|waiting|parked|on you)\b|\b(holding|waiting|parked)\b[^.\n]*\bmerge\b|\bmerge (word|call)\b|\b(waiting|waits) (for|on) your word\b/i;
function prRefs(text) {
  const refs = [];
  for (const m of String(text || '').matchAll(/([\w.-]+)\/pull\/(\d+)/g)) refs.push(m[1] + '/' + m[2]);
  for (const m of String(text || '').matchAll(/\bPRs? ?#?(\d+)/gi)) refs.push('/' + m[1]);
  return refs;
}
function markRepeats(messages) {
  const texts = new Set(), seen = new Set();
  // "PR 224" names no repository: it matches any pull request 224 seen so far.
  const known = ref => ref.startsWith('/')
    ? [...seen].some(s => s.endsWith(ref)) : seen.has(ref);
  const rows = messages || [];
  for (let i = rows.length - 1; i >= 0; i--) {
    const m = rows[i], t = prText(m), norm = t.toLowerCase().replace(/\s+/g, ' ').trim();
    const refs = prRefs(t);
    m.repeat = Boolean(norm) && ((texts.has(norm) && !asksHim(t))
      || (refs.length > 0 && STILL_WAITING.test(t) && refs.every(known)));
    texts.add(norm);
    refs.filter(r => !r.startsWith('/')).forEach(r => seen.add(r));
  }
  return rows;
}

// His board shows only what firstmate has put to HIM (his ruling 2026-09-28,
// shown "CI check failing: ... provider reported failure"): a captain hold. A
// worker's own needs-decision/blocked status line is the worker asking
// FIRSTMATE; firstmate escalates one by recording a question message
// (--question-key), and that message is what he sees. The scan still reads
// status decisions - reply routing and firstmate's own view need them - they
// are just never a row or a count on any of his tabs.
function onHisBoard(item) {
  return Boolean(item) && item.source === 'hold';
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

// --- answers firstmate RECORDED as answers ------------------------------------
// His report 2026-09-28: "why ... there is no response from u". The rule above
// only guesses, so since then firstmate records an answer AS the answer to one
// send of his: `fm-captain-message.sh --answers <note-id>` writes `answers` on
// the message, naming the inbox note id his send was delivered as (said.jsonl's
// note_id - the id `fm-inbox.sh list` shows firstmate). A recorded answer is
// never guessed at: it threads under the send it names and nowhere else, and a
// send with one never falls back to the guess. Everything recorded before this
// carries no `answers`, so it threads exactly as it always did.
const answersSend = (m, row) => Boolean(m && m.answers && row && row.note_id)
  && m.answers === row.note_id;
function recordedAnswers(row, messages) {
  return (messages || []).filter(m => answersSend(m, row))
    .sort((a, b) => Date.parse(a.at || '') - Date.parse(b.at || ''));
}
// The send of his a message records itself as answering, if the page holds it.
function answeredSend(message, saidRows) {
  if (!message || !message.answers) return null;
  return (saidRows || []).find(r => r.note_id === message.answers) || null;
}

// What a recorded answer answers, for its own row and pane (his question
// 2026-09-28, "but what if i have already archived that message?"): the send
// it names, and the message that send replied to - looked up in `messages`,
// which the page passes archived ones included, so an answer to a message he
// archived still says plainly what it answers. `title` comes off the send
// itself (said.jsonl records the title it replied to), so an item reply or an
// original the page no longer holds still names what it was about.
function answerFor(message, saidRows, messages) {
  const send = answeredSend(message, saidRows);
  if (!send) return null;
  const original = send.msg ? (messages || []).find(m => m.id === send.msg) || null : null;
  return { send, original, title: (original && original.title) || send.title || null };
}

// One record, one tab (his ruling 2026-09-28, "i think u unarchive that and
// continue the thread"): a recorded answer to one of his replies is part of
// that message's conversation, so it is threaded there and never listed as a
// row of its own. The conversation it continues sorts by the answer's time,
// since that is the last thing firstmate said in it, and carries `answered_by`
// (the newest answer's id) so the page can show it unread again. An answer
// whose message `allMessages` does not hold - aged out of every window the
// page has - stays a row of its own, since there is nowhere else to show it.
function foldAnswers(rows, saidRows, allMessages) {
  const held = new Set((allMessages || []).map(m => m.id));
  const latest = {};
  const folded = new Set();
  for (const m of allMessages || []) {
    const a = answerFor(m, saidRows, allMessages);
    const of = a && a.send.msg;
    if (!of || of === m.id || !held.has(of)) continue;
    folded.add(m.id);
    const at = Date.parse(m.at || '');
    if (!isNaN(at) && !(latest[of] && latest[of].at >= at)) latest[of] = { at, id: m.id };
  }
  return (rows || []).filter(m => !folded.has(m.id)).map(m => {
    const l = latest[m.id];
    if (!l) return m;
    return Object.assign({}, m, { answered_by: l.id,
      since_epoch: Math.max(m.since_epoch || 0, Math.floor(l.at / 1000)) });
  });
}

// The full conversation, oldest first: his reply, then firstmate's answer -
// every recorded one, else the one the rule above finds - then his next reply,
// and so on. The same candidate message is never claimed twice - once
// threaded under a reply it is out of the pool for every later one - and a
// recorded answer is never in the pool at all, since it names its own send.
function threadRows(repliesOldestFirst, messages) {
  const used = new Set();
  const out = [];
  for (let i = 0; i < (repliesOldestFirst || []).length; i++) {
    const row = repliesOldestFirst[i];
    out.push({ kind: 'you', row });
    const recorded = recordedAnswers(row, messages);
    if (recorded.length) {
      for (const m of recorded) out.push({ kind: 'firstmate', row: m });
      continue;
    }
    const taskId = saidTaskId(row, messages);
    const next = repliesOldestFirst[i + 1];
    const pool = (messages || []).filter(m => !used.has(m.id) && !m.answers);
    const answer = matchAnswer(row, taskId, pool, next ? next.at : null);
    if (answer) { used.add(answer.id); out.push({ kind: 'firstmate', row: answer }); }
  }
  return out;
}

// A note answered in ordinary conversation names no note - only an answer
// recorded with --answers does - so without this a note read "unanswered"
// while its answer sat on the same board (his report 2026-09-28). A note is
// about no task, so the moment is all there is to match on: the first thing
// firstmate said after it, within NOTE_MOMENT_MINUTES and before his next send
// of any kind, that is not a recorded answer to something else, not an empty
// turn, and not about the task of another send of his still in that window.
// The page marks the match as matched, never as recorded.
const NOTE_MOMENT_MINUTES = 15;
function noteMomentAnswer(note, messages, saidRows) {
  const at = Date.parse((note || {}).at || '');
  if (isNaN(at)) return null;
  const sends = (saidRows || []).filter(r => r !== note && r.sid !== note.sid);
  const next = sends.map(r => Date.parse(r.at || ''))
    .filter(t => !isNaN(t) && t > at).reduce((a, b) => Math.min(a, b), Infinity);
  const until = Math.min(at + NOTE_MOMENT_MINUTES * 60000, next);
  const since = at - NOTE_MOMENT_MINUTES * 60000;
  const otherTasks = new Set(sends.filter(r => {
    const t = Date.parse(r.at || '');
    return !isNaN(t) && t >= since && t < at;
  }).map(r => saidTaskId(r, messages)).filter(Boolean));
  return (messages || []).filter(m => {
    const t = Date.parse(m.at || '');
    return m && m.id && !isNaN(t) && t > at && t < until && !m.answers
      && !/^\*\(no message/.test(String(m.title || '')) && !otherTasks.has(m.task);
  }).sort((a, b) => Date.parse(a.at) - Date.parse(b.at))[0] || null;
}

// A note he sent from "Tell firstmate something" hangs off no message or item,
// so it is a conversation of its own: listed in Messages, "awaiting firstmate"
// until an answer is recorded against it. Only a note the server marked
// `answerable` (sent once firstmate could record an answer to it) is listed -
// an older one could never be answered, and would sit there awaiting forever.
function noteThreads(saidRows) {
  return (saidRows || []).filter(r => r.kind === 'note' && r.answerable && r.sid
    && !r.deleted);
}

// The marker the item/pane shows while a reply is outstanding: "answered"
// once firstmate's threaded answer landed after his latest reply, "awaiting
// firstmate" with the wait time otherwise. null when he has not replied at
// all yet, since there is nothing here to mark.
// A send firstmate has acknowledged (`received`: the note moved to
// state/inbox/handled/) is no longer awaiting it, answer recorded or not - his
// report 2026-10-05: "Why the fuck is it still showing 'Awaiting Firstmate'" on
// notes firstmate had already read. Nothing is claimed in its place: the row
// carries no marker until an answer threads under it and it reads "answered".
function threadStatus(entries) {
  if (!entries || !entries.length) return null;
  const last = entries[entries.length - 1];
  if (last.kind === 'firstmate') return { state: 'answered', at: last.row.at };
  return last.row.received ? null : { state: 'awaiting', at: last.row.at };
}

// --- Messages vs Info -------------------------------------------------------------
// His ask 2026-09-24 split Messages into Messages and Info. His report
// 2026-09-28 ("why the fuck now important message which i need to review is in
// info instead of fucking message" - firstmate's finding that the cause of his
// vanishing items was established, filed as Info) set the test: not "does it
// ask him something" but "would he want to know this". Messages holds any
// finished work, any result/finding/cause, any failure or blocker, anything
// asking him to review/approve/merge/decide, and anything that changed in
// something he uses. Info holds only genuine noise - an ack, "nothing new",
// "understood", "on it", "still running", progress with no result. A message
// these rules cannot place goes to MESSAGES: burying a result he needed costs
// far more than one extra line there.
//
// In order, first match wins:
//   1. recorded as a question, or the text ends with "?"      -> Messages
//   2. asks him to decide (looksLikeQuestion's phrases, or ASKS), not
//      counting a sentence that only recaps what is already
//      "waiting on your word"                                 -> Messages
//   3. anywhere in it: an outcome, a finding, a failure, a
//      change, or a review/merge ask (SIGNAL below)           -> Messages
//   0. its opening words declare nothing in it is for him
//      (declaresNothingForHim) - before Jev too               -> Info
//   4. says there is nothing new, or reads as an ack or as
//      progress with no result (NOISE below)                  -> Info
//   5. anything else                                          -> Messages
const RECAP = /[^.\n]*waiting on your[^.\n]*/gi;
// Asks looksLikeQuestion does not know. Kept here, not added there, so this
// changes only Messages vs Info and never what Waiting on you lists.
const ASKS = ['pick a name', 'pick one', 'choose', 'say go'];
const SIGNAL = new RegExp([
  // finished / landed / live / changed
  '\\b(landed|merged|shipped|deployed|released|finished)\\b',
  '\\b(is|are|now|and|been) (live|fixed|done|finished|ready|built|back up|in place)\\b', '\\bready for your\\b',
  '\\bis in[.!]', '\\bexists[.!]', '\\bnow (runs|works|threads|shows|opens|reads|keeps|goes)\\b',
  '\\b(changed|reload|refresh)\\b', '/pull/\\d',
  // a result: finding, cause, conclusion
  '\\b(root )?cause[sd]?\\b', '\\b(established|found|confirmed|verified|reproduced|measured|diagnosed)\\b',
  '\\bturns out\\b', '\\bthe (reason|result|finding|evidence|answer|conclusion)\\b',
  '\\b(audit|research|review|investigation|answer) is (in|done)\\b',
  // failed / broken / blocked
  '\\b(failed|failing|failures?|crashed|broken|blocked|blocker|stuck|lost|regression)\\b',
  '\\b(is|went|was) down\\b', "\\b(not|isn't|aren't|still not) working\\b",
  // asks him to review / approve / merge
  '\\b(your|for) (review|approval|merge|yes|go-ahead)\\b', '\\bapprov(e|ed|al)\\b',
].join('|'));
// "nothing stuck", "none failing": a signal word it says did NOT happen.
const NEGATED = /\b(nothing|none|no|not|never) (stuck|changed|failing|failed|broken|blocked|lost)\b/g;
const NOISE = new RegExp([
  '\\bnothing (new|changed|for (you|the captain))\\b(?! will)', '\\bnothing (else )?needs you\\b', '\\bnothing to report\\b',
  '^(captain, )?(ack|noted|understood|aye|got it|will do|roger|shipshape|agreed|expected|already handled|on it)\\b',
  '\\broutine progress\\b', '\\bin progress\\b', '\\bdispatched\\b',
  '\\bstill (running|validating|working|building|going)\\b',
  '\\b(is|are) (now )?(running|validating|working on|building|looking into)\\b',
  '\\bgoing through its checks\\b', '\\bleftover alert\\b', '\\bnothing to do\\b', '\\bno message\\b',
].join('|'));
// Finished work, a result, a failure, a review or merge ask: what Action takes
// up when it is not a question, and what Info never holds (looksLikeInfoOnly).
function mustBeSeen(text) {
  return SIGNAL.test(String(text || '').toLowerCase().replace(NEGATED, ''));
}
// Routine is short: an ack or a status line. Every message in the real log
// longer than this that NOISE caught was an explanation, a finding or a plan
// written back to him ("you're right, and here is why..."), never routine.
const ROUTINE_MAX = 400;
// Rule 0, before every rule above and before Jev (his replies 2026-10-05, on
// "Nothing for you, captain — another GitHub read timing out" and on one whose
// body named a failing check and its evidence: "these are just info", "Nothing
// for you, captain all these kind go in info"): a message whose own opening
// words declare there is nothing in it for him is Info ALWAYS, whatever the
// rest of it says and whatever Jev read it as. Only the opening clause counts -
// "nothing changed" deep in a report declares nothing about the report.
const NOTHING_FOR_HIM = new RegExp('\\b(' + [
  'nothing (has |have )?(new|changed)', 'nothing (new |here |in (this|that) )?for (you|the captain)',
  'nothing (is )?(needed|required) from (you|the captain)', 'nothing (else )?needs you',
  'nothing to report', 'no change', 'no action (needed|required)',
].join('|') + ')\\b(?! will)', 'i');
// So is a short bare acknowledgement that it has stopped as he told it to
// ("Held, captain — I've stopped the worker ... waits for your word", which
// Jev read as a decision): his own order coming back is nothing to act on.
const HOLD_ACK = /^(captain, )?(held|holding|standing by|stood down)\b/i;
// Never when the same message asks him for something (his reply 2026-10-05,
// on "Still waiting on your prototype pick — A, B, C or D." filed as Info:
// "this is fucking important should go in waiting for u"): a pick or decision
// he owes is never noise, even recalled, even under "Nothing new".
function asksHim(text) {
  const low = String(text || '').toLowerCase();
  return low.includes('?') || low.includes('waiting on you') || low.includes('still yours')
    || /\byour (pick|choice|decision|answer|go-ahead|approval)\b/.test(low)
    || /\breply [a-d1-9]\b/.test(low)
    || DECISION_PHRASES.some(p => low.includes(p)) || ASKS.some(p => low.includes(p));
}
function declaresNothingForHim(text) {
  const t = String(text || '').trim();
  const opening = t.split(/\n| — | - |[.:;!?](\s|$)/)[0].slice(0, 120);
  return (NOTHING_FOR_HIM.test(opening) || (HOLD_ACK.test(opening) && t.length <= ROUTINE_MAX))
    && !asksHim(t);
}
function looksLikeInfoOnly(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (declaresNothingForHim(t)) return true;
  if (t.endsWith('?')) return false;
  const asked = t.replace(RECAP, '');
  // Nothing but a recap of an ask he still owes: never Info. Jev decides
  // whether it waits on him; unsorted, it is a message to read.
  if (!/[a-z0-9]/i.test(asked)) return false;
  if (looksLikeQuestion(asked) || ASKS.some(p => asked.toLowerCase().includes(p))) return false;
  const low = asked.toLowerCase();
  if (mustBeSeen(low)) return false;
  if (t.length > ROUTINE_MAX) return false;
  return NOISE.test(low);
}
// Ignore is firstmate's own fixed filler: a title of exactly "No change" (any
// case, optional trailing period), or a text that starts with "No change".
// Everything else that is not Action is Info - always.
const NO_CHANGE_TITLE = /^no change\.?$/i;
function isInfoOnlyMessage(message) {
  if (!message) return false;
  if (message.question || message.question_key) return false;
  return NO_CHANGE_TITLE.test(String(message.title || '').trim())
    || /^no change/i.test(String(message.text || '').trim());
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
// A captain hold leaves Waiting on you only by his explicit Archive, Hold or
// Delete (AGENTS.md: "Replying or answering never archives or removes anything
// on its own"): it has no Messages-like tab where settled holds live, so
// answered or closed it stays here, marked, rather than vanishing. A message
// does have one, so answered or settled it moves there (inMessagesTab above) -
// only the record he answered moves, and the pane stays on it.
function waitingItems(items, nowSecs) {
  return (items || []).filter(it => onHisBoard(it) &&
    !isItemDeferred(it, nowSecs) && !it.archived && !it.held);
}
function waitingMessageRows(messages, saidRows, items, prs, answers) {
  return (messages || [])
    .filter(m => !m.held && messageNeedsReply(m, saidRows, items, answers || messages) && !mergeAskOnly(m, prs))
    .map(m => Object.assign({__msg: true}, m));
}
function waitingCount(items, messages, saidRows, nowSecs, prs, answers) {
  return waitingItems(items, nowSecs).length
    + waitingMessageRows(messages, saidRows, items, prs, answers).length;
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
// ctx (captureContext in web/command-center.html): newestAt (ms) of the newest
// message the page holds, nowMs, and workActive. A home whose conversation
// record cannot be read captures nothing, so every message there is recorded
// by hand: while those land recently that is the normal state, not a warning.
// Only a silent stretch with work underway doubts the list.
const HAND_RECENT_MS = 24 * 3600 * 1000;

// The newest message's time in ms, or null when no row carries one.
function newestMessageMs(rows) {
  let newest = null;
  for (const m of rows || []) {
    const t = Date.parse(m && m.at);
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
  }
  return newest;
}

function handRecent(ctx) {
  return !!ctx && typeof ctx.newestAt === 'number' && typeof ctx.nowMs === 'number'
    && ctx.nowMs - ctx.newestAt <= HAND_RECENT_MS;
}

// The muted line for the hand-recorded state (the page's footer, never the top).
function handRecordedNote(capture, ctx) {
  if (capture && capture.present !== false && capture.active === false && handRecent(ctx))
    return 'Messages are being recorded by hand; automatic capture is off until firstmate is next started.';
  return null;
}

function captureBand(capture, ctx) {
  if (!capture || capture.present === false)
    return 'Automatic capture of what firstmate says has not reported yet'
      + (capture && capture.run_error ? ' (' + capture.run_error + ')' : '')
      + ' - this list may be incomplete.';
  if (capture.ok === false)
    return 'Automatic capture of what firstmate says is failing'
      + (capture.error ? ': ' + capture.error : '') + ' - this list may be incomplete.';
  if (capture.active === false) {
    if (handRecent(ctx) || !(ctx && ctx.workActive)) return null;
    return 'Firstmate has been working but nothing has been recorded here for a long while, '
      + 'and no conversation record is being captured, so messages may be missing. '
      + 'Start firstmate again from its own session so automatic capture can read it.';
  }
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
                                r.detail || '', r.received ? '1' : '0',
                                r.deleted ? '1' : '0']
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

// Two records are one message when a hand-filed record and an automatic capture
// of the same turn both hold it (his report 2026-10-06: one message, two ids, so
// his reply and the archive landed on different copies). Same session and
// request id when both carry them; otherwise no conflicting task or project,
// within two minutes, and one text inside the other or near-identical.
const normText = t => String(t || '').replace(/\s+/g, ' ').trim().toLowerCase();
function sameTurn(a, b) {
  if (!a || !b || a.id === b.id) return false;
  if (a.session && b.session && a.req && b.req) return a.session === b.session && a.req === b.req;
  if (a.task && b.task && a.task !== b.task) return false;
  if (a.project && b.project && a.project !== b.project) return false;
  const gap = Math.abs(Date.parse(a.at || '') - Date.parse(b.at || ''));
  if (!(gap <= 120000)) return false;
  const na = normText(a.text), nb = normText(b.text);
  const [short, long] = na.length <= nb.length ? [na, nb] : [nb, na];
  if (short.length < 40) return false;
  return long.includes(short) || (short.slice(0, 300) === long.slice(0, 300) && short.length >= 0.9 * long.length);
}
// One row per message: the hand-filed record is the survivor, and it carries the
// other copy's id (twins), its reply thread (repliesTo) and the later of the two
// archive/hold states and their times, so either copy's actions act on the row.
function foldTwins(rows) {
  const list = (rows || []).map(m => Object.assign({}, m));
  const gone = new Set();
  for (const a of list) {
    if (gone.has(a.id)) continue;
    for (const b of list) {
      if (b === a || gone.has(b.id) || gone.has(a.id) || !sameTurn(a, b)) continue;
      const keep = b.source === 'transcript' ? a : (a.source === 'transcript' ? b : a);
      const lose = keep === a ? b : a;
      keep.twins = (keep.twins || []).concat([lose.id], lose.twins || []);
      keep.archived = !!(keep.archived || lose.archived);
      keep.held = !!(keep.held || lose.held);
      keep.archived_at = keep.archived_at || lose.archived_at || null;
      keep.held_at = keep.held_at || lose.held_at || null;
      gone.add(lose.id);
      if (keep !== a) break;
    }
  }
  return list.filter(m => !gone.has(m.id));
}

// The identity the server uses too (item_key in bin/command-center.py).
function itemKey(it) {
  return [it.home, it.source, it.id, it.key || ''].join('/');
}

// What he wrote ON an item, newest first as said.jsonl is served. A reply he
// typed on a message can carry that item's key too (the answer route, for the
// send lock), but it was written on the message and is shown only there - his
// report 2026-10-05: "the above answer i gave against some other ticket why
// the fuck it is coming against this?".
const saidOnItem = (said, key) => (said || []).filter(r => !r.msg && r.item_key === key);

// --- how long ago, from absolute instants only ----------------------------------
// Every age is now minus a recorded instant, worded as minutes, hours or days.
// A hold's "(since YYYY-MM-DD)" is a date and never an instant: the server
// replaces it with a real one (hold_clock, command-center.py), so no card is
// ever aged from midnight or worded as "today".
function ageWords(sinceEpoch, nowSecs) {
  if (!sinceEpoch) return 'no recorded time';
  const s = Math.max(0, nowSecs - sinceEpoch);
  if (s < 3600) return Math.max(1, Math.round(s / 60)) + 'm';
  if (s < 172800) return Math.round(s / 3600) + 'h';
  const d = Math.round(s / 86400);
  return d < 14 ? d + 'd' : Math.round(d / 7) + 'w';
}

// --- project · worktree · branch, on every card ---------------------------------
// His standing rule, restated 2026-10-05 ("where is the fucking worktree and
// branch?"): all three, always, in this order. One the record cannot name is
// said as "… not recorded" and flagged `missing`, so the page can style it as
// a warning and count it - never blank, never dropped.
const shortPath = p => String(p || '').replace(/^\/home\/[^/]+(?=\/|$)/, '~');
function cardLabels(r) {
  return ['project', 'worktree', 'branch'].map(key => {
    const value = knownValue((r || {})[key]);
    return { key, missing: !value,
             text: !value ? key + ' not recorded' : key === 'worktree' ? shortPath(value) : value };
  });
}
const lacksWorkLabel = r => cardLabels(r).some(l => l.missing && l.key !== 'project');

// --- the dot beside each thing he sent ------------------------------------------
// The dot itself is unchanged (white ring, yellow, red - his own design); this
// only decides WHICH it is, from the record. His report 2026-10-05: "if message
// is delivred it has to trun yellow it just remains white". It used to turn
// yellow only once firstmate had READ the note (the file moved to
// state/inbox/handled/), so a note already delivered to firstmate's inbox sat
// white for as long as firstmate took to read it - and for ever on a send from
// before note ids were recorded. Delivered is now yellow; read stays yellow.
//   going     white   the send has not answered yet, or nothing recorded what
//                     became of it
//   delivered yellow  said.jsonl's outcome is `sent`: it is in firstmate's inbox
//   read      yellow  firstmate acknowledged it (`received`)
//   failed    red     the send is known to have failed
const SEND_DOT_WORDS = {
  going: 'Going out — not yet confirmed delivered',
  delivered: 'Delivered to firstmate’s inbox — not read yet',
  read: 'Received by firstmate',
  failed: 'Delivery failed',
};
function sendDot(row, pending) {
  if (!row || !row.sid) return null;               // a draft was never sent
  const s = sendState(row, pending);
  if (s === 'sent') {
    if (row.received) return { state: 'read', title: SEND_DOT_WORDS.read };
    return { state: 'delivered', title: row.note_id ? SEND_DOT_WORDS.delivered
      : 'Delivered to firstmate’s inbox — sent before read receipts were recorded' };
  }
  if (s === 'failed') return { state: 'failed', title: SEND_DOT_WORDS.failed };
  return { state: 'going', title: s === 'sending' ? SEND_DOT_WORDS.going
    : 'Nothing recorded what became of this send — it may or may not have arrived' };
}

// --- Work: every piece of work asked for, one row each, one project each ----
// His ask 2026-10-05: "put all the separate projects separately". Rows come
// from /api/work's items (the backlog joined with task meta, server-side);
// this only words a row's state and lays the rows out. A row with no project
// recorded groups under '' - shown as "Project unknown", never under another
// row's project.
const WORK_STATES = ['waiting', 'building', 'queued', 'done'];
const WORK_STATE_WORDS = { waiting: 'Waiting on you', building: 'Being built now',
                           queued: 'Not started', done: 'Done' };
function workStateLabel(r, today){
  if (r.state === 'done'){
    const days = r.done_on ? Math.round((Date.parse(today) - Date.parse(r.done_on)) / 86400000) : NaN;
    return days === 0 ? 'Done today' : days === 1 ? 'Done yesterday'
      : r.done_on ? 'Done ' + r.done_on : 'Done';
  }
  const waits = (r.waits_on || []).map(w => w.title || w.id).join('; ');
  const more = waits ? 'waits on ' + waits : (r.detail || '');
  return (WORK_STATE_WORDS[r.state] || r.state || 'State not recorded') + (more ? ' — ' + more : '');
}
// [{key, name, rows, done}] - by project (rows ordered by state), or by state
// (rows ordered by project). Finished rows are always kept apart in `done`, so
// the page can fold them away; by state they are the last group's.
function workGroups(items, sort){
  const project = r => knownValue(r.project) || '';
  const rank = r => { const i = WORK_STATES.indexOf(r.state); return i < 0 ? WORK_STATES.length : i; };
  const byProject = (a, b) => (!project(a) - !project(b)) || project(a).localeCompare(project(b));
  const rows = (items || []).slice();
  if (sort === 'state'){
    rows.sort((a, b) => byProject(a, b) || String(a.id).localeCompare(String(b.id)));
    const live = WORK_STATES.filter(s => s !== 'done').map(s => ({ key: s,
      name: WORK_STATE_WORDS[s], rows: rows.filter(r => r.state === s), done: [] }));
    const other = rows.filter(r => !WORK_STATES.includes(r.state));
    if (other.length) live.push({ key: 'other', name: 'State not recorded', rows: other, done: [] });
    return live.filter(g => g.rows.length).concat(
      [{ key: 'done', name: 'Done', rows: [], done: rows.filter(r => r.state === 'done') }]
        .filter(g => g.done.length));
  }
  rows.sort((a, b) => byProject(a, b) || rank(a) - rank(b)
    || String(b.done_on || '').localeCompare(String(a.done_on || ''))
    || String(a.id).localeCompare(String(b.id)));
  const groups = [];
  for (const r of rows){
    let g = groups[groups.length - 1];
    if (!g || g.key !== project(r))
      groups.push(g = { key: project(r), name: project(r) || 'Project unknown', rows: [], done: [] });
    (r.state === 'done' ? g.done : g.rows).push(r);
  }
  return groups;
}

if (typeof module === 'object' && module.exports)
  module.exports = { knownValue, pollFacts, tense, transportFailure, verdictFor,
                     releaseVerdicts, itemKey, shapeMessage, orderRows, archivedEpoch, sameTurn, foldTwins,
                     stableGroupOrder, looksLikeQuestion, messageNeedsReply,
                     replyTarget, foldSaid, wordsAfter,
                     listSignature, mayRelease, logRead,
                     sendState, sendKeys, sameWords,
                     heldWith, captureBand, handRecordedNote, newestMessageMs, saidDigest, mergeMessages,
                     isItemDeferred, inMessagesTab, onHisBoard,
                     waitingItems, waitingMessageRows, waitingCount,
                     namesPr, mergeAskOnly, prAsks, markRepeats,
                     looksLikeInfoOnly, declaresNothingForHim, asksHim, isInfoOnlyMessage, sortedTab,
                     saidTaskId, matchAnswer, threadRows, threadStatus,
                     recordedAnswers, answeredSend, answerFor, foldAnswers, noteThreads,
                     noteMomentAnswer, NOTE_MOMENT_MINUTES,
                     workGroups, workStateLabel, WORK_STATE_WORDS, saidOnItem,
                     sendDot, SEND_DOT_WORDS,
                     ageWords, shortPath, cardLabels, lacksWorkLabel };
