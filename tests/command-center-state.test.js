// Behavioral regressions for the command center's decision rules. These execute
// web/command-center-state.js itself - the same file the page loads - so what is
// asserted is the rule, not a restatement of it. No DOM is involved: every one
// of these is a pure function of state.
'use strict';
const assert = require('assert');
const path = require('path');
const {
  pollFacts, tense, transportFailure, verdictFor, releaseVerdicts, itemKey,
  shapeMessage, orderRows, archivedEpoch, stableGroupOrder, looksLikeQuestion, messageNeedsReply,
  replyTarget, foldSaid, wordsAfter,
  listSignature, mayRelease, logRead, sendState, sendKeys, sameWords,
  heldWith, captureBand, saidDigest, mergeMessages,
  waitingCount,
  isInfoOnlyMessage, saidTaskId, matchAnswer, threadRows, threadStatus,
  recordedAnswers, answeredSend, noteThreads,
} = require(path.join(__dirname, '..', 'web', 'command-center-state.js'));

// Quiet on success: tests/command-center.test.sh runs this and reports the
// count, so only failures need to speak.
let failures = 0, ran = 0;
function test(name, fn) {
  ran++;
  try {
    fn();
  } catch (err) {
    failures++;
    console.error('not ok - ' + name + '\n  ' + (err && err.message));
  }
}
process.on('exit', () => { if (!failures) console.log(ran); });

const NOW = 1_800_000_000;

// --- what a poll's answer means -------------------------------------------------

// A request merely being open is not an answer: a confirmed view stays confirmed
// until a resolved one says otherwise, and there is no answer kind for "open".
test('an in-flight poll cannot unconfirm a confirmed view', () => {
  const live = { confirmed: true, readAt: NOW - 5, connected: true };
  assert.deepStrictEqual(tense(live, NOW), { past: false, readAt: NOW });
  assert.throws(() => pollFacts({ kind: 'inflight' }, NOW), /unknown poll answer/,
    'a request being open decides nothing, so it is not an answer this accepts');
});

// A 304 IS a successful read: it proves the server is reachable and confirms the
// view on screen, so it must clear EVERY reachability alarm, not a subset.
test('a resolved 304 clears every reachability alarm', () => {
  const facts = pollFacts({ kind: 'unchanged' }, NOW);
  assert.strictEqual(facts.connected, true);
  assert.strictEqual(facts.offline, null);
  assert.strictEqual(facts.unread, null);
  assert.strictEqual(facts.error, null);
  assert.strictEqual(facts.confirmed, true);
  assert.strictEqual(facts.readAt, NOW);
});

// The server answered, so it is reachable - but no scan has ever published, so
// there is no list and it refuses sends too. This must not read as a list that
// can still be answered.
test('a never-scanned answer is reachable, unconfirmed and not an error', () => {
  const facts = pollFacts({ kind: 'unread', detail: 'not read yet' }, NOW);
  assert.strictEqual(facts.connected, true, 'the server did answer');
  assert.strictEqual(facts.offline, null, 'so no cannot-reach alarm may stand');
  assert.strictEqual(facts.unread, 'not read yet');
  assert.strictEqual(facts.error, null, 'not the failed-scan state');
  assert.strictEqual(facts.confirmed, false);
  assert.strictEqual('readAt' in facts, false, 'nothing was read');
});

// A body that carries an error is still a resolved READ. What is stale is the
// content, which `confirmed` carries on its own.
test('a failed scan over a published list still records a read time', () => {
  const facts = pollFacts({ kind: 'body', error: 'scan failed' }, NOW);
  assert.strictEqual(facts.confirmed, false);
  assert.strictEqual(facts.readAt, NOW);
  assert.strictEqual(facts.error, 'scan failed');
  assert.strictEqual(facts.connected, true);
  assert.strictEqual(facts.unread, null);
});

test('an unreachable answer forbids nothing but confirmation', () => {
  const facts = pollFacts({ kind: 'unreachable', detail: 'Failed to fetch' }, NOW);
  assert.strictEqual(facts.connected, false);
  assert.strictEqual(facts.offline, 'Failed to fetch');
  assert.strictEqual(facts.confirmed, false);
  assert.strictEqual('readAt' in facts, false, 'nothing was read');
});

// --- may a band speak in the present? --------------------------------------------

test('an unconfirmed view speaks in the past, from the last read', () => {
  const read = NOW - 600;
  assert.deepStrictEqual(
    tense({ confirmed: false, readAt: read }, NOW), { past: true, readAt: read });
});

// The view's own `generated` is when the records last CHANGED. A dead watcher
// freezes it, so a read time must never come from it - reading it as one turns
// the watcher's death into "heard moments ago".
test('a read time is never derived from unchanged content', () => {
  const lastBeat = NOW - 3600;
  const state = { confirmed: false, readAt: NOW - 3,
                  view: { generated: new Date(lastBeat * 1000).toISOString() } };
  const { readAt } = tense(state, NOW);
  assert.strictEqual(readAt, NOW - 3, 'the last READ, not the last change');
  assert.ok(readAt - lastBeat > 300,
    'a watcher silent for an hour must still classify as stale');
});

// --- what a dropped send means, per route -----------------------------------------

// Every Waiting-on-you answer and every note now goes only to firstmate's
// captain inbox - a local record write with no worker-facing delivery plane -
// so a resend is never a second steer landing on a worker, and nothing here
// ever locks against it, on any source.
test('a dropped send is always a plain failure, never a locking outcome', () => {
  for (const source of ['hold', 'status'])
    for (const detail of ['Failed to fetch', ''])
      assert.deepStrictEqual(transportFailure(source, detail), { error: detail });
});

test('no outcome on any route ever locks a resend', () => {
  for (const source of ['hold', 'status'])
    for (const outcome of ['unknown', 'failed', 'sent', undefined])
      assert.strictEqual(verdictFor(source, outcome, 'why', 0), null,
        'no outcome may lock any route: ' + source + '/' + outcome);
});

// --- when a verdict ends ----------------------------------------------------------

const item = (over) => Object.assign(
  { home: 'main', source: 'status', id: 't-1', key: 'k', sent: [] }, over);

test('a verdict is released when the steering record it doubted appears', () => {
  const it = item();
  const verdicts = { [itemKey(it)]: { outcome: 'unknown', detail: '', sent: 0 } };
  const arrived = item({ sent: [{ seq: '001' }] });
  assert.deepStrictEqual(
    releaseVerdicts(verdicts, { items: [arrived] }), {},
    'the record proves the steer landed');
  assert.deepStrictEqual(
    releaseVerdicts(verdicts, { items: [it] }), verdicts,
    'with no new record there is no evidence, so the verdict stands');
});

test('a verdict is released when its item leaves the list', () => {
  const it = item();
  const verdicts = { [itemKey(it)]: { outcome: 'unknown', detail: '', sent: 0 } };
  assert.deepStrictEqual(releaseVerdicts(verdicts, { items: [] }), {});
});

// A view the scan did not publish knows no items, so it is not evidence that
// anything is gone - releasing against it would drop the do-not-resend guard.
test('a verdict survives a view that proves nothing', () => {
  const it = item();
  const verdicts = { [itemKey(it)]: { outcome: 'unknown', detail: '', sent: 0 } };
  assert.deepStrictEqual(
    releaseVerdicts(verdicts, { error: 'scan failed', items: [] }), verdicts);
  assert.deepStrictEqual(releaseVerdicts(verdicts, {}), verdicts);
});

// A task can be captain-held AND stopped on its own status record at once, and
// the two are answered by different commands.
test('an item is identified by its record as well as its task', () => {
  assert.notStrictEqual(
    itemKey(item({ source: 'hold', key: 't-1' })),
    itemKey(item({ source: 'status', key: 'k' })));
});

// --- the two lists are in different orders, and both are deliberate -----------
const msg = (id, at, over) => shapeMessage(Object.assign({ id, at }, over));
const M = [
  msg('m1', '2026-09-01T10:00:00Z'),
  msg('m2', '2026-09-02T10:00:00Z'),
  msg('m3', '2026-09-03T10:00:00Z'),
];
const ids = rows => rows.map(r => r.id).join(',');

test('a message is given the time and branch fields a row is grouped by', () => {
  const m = shapeMessage({ id: 'm', at: '2026-09-01T10:00:00Z', branch: 'fm/x' });
  assert.strictEqual(m.since_epoch, Math.floor(Date.parse('2026-09-01T10:00:00Z') / 1000));
  assert.strictEqual(m.branch_state, 'branch');
  assert.strictEqual(shapeMessage({ id: 'm', at: '' }).since_epoch, null,
    'a record with no usable time must not be given one');
  assert.strictEqual(shapeMessage({ id: 'm', at: '' }).branch_state, 'not-started');
});

// He opens the page to see the LAST thing firstmate said, while the waiting
// queue leads with what has waited longest. One rule, two defaults.
test('messages default to newest first and the waiting queue to oldest first', () => {
  assert.strictEqual(ids(orderRows(M, 'project', true)), 'm3,m2,m1');
  assert.strictEqual(ids(orderRows(M, 'project', false)), 'm1,m2,m3');
});

test('Latest and Oldest override both defaults', () => {
  assert.strictEqual(ids(orderRows(M, 'oldest', true)), 'm1,m2,m3');
  assert.strictEqual(ids(orderRows(M, 'latest', false)), 'm3,m2,m1');
});

test('the flat list claims no order at all', () => {
  assert.strictEqual(ids(orderRows(M, 'none', true)), 'm1,m2,m3');
});

test('a row with no usable time is never given a position among the dated', () => {
  const rows = [msg('m1', '2026-09-01T10:00:00Z'), msg('mx', ''),
                msg('m2', '2026-09-02T10:00:00Z')];
  assert.strictEqual(ids(orderRows(rows, 'project', true)), 'm2,m1,mx');
  assert.strictEqual(ids(orderRows(rows, 'oldest', true)), 'm1,m2,mx');
});

// His report 2026-09-28: Archived puts the latest ARCHIVED row on top, not the
// latest sent - archived_at when there is one, the row's own time otherwise.
test('Archived orders by when a row was archived, falling back to its own time', () => {
  const rows = [
    Object.assign(msg('m1', '2026-09-01T10:00:00Z'), { archived_at: '2026-09-10T00:00:00Z' }),
    Object.assign(msg('m2', '2026-09-03T10:00:00Z'), { archived_at: '2026-09-05T00:00:00Z' }),
    msg('m3', '2026-09-07T10:00:00Z'),
  ];
  assert.strictEqual(ids(orderRows(rows, 'project', true, archivedEpoch)), 'm1,m3,m2');
  assert.strictEqual(ids(orderRows(rows, 'oldest', true, archivedEpoch)), 'm2,m3,m1');
  assert.strictEqual(ids(orderRows(rows, 'project', true)), 'm3,m2,m1',
    'any other list still orders by the row\'s own time');
});

// His report 2026-09-24: a Group by list re-sorted itself under him while he
// was reading, so the project he was in dropped down the page and another
// took its place. That happened because the old bucket order was built fresh
// from a time-sorted list every poll; stableGroupOrder instead follows the
// chosen key once (project name, then worktree/branch) and only ever adds a
// brand-new key at the end.
const info = { alpha:{g1:'alpha'}, bravo:{g1:'bravo'}, charlie:{g1:'charlie'} };
const infoOf = k => info[k];

test('a fresh Group by view orders its buckets by key, not by time', () => {
  assert.deepStrictEqual(
    stableGroupOrder([], ['charlie', 'alpha', 'bravo'], infoOf),
    ['alpha', 'bravo', 'charlie']);
});

test('a new message landing on an existing bucket does not move it', () => {
  // bravo was open and reading; alpha then gets a new, newer message, which
  // the old code let jump alpha's bucket above bravo's.
  const established = stableGroupOrder([], ['alpha', 'bravo', 'charlie'], infoOf);
  const afterPoll = stableGroupOrder(established, ['alpha', 'bravo', 'charlie'], infoOf);
  assert.deepStrictEqual(afterPoll, established,
    'the group order changed on a poll that added no new group');
});

test('a brand-new bucket is appended, never inserted above the one he is in', () => {
  const established = stableGroupOrder([], ['bravo', 'charlie'], infoOf);
  // "alpha" would sort first alphabetically, but it is new this poll and must
  // land at the end, not above bravo.
  const afterPoll = stableGroupOrder(established, ['bravo', 'charlie', 'alpha'], infoOf);
  assert.deepStrictEqual(afterPoll, ['bravo', 'charlie', 'alpha']);
});

test('a bucket that has emptied out drops from the order without disturbing the rest', () => {
  const established = stableGroupOrder([], ['alpha', 'bravo', 'charlie'], infoOf);
  const afterPoll = stableGroupOrder(established, ['alpha', 'charlie'], infoOf);
  assert.deepStrictEqual(afterPoll, ['alpha', 'charlie']);
});

// A reply's verdict is not an item's to release: the message log is append-only,
// so a scan of the work records is no evidence that his reply did not land.
test('a scan never re-offers a reply whose delivery was unconfirmed', () => {
  const verdicts = { 'msg/m1': { outcome: 'unknown', detail: 'x', sent: 0 } };
  const kept = releaseVerdicts(verdicts, { items: [] });
  assert.deepStrictEqual(kept, verdicts,
    'a message verdict was released by a scan that knows nothing about it');
});

// --- where a reply is about to go ---------------------------------------------
// A task collects several messages over its life, so only the message the
// recorder marked as a question may be answered, and only against the decision
// it named. Everything else is a note.
const hold = { home: 'main', id: 't1', source: 'hold', key: '', title: 'Blue or green?' };
const stopped = { home: 'main', id: 't1', source: 'status', key: 'k1', title: 'Which shape?' };

test('a reply to a question answers that question and nothing else', () => {
  assert.deepStrictEqual(
    replyTarget({ question: true, task: 't1' }, [hold]),
    { kind: 'answer', item: hold });
  assert.deepStrictEqual(
    replyTarget({ question: true, task: 't1', question_key: 'k1' }, [stopped, hold]),
    { kind: 'answer', item: stopped });
});

test('a reply to a message that is not a question is a note', () => {
  assert.strictEqual(replyTarget({ task: 't1' }, [hold]).kind, 'note',
    'a message nobody recorded as a question was made answerable');
  assert.strictEqual(replyTarget({ question: true, task: 't1', question_key: 'other' },
                                 [stopped]).kind, 'note',
    'a question was answered against a decision it never named');
  assert.strictEqual(replyTarget({ question: true, task: 't1' }, []).kind, 'note',
    'a settled question still claimed the answer route');
});

test('a question is never answered against another home', () => {
  assert.strictEqual(
    replyTarget({ question: true, task: 't1' },
                [Object.assign({}, hold, { home: 'mate' })]).kind, 'note');
});

// --- does a captured message need him to decide something? ----------------------
// His report 2026-09-24: "I see many messages in the Messages group that need
// my input but are not in the Waiting on You group." A message counts as
// waiting when it was recorded as a question, or when its own words plainly
// ask him to decide, and stops counting once he has replied to it.
test('a literal question is recognised even when it was not flagged as one', () => {
  assert.strictEqual(looksLikeQuestion('Should I merge this now?'), true);
  assert.strictEqual(looksLikeQuestion('Here is the status update.'), false);
  assert.strictEqual(looksLikeQuestion(''), false);
});

test('the same handful of phrases firstmate uses to hand him a decision are recognised', () => {
  assert.strictEqual(looksLikeQuestion('Reply 1 or 2 to pick a direction'), true);
  assert.strictEqual(looksLikeQuestion('Say the word and I will ship it'), true);
  assert.strictEqual(looksLikeQuestion('Your call on which branch to keep'), true);
  assert.strictEqual(looksLikeQuestion('Waiting on your go-ahead'), true);
});

test('a message needs a reply when recorded as a question or plainly asking one, until he replies', () => {
  const flagged = { id: 'm1', question: true, text: 'status update, nothing to decide' };
  const worded = { id: 'm2', question: false, text: 'Can I merge this branch?' };
  const plain = { id: 'm3', question: false, text: 'Deployed to staging.' };
  assert.strictEqual(messageNeedsReply(flagged, []), true);
  assert.strictEqual(messageNeedsReply(worded, []), true);
  assert.strictEqual(messageNeedsReply(plain, []), false);
  assert.strictEqual(messageNeedsReply(flagged, [{ msg: 'm1' }]), false,
    'a message he already replied to is no longer waiting on him');
  assert.strictEqual(messageNeedsReply(worded, [{ msg: 'm9' }]), true,
    'a reply to a different message must not settle this one');
});

// His report 2026-09-24: "an item must never leave Waiting on you because his
// reply was a QUESTION. Only a reply that decides ... removes it." saidRows is
// newest first, so the first row naming a message is his latest reply to it.
test('a reply that only asks firstmate something back never settles a waiting message', () => {
  const flagged = { id: 'm1', question: true, text: 'Merge feature/x into develop?' };
  assert.strictEqual(messageNeedsReply(flagged, [{ msg: 'm1', text: 'What do you mean by merge here?' }]),
    true, 'a clarifying reply must not clear Waiting on you');
  assert.strictEqual(messageNeedsReply(flagged, [{ msg: 'm1', text: 'Why?' }]),
    true, 'a bare question mark reply must not clear Waiting on you either');
  assert.strictEqual(messageNeedsReply(flagged, [{ msg: 'm1', text: 'Yes, merge it.' }]),
    false, 'a decisive reply clears Waiting on you as before');
  // Newest first: his second, decisive reply supersedes his first, clarifying one.
  assert.strictEqual(messageNeedsReply(flagged, [
    { msg: 'm1', text: 'Yes, merge it.' },
    { msg: 'm1', text: 'Which branch do you mean?' },
  ]), false, 'the latest reply is what decides, not an earlier clarifying one');
});

// A scanned captain-hold item has no other tab to fall back into the way a
// message falls back to Messages, so unlike messageNeedsReply, answering it -
// even decisively - must never remove it: only Archive or Hold does
// (AGENTS.md). waitingCount must also never move from opening a row or typing
// into it, since it is pure over items/messages/said alone.
test('opening a row or typing into it cannot move the Waiting on you count', () => {
  const items = [
    { home: 'main', source: 'hold', id: 'a', key: '', archived: false, held: false, deferred_until: null },
    { home: 'main', source: 'hold', id: 'b', key: '', archived: false, held: false, deferred_until: null },
  ];
  const messages = [];
  const said = [];
  const now = 1_800_000_000;
  const first = waitingCount(items, messages, said, now);
  const second = waitingCount(items, messages, said, now);   // simulates a second, unrelated poll
  assert.strictEqual(first, 2);
  assert.strictEqual(second, 2, 'polling again with nothing changed must not move the count');
  // An item stays counted even once he has answered it - only Archive/Hold removes it.
  const said2 = [{ item_key: itemKey(items[0]), text: 'Green. Blue reads as disabled.' }];
  assert.strictEqual(waitingCount(items, messages, said2, now), 2,
    'answering an item must not drop it from Waiting on you; only Archive/Hold does');
  // Archiving is the only thing that removes it.
  const archived = [Object.assign({}, items[0], { archived: true }), items[1]];
  assert.strictEqual(waitingCount(archived, messages, said, now), 1);
});

// His ask 2026-09-24: "add one more info tab so from messages split into two
// all the messages like nothing new, we are progressing etc. etc." - pure
// progress/no-change chatter is Info; anything reporting a real outcome, a
// landed change, a decision or a problem stays in Messages, and a message that
// plainly asks him something is never info-only.
test('pure status chatter is info-only; anything with a decision or an outcome is not', () => {
  assert.strictEqual(isInfoOnlyMessage({ text: 'Nothing new for the captain.' }), true);
  assert.strictEqual(isInfoOnlyMessage({ text: "That's metals 08, paused for Codex quota. Nothing new for the captain." }), true);
  assert.strictEqual(isInfoOnlyMessage({ text: 'Still running.' }), true);
  assert.strictEqual(isInfoOnlyMessage({ text: 'Ack.' }), true);
  assert.strictEqual(isInfoOnlyMessage({ text: 'The metal chain is finished and verified end to end. Ready for your merge.' }), false,
    'a landed outcome must stay in Messages even without a question in it');
  assert.strictEqual(isInfoOnlyMessage({ text: 'Reply 1 or 2. Nothing merges until you decide.' }), false,
    'a decision ask must never be swallowed by Info, whatever else it says');
  assert.strictEqual(isInfoOnlyMessage({ question: true, text: 'Nothing new for the captain.' }), false,
    'a message the recorder marked as a question is never info-only');
  assert.strictEqual(isInfoOnlyMessage({ text: 'The build failed on the integration branch.' }), false,
    'a failure stays in Messages');
});

// His report 2026-09-28: "why the fuck this is coming in messages instead of
// info?" / "this response to what i said should also come in info." - the
// default turned round: Messages keeps an outcome, a failure or an ask, and
// everything else, including a plain response to him, is Info. Cases below
// are real lines from the log.
test('acks, "on it" and plain responses are Info; outcomes, failures and asks stay in Messages', () => {
  const info = [
    'Captain, shipshape. The duplicate-question fix is built and is now going through its checks; it lands without troubling you.',
    'Captain, understood on both counts. Encryption at rest: off. Four now waiting on your word.',
    'Captain, on it — the gutter icons are dispatched, the names are being recorded.',
    "Captain, you're right, and it changes. Koin will store 12.34 as 12.34. I'll bring the stack page back for your yes when it's done.",
    'Already handled and deployed. Nothing new for the captain.',
    'Captain, shipshape. Nothing new — the fleet is quiet and waiting on your three calls.',
    'Captain, the investigation is now aimed at the right question: what code the running branch has lost.',
  ];
  const messages = [
    'Captain, the double-tab bug is fixed and live. Refresh the command centre.',
    'Captain, **pasting images into the command centre is live.**',
    'Captain, the duplication audit is in. Your metals chain is clean.',
    'Captain, Koin exists. Project koin, repo talktejas/koin.',
    'Captain, the Koin technical stack is ready for your yes.',
    "Captain, you're right, they're still not working: the links fix was written but never merged.",
    "Captain, pick a name and I'll do the rest. 1. Kofa 2. Pursely",
    'Captain, plan for Koin. Nothing created until you say go.',
    'Captain, is this the right branch?',
  ];
  for (const text of info) assert.strictEqual(isInfoOnlyMessage({ text }), true, 'should be Info: ' + text);
  for (const text of messages) assert.strictEqual(isInfoOnlyMessage({ text }), false, 'should be Messages: ' + text);
  assert.strictEqual(isInfoOnlyMessage({ text: 'Captain, a worker is now looking into it.' }), true,
    'a message no rule places defaults to Info');
  const long = 'Captain, I checked it. ' + 'Here is the reasoning. '.repeat(12) + 'Everything merged into develop last week.';
  assert.strictEqual(isInfoOnlyMessage({ text: long }), true,
    'only the lead is read for news, so a word deep in the reasoning is not mistaken for it');
});

// --- two rows, one send --------------------------------------------------------
// The record carries his words the moment the click is accepted and again when
// the command answers. The list must show the outcome, not the acceptance.
test('the outcome of a send supersedes its acceptance', () => {
  const rows = [
    { sid: 'a', outcome: 'sent', text: 'go blue' },
    { sid: 'a', outcome: 'sending', text: 'go blue' },
    { sid: 'b', outcome: 'sending', text: 'merge it' },
    { kind: 'note', text: 'an older row with no sid' },
  ];
  assert.deepStrictEqual(foldSaid(rows).map(r => r.outcome || r.kind),
    ['sent', 'sending', 'note']);
  assert.deepStrictEqual(foldSaid(undefined), [],
    'a record that could not be read must fold to nothing, not throw');
});

// --- what an arrived outcome does to his words ---------------------------------
// The promise is that nothing he typed is cleared by a send that did not land,
// and the click is accepted before the command runs, so only the outcome row
// may empty the box.
// THE WORST THING THIS PAGE COULD DO IS DELETE WHAT HE TYPED. The box keeps his
// text after the click, so an outcome landing later may find something he has
// typed since: a next thought, or a retyped resend. It may act only on the
// words it is about.
test('an outcome never touches words he typed after the send', () => {
  const landed = { sid: 'a', outcome: 'sent' };
  assert.strictEqual(wordsAfter(landed, 'go blue', 'go blue'), 'clear');
  assert.strictEqual(wordsAfter(landed, 'go blue. Also, ship Friday.', 'go blue'),
    'leave', 'a delivered send must not empty a box holding newer words');
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'failed' },
                                'something else entirely', 'go blue'),
    'leave', 'a failed send must not overwrite newer words with the old copy');
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'failed' },
                                'go blue', 'go blue'), 'restore');
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'sending' },
                                'go blue', 'go blue'), null);
});

// --- the same words, typed by a person -----------------------------------------
// A send stores what was sent, trimmed; the box stores what he typed. Ending a
// paragraph with Enter or pasting text with a trailing newline is ordinary, and
// it must not make the two look like different thoughts: that would leave every
// arrived outcome unable to act on the send it is about, so a delivered send
// would sit in the box with Send live over it.
test('a trailing newline is the same words', () => {
  assert.strictEqual(sameWords('Go blue.\n', 'Go blue.'), true);
  assert.strictEqual(sameWords('  Go blue. ', 'Go blue.'), true);
  assert.strictEqual(sameWords('Go blue. Also, ship Friday.', 'Go blue.'), false);
  assert.strictEqual(sameWords('   ', ''), true,
    'a box holding only whitespace holds nothing he typed');
  assert.strictEqual(sameWords(undefined, ''), true);

  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'sent' }, 'Go blue.\n', 'Go blue.'),
    'clear', 'a delivered send must still be able to empty the box he typed in');
});

// --- one decision to send again ------------------------------------------------
// A reply that took the answer route is locked on the message he typed it in
// and on the item it steered, so releasing it from one surface has to release
// it from the other: dismissing the same send twice is the split this closes.
test('a send is released on every surface it was held against', () => {
  const rows = [{ sid: 'a', msg: 'm1', item_key: 'main/status/t1/k' },
                { sid: 'b', item_key: 'main/hold/t9/t9' }];
  assert.deepStrictEqual(heldWith('msg/m1', rows, {}).sort(),
    ['main/status/t1/k', 'msg/m1']);
  assert.deepStrictEqual(heldWith('main/status/t1/k', rows, {}).sort(),
    ['main/status/t1/k', 'msg/m1'],
    'the item he answered from releases the message too');
  assert.deepStrictEqual(heldWith('main/hold/t9/t9', rows, {}),
    ['main/hold/t9/t9'], 'an answer sent from the item has one surface');
  assert.deepStrictEqual(
    heldWith('msg/m2', [], { s: { key: 'msg/m2', item: 'main/hold/t2/t2' } }).sort(),
    ['main/hold/t2/t2', 'msg/m2'],
    'a send still recorded as pending names its surfaces too');
  assert.deepStrictEqual(heldWith('msg/zz', rows, {}), ['msg/zz'],
    'a surface no send touched releases only itself');
});

// --- may the message list claim to be complete? -----------------------------------
// The one promise the capture makes: when it cannot be shown healthy, the list
// says it may be incomplete rather than quietly looking short.

test('a healthy fresh capture lets the list speak for itself', () => {
  assert.strictEqual(captureBand(
    { present: true, ok: true, active: true, age_secs: 12, run_error: null, named: 1 }), null);
});

test('a capture that never reported cannot be silent', () => {
  assert.match(captureBand(null), /may be incomplete/);
  assert.match(captureBand({ present: false }), /may be incomplete/);
  assert.match(captureBand({ present: false, run_error: 'no python' }), /no python/);
});

test('a failing capture names its failure and doubts the list', () => {
  const band = captureBand({ present: true, ok: false, error: 'disk full' });
  assert.match(band, /disk full/);
  assert.match(band, /may be incomplete/);
});

// The one outcome this page must never produce: a green band over a list that
// is missing a session nothing was looking for.
test('a capture no session has confirmed the location of doubts the list', () => {
  const band = captureBand({ present: true, ok: true, active: true, age_secs: 5 });
  assert.match(band, /worked out/);
  assert.match(band, /may be incomplete/);
  assert.strictEqual(captureBand(
    { present: true, ok: true, active: true, age_secs: 5, named: 2 }), null,
    'a transcript a session named is exactly what makes the list vouchable');
});

test('a home with no conversation record says only hand-recorded messages appear', () => {
  const band = captureBand({ present: true, ok: true, active: false });
  assert.match(band, /by hand/);
  assert.match(band, /may be incomplete/);
});

// The sweep's record is the truth of the last capture whoever ran it; a fresh
// healthy record outweighs this server's own failed attempt, and a stale one
// does not.
test('staleness doubts the list, and freshness outweighs a server-side run error', () => {
  assert.match(captureBand(
    { present: true, ok: true, active: true, age_secs: 3600, run_error: 'spawn failed', named: 1 }),
    /60 minutes.*spawn failed/);
  assert.strictEqual(captureBand(
    { present: true, ok: true, active: true, age_secs: 30, run_error: 'spawn failed', named: 1 }),
    null);
});

// --- an outcome reaches the screen wherever it lands -------------------------
// Delivery always finishes behind the send, so the said poll re-rendering is the
// only way an outcome is ever shown. A second send while the first is still
// delivering pushes the first record down the list, and its outcome must still
// count as a change.
test('an outcome landing on a record that is not the newest is a change', () => {
  const sending = sid => ({ sid, kind: 'answer', outcome: 'sending' });
  const before = [sending('b'), sending('a')];
  const after = [sending('b'), { sid: 'a', kind: 'answer', outcome: 'sent' }];
  assert.notStrictEqual(saidDigest(before), saidDigest(after),
    'an outcome folded onto an older record left the page showing "being delivered"');
  assert.strictEqual(saidDigest(before), saidDigest([sending('b'), sending('a')]),
    'an unchanged log must not force a re-render');
  assert.notStrictEqual(saidDigest(before), saidDigest(
    [sending('c')].concat(before)), 'a new send is a change');
});

// --- nothing he has been shown falls off the page ------------------------------
// The poll re-reads only the newest window. A message that has since fallen out
// of that window - because turns kept ending - must not vanish from the list,
// and an older page he asked for must survive every poll after it.
test('a message that falls out of the newest window stays on the page', () => {
  const m = id => ({ id });
  const held = [m('m9'), m('m8'), m('m7')];
  assert.deepStrictEqual(
    mergeMessages([m('m11'), m('m10'), m('m9')], held).map(r => r.id),
    ['m11', 'm10', 'm9', 'm8', 'm7'],
    'm8 and m7 left the window and left the page with it');
  assert.deepStrictEqual(mergeMessages(held, held).map(r => r.id),
    ['m9', 'm8', 'm7'], 'an unchanged poll must not duplicate what is held');
});

// If more than a window arrived while the tab was asleep, the two runs share
// nothing and everything between them is missing. A list stitched across that
// hole reads as whole and pages from its oldest row, so the hole never closes;
// the stale run goes instead, and Show older and search still reach it.
test('two runs that do not overlap are never stitched across the gap', () => {
  const m = id => ({ id });
  assert.deepStrictEqual(
    mergeMessages([m('m20'), m('m19')], [m('m9'), m('m8')]).map(r => r.id),
    ['m20', 'm19'],
    'the list kept rows with a hole between them and no way to fill it');
  assert.deepStrictEqual(mergeMessages([], [m('m9')]).map(r => r.id), ['m9'],
    'a poll that answered nothing must not empty the list');
});

// --- threading firstmate's later answer under his reply -------------------
// His report 2026-09-24: "i rec'd no answer for this yet" - firstmate's real
// answer arrived as a brand-new message instead of showing up under his
// reply. These pin the matching rule directly, since a wrong thread is worse
// than none.

test('a later message against the same task, after the reply, threads as the answer', () => {
  const reply = { at: '2026-09-24T10:00:00Z', title: 'Blue or green?', msg: 'm1' };
  const messages = [
    { id: 'm1', task: 'cc-live', at: '2026-09-24T09:00:00Z', title: 'Blue or green?' },
    { id: 'm2', task: 'cc-live', at: '2026-09-24T10:05:00Z', title: 'Shipped blue', text: 'Going with blue.' },
  ];
  assert.strictEqual(saidTaskId(reply, messages), 'cc-live');
  const answer = matchAnswer(reply, 'cc-live', messages, null);
  assert.strictEqual(answer && answer.id, 'm2');
});

// Same task, but sent BEFORE the reply - never his answer, whatever it says.
test('a same-task message sent before the reply never threads', () => {
  const reply = { at: '2026-09-24T10:00:00Z', title: 'Blue or green?' };
  const early = [{ id: 'm0', task: 'cc-live', at: '2026-09-24T08:00:00Z', title: 'unrelated' }];
  assert.strictEqual(matchAnswer(reply, 'cc-live', early, null), null);
});

// Same task, sent after the reply, but past the next reply's own window - it
// belongs to whatever conversation came after, not this one.
test('a same-task message past the next reply is never pulled into this window', () => {
  const reply = { at: '2026-09-24T10:00:00Z' };
  const messages = [{ id: 'm2', task: 'cc-live', at: '2026-09-24T11:00:00Z' }];
  assert.strictEqual(matchAnswer(reply, 'cc-live', messages, '2026-09-24T10:30:00Z'), null);
});

// Rule 2: no task match, but the candidate plainly names the subject he was
// replying about.
test('a message with no task match but that names the subject threads by rule 2', () => {
  const reply = { at: '2026-09-24T10:00:00Z', title: 'Blue or green?' };
  const messages = [{ id: 'm2', task: null, at: '2026-09-24T10:05:00Z',
    title: 'Re: blue or green?', text: 'Went with blue.' }];
  const answer = matchAnswer(reply, null, messages, null);
  assert.strictEqual(answer && answer.id, 'm2');
});

// MUST NOT THREAD: a different task, sent in the same window, that neither
// quotes nor names the subject - an unrelated status ping must never be
// shown as though it answered this reply.
test('an unrelated message on a different task never threads', () => {
  const reply = { at: '2026-09-24T10:00:00Z', title: 'Blue or green?', msg: 'm1' };
  const messages = [
    { id: 'm1', task: 'cc-live', at: '2026-09-24T09:00:00Z', title: 'Blue or green?' },
    { id: 'm2', task: 'other-task', at: '2026-09-24T10:05:00Z',
      title: 'Metrics refresh', text: 'Nightly job finished on schedule.' },
  ];
  assert.strictEqual(matchAnswer(reply, saidTaskId(reply, messages), messages, null), null);
});

// threadRows interleaves reply/answer pairs in order, and never lets the same
// candidate message answer two different replies.
test('threadRows interleaves replies and answers, oldest first, each answer used once', () => {
  const replies = [
    { at: '2026-09-24T10:00:00Z', title: 'Blue or green?', msg: 'm1', text: 'Which is it?' },
    { at: '2026-09-24T10:20:00Z', title: 'Blue or green?', msg: 'm1', text: 'Any update?' },
  ];
  const messages = [
    { id: 'm1', task: 'cc-live', at: '2026-09-24T09:00:00Z', title: 'Blue or green?' },
    { id: 'm2', task: 'cc-live', at: '2026-09-24T10:10:00Z', title: 'Going blue', text: 'Blue it is.' },
    { id: 'm3', task: 'cc-live', at: '2026-09-24T10:30:00Z', title: 'Shipped', text: 'Blue shipped.' },
  ];
  const entries = threadRows(replies, messages);
  assert.deepStrictEqual(entries.map(e => e.kind + ':' + (e.row.id || e.row.text)),
    ['you:Which is it?', 'firstmate:m2', 'you:Any update?', 'firstmate:m3']);
});

test('threadStatus reads answered once firstmate\'s answer is the last entry, awaiting otherwise', () => {
  const answered = [{ kind: 'you', row: { at: '10:00' } }, { kind: 'firstmate', row: { at: '10:05', id: 'm2' } }];
  assert.deepStrictEqual(threadStatus(answered), { state: 'answered', at: '10:05' });
  const awaiting = [{ kind: 'you', row: { at: '10:00' } }];
  assert.deepStrictEqual(threadStatus(awaiting), { state: 'awaiting', at: '10:00' });
  assert.strictEqual(threadStatus([]), null);
});

// His report 2026-09-28: queries with "no response" that were in fact
// answered elsewhere. An answer firstmate RECORDS against a send
// (`answers` = that send's note_id) threads under exactly that send, every
// one of them in order, and is never guessed onto another reply.
test('a recorded answer threads under the send it names, never under another', () => {
  const replies = [
    { at: '2026-09-28T10:00:00Z', msg: 'm1', title: 'Blue or green?', text: 'Which?', note_id: 'n1' },
    { at: '2026-09-28T10:20:00Z', msg: 'm1', title: 'Blue or green?', text: 'And the icon?', note_id: 'n2' },
  ];
  const messages = [
    { id: 'm1', task: 'cc-live', at: '2026-09-28T09:00:00Z', title: 'Blue or green?' },
    // Same task, inside reply 1's window: the guess would take it for reply 1.
    { id: 'a2', task: 'cc-live', at: '2026-09-28T10:10:00Z', title: 'Icon', text: 'Round.', answers: 'n2' },
    { id: 'a1', task: 'other', at: '2026-09-28T10:30:00Z', title: 'Colour', text: 'Blue.', answers: 'n1' },
    { id: 'a1b', at: '2026-09-28T10:40:00Z', title: 'More', text: 'Also teal.', answers: 'n1' },
  ];
  const entries = threadRows(replies, messages);
  assert.deepStrictEqual(entries.map(e => e.kind + ':' + (e.row.id || e.row.text)),
    ['you:Which?', 'firstmate:a1', 'firstmate:a1b', 'you:And the icon?', 'firstmate:a2']);
  assert.deepStrictEqual(recordedAnswers(replies[0], messages).map(m => m.id), ['a1', 'a1b']);
  assert.strictEqual(answeredSend(messages[1], replies), replies[1]);
  assert.strictEqual(answeredSend(messages[0], replies), null);
});

test('a send with no recorded answer reads awaiting, and old records thread as before', () => {
  const note = { at: '2026-09-28T10:00:00Z', kind: 'note', text: 'Why no response?', note_id: 'n9' };
  assert.deepStrictEqual(threadStatus(threadRows([note], [])), { state: 'awaiting', at: note.at });
  // A send with no note_id (a failed delivery) is never matched to anything.
  assert.deepStrictEqual(recordedAnswers({ at: note.at }, [{ id: 'x', answers: undefined }]), []);
});

test('only answerable, undeleted notes are their own conversations', () => {
  const rows = [
    { kind: 'note', sid: 'a', answerable: true },
    { kind: 'note', sid: 'b' },                       // sent before answers existed
    { kind: 'note', sid: 'c', answerable: true, deleted: true },
    { kind: 'reply', sid: 'd', answerable: true },
  ];
  assert.deepStrictEqual(noteThreads(rows).map(r => r.sid), ['a']);
});

process.exit(failures ? 1 : 0);
