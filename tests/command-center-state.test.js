// Behavioral regressions for the command center's decision rules. These execute
// web/command-center-state.js itself - the same file the page loads - so what is
// asserted is the rule, not a restatement of it. No DOM is involved: every one
// of these is a pure function of state.
'use strict';
const assert = require('assert');
const path = require('path');
const {
  pollFacts, tense, transportFailure, verdictFor, releaseVerdicts, itemKey,
  shapeMessage, orderRows, replyTarget, foldSaid, wordsAfter,
  listSignature, mayRelease, logRead, sendState, sendKeys, spokenFor, sameWords,
  heldWith, captureBand, saidDigest, mergeMessages,
  wordConversationKey, orderWordsByLastReply,
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

// --- My words, grouped by conversation ------------------------------------------
// His ruling 2026-09-21: a conversation he replied to a minute ago goes to the
// top, even when an older reply to it sits further down the newest-first log.
test('My words bubbles a conversation to the top of its most recent reply', () => {
  const rows = [   // newest first, as read_said serves them
    { at: 't4', msg: 'm1', text: 'one more thing' },     // m1's latest
    { at: 't3', item_key: 'k2', text: 'merging now' },   // k2's only reply
    { at: 't2', item_key: 'k3', text: 'noted' },          // k3's only reply
    { at: 't1', msg: 'm1', text: 'first reply' },          // m1's older reply
  ];
  assert.deepStrictEqual(orderWordsByLastReply(rows).map(r => r.at),
    ['t4', 't1', 't3', 't2'],
    'm1 groups under its newest reply (t4) instead of splitting across the list');
});

test('a conversation key matches what the row itself opens by', () => {
  assert.strictEqual(wordConversationKey({ msg: 'm1', item_key: 'k2' }), 'msg/m1');
  assert.strictEqual(wordConversationKey({ item_key: 'k2' }), 'k2');
  assert.strictEqual(wordConversationKey({ key: 'note-1' }), 'note-1');
  assert.strictEqual(wordConversationKey({}), '');
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

// One send is never described two ways on one surface: the words of a send in
// flight, or of one the page gave up on, are already spoken for by the record.
test('the record speaks for the words it was sent', () => {
  const pending = { a: { key: 'msg/m1', item: 'main/hold/t1/t1',
                         text: 'go blue', released: true } };
  assert.strictEqual(spokenFor(pending, 'msg/m1', 'go blue'), true);
  assert.strictEqual(spokenFor(pending, 'main/hold/t1/t1', 'go blue'), true,
    'the item it steered is the same send, not a second one');
  assert.strictEqual(spokenFor(pending, 'msg/m1', 'a new thought'), false,
    'words he typed since really are unsent and must say so');
  assert.strictEqual(spokenFor({}, 'msg/m1', 'go blue'), false);
  assert.strictEqual(spokenFor(undefined, 'msg/m1', 'go blue'), false);
});

test('only a send that landed takes his words out of the box', () => {
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'sent' }), 'clear');
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'failed' }), 'restore');
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'unknown' }), 'restore');
  assert.strictEqual(wordsAfter({ sid: 'a', outcome: 'sending' }), null,
    'an accepted send must not be treated as a delivered one');
  assert.strictEqual(wordsAfter({ outcome: 'sent' }), null,
    'a row from no send of his must not empty a box');
});

// --- did anything actually change? ---------------------------------------------
// A record that has not moved must not re-render the page: the reply box he is
// typing in is rebuilt by a render, and a log with no change check of its own
// answers every poll with a fresh 200.
test('an unchanged list is recognised as unchanged', () => {
  const rows = [{ sid: 'b', outcome: 'sent', at: '2026-09-02T10:00:00Z' },
                { sid: 'a', outcome: 'sent', at: '2026-09-01T10:00:00Z' }];
  assert.strictEqual(listSignature(rows), listSignature(rows.slice()),
    'the same rows read twice must look the same');
  assert.notStrictEqual(listSignature(rows),
    listSignature([{ sid: 'c', outcome: 'sending', at: '2026-09-03T10:00:00Z' }, ...rows]),
    'a new row must look different');
  assert.notStrictEqual(listSignature(rows),
    listSignature([{ sid: 'b', outcome: 'sending', at: '2026-09-02T10:00:00Z' },
                   rows[1]]),
    'the same row with a new outcome must look different');
  assert.strictEqual(listSignature([]), listSignature(undefined),
    'a log that is not there yet and an empty one are the same list');
});

// --- releasing a send nobody can confirm ----------------------------------------
// A box he can never type into again is the freeze that started this by another
// road, so the page releases a send it can never hear the end of. It may only
// do that off a record it actually read: a delivery that really landed must
// never be buried under an unknown outcome invented while the page was blind.
const held = { key: 'main/hold/t1/t1', text: 'go blue', at: 1000 };
const WINDOW = 150000;

test('a send is released only past the window, and only on a real read', () => {
  assert.strictEqual(mayRelease(true, held, undefined, 1000 + WINDOW + 1, WINDOW), true);
  assert.strictEqual(mayRelease(true, held, undefined, 1000 + 1, WINDOW), false,
    'a send still inside the window is in flight, not lost');
  assert.strictEqual(mayRelease(false, held, undefined, 1000 + WINDOW + 1, WINDOW), false,
    'a record that could not be read may not release anything');
  assert.strictEqual(mayRelease(true, {...held, released: true}, undefined,
                                1000 + WINDOW + 1, WINDOW), false,
    'a send already released must not be released twice');
});

test('a record that answered the send keeps its own answer', () => {
  assert.strictEqual(mayRelease(true, held, {sid: 'a', outcome: 'sent'},
                                1000 + WINDOW + 1, WINDOW), false,
    'a delivered send must never be reported as unconfirmed');
  assert.strictEqual(mayRelease(true, held, {sid: 'a', outcome: 'sending'},
                                1000 + WINDOW + 1, WINDOW), true,
    'an acceptance row with no outcome after it past the window is unconfirmed');
});

// --- was the record actually read? ---------------------------------------------
// The other half of the release invariant: the server answers 200 with no rows
// and an error when it could not read a log, and treating that as the record is
// how a send whose outcome is already on disk gets released as unconfirmed.
test('a body carrying a read error is not a read', () => {
  const failed = logRead({ said: [], error: 'the record could not be read: x',
                           dropped: 0 }, 'said');
  assert.strictEqual(failed.read, false);
  assert.strictEqual(failed.rows, null, 'a failed read carries no rows to hold');
  assert.strictEqual(failed.error, 'the record could not be read: x');
  assert.strictEqual(mayRelease(failed.read, held, undefined,
                                1000 + WINDOW + 1, WINDOW), false,
    'a send must never be released off a record that could not be read');
});

test('a body with rows and no error is a read', () => {
  const got = logRead({ said: [{ sid: 'a', outcome: 'sent' }], dropped: 3 }, 'said');
  assert.strictEqual(got.read, true);
  assert.strictEqual(got.rows.length, 1);
  assert.strictEqual(got.dropped, 3, 'what the limit cut must survive the read');
  assert.deepStrictEqual(logRead({}, 'said').rows, [],
    'a log with nothing in it yet is an empty read, not a failed one');
});

// --- a send the page gave up on ------------------------------------------------
// The acceptance row keeps saying `sending` forever when no outcome row is ever
// written, so once the page has given up on that send nothing may still read it
// as a delivery on its way: one send described two ways is the contradiction.
test('a released send is never still going out', () => {
  const row = { sid: 'a', outcome: 'sending' };
  assert.strictEqual(sendState(row, {}), 'sending');
  assert.strictEqual(sendState(row, { a: { key: 'k', released: true } }), 'given-up');
  assert.strictEqual(sendState(row, { a: { key: 'k' } }), 'sending',
    'a send still in flight is still in flight');
  assert.strictEqual(sendState({ sid: 'a', outcome: 'sent' },
                               { a: { key: 'k', released: true } }), 'sent',
    'an outcome that arrived late supersedes the page giving up');
  assert.strictEqual(sendState(undefined, undefined), undefined);
});

// --- the surfaces one send touches ---------------------------------------------
// A reply on the answer route is a steer at an item as well as a reply to a
// message, and everything said about it must be said - and taken back - on
// both, or one surface warns him about a delivery the other has confirmed.
test('a send is said on every surface it touches, once each', () => {
  assert.deepStrictEqual(sendKeys('msg/m1', 'main/hold/t1/t1'),
    ['msg/m1', 'main/hold/t1/t1']);
  assert.deepStrictEqual(sendKeys('main/hold/t1/t1', null), ['main/hold/t1/t1'],
    'an answer sent from the item itself has one surface');
  assert.deepStrictEqual(sendKeys('main/hold/t1/t1', 'main/hold/t1/t1'),
    ['main/hold/t1/t1'], 'one surface named twice is still one surface');
  assert.deepStrictEqual(sendKeys('', ''), [],
    'a note hangs off nothing, so there is no surface to hold state against');
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
  assert.strictEqual(spokenFor({ a: { key: 'msg/m1', text: 'Go blue.' } },
                               'msg/m1', 'Go blue.\n'),
    true, 'one send must not read as a second unsent draft over a newline');
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

process.exit(failures ? 1 : 0);
