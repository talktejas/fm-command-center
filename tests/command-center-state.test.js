// Behavioral regressions for the command center's decision rules. These execute
// web/command-center-state.js itself - the same file the page loads - so what is
// asserted is the rule, not a restatement of it. No DOM is involved: every one
// of these is a pure function of state.
'use strict';
const assert = require('assert');
const path = require('path');
const {
  knownValue, pollFacts, tense, transportFailure, verdictFor, releaseVerdicts, itemKey,
  shapeMessage, orderRows, archivedEpoch, stableGroupOrder, looksLikeQuestion, messageNeedsReply,
  replyTarget, foldSaid, wordsAfter,
  listSignature, mayRelease, logRead, sendState, sendKeys, sameWords,
  heldWith, captureBand, handRecordedNote, newestMessageMs, saidDigest, mergeMessages,
  waitingCount, waitingMessageRows, inMessagesTab, onHisBoard,
  isInfoOnlyMessage, sortedTab, saidTaskId, matchAnswer, threadRows, threadStatus,
  recordedAnswers, answeredSend, answerFor, foldAnswers, noteThreads, noteMomentAnswer,
  namesPr, mergeAskOnly, prAsks, markRepeats, workGroups, workStateLabel, saidOnItem, sendDot,
  ageWords, cardLabels, lacksWorkLabel,
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

// His ruling 2026-09-28: no label is never a reason to hide a message. Old
// records carry no project at all; new ones may say "unknown" - both read as
// one missing value, and a record with no title still has one to click.
test('a message with nothing known about its work reads as not recorded', () => {
  const old = shapeMessage({ id: 'o', at: '2026-09-01T10:00:00Z', text: 'Hi' });
  const neu = shapeMessage({ id: 'n', at: '2026-09-28T10:00:00Z', text: 'Hi',
    project: 'Unknown', worktree: '  ', branch: '(unknown)' });
  for (const m of [old, neu]) {
    assert.strictEqual(m.project, null);
    assert.strictEqual(m.worktree, null);
    assert.strictEqual(m.branch, null);
  }
  assert.strictEqual(knownValue(' jt2627s '), 'jt2627s');
  assert.strictEqual(shapeMessage({ id: 'b', text: 'First line\nmore' }).title, 'First line');
  assert.strictEqual(shapeMessage({ id: 'e' }).title, '(no title recorded)');
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

// A decision firstmate already closed is still served (remember_waiting), but
// the server routes a reply to it as a note (waiting_question skips closed
// ones), so the pane must say the same - and hand back the closed item so it
// can show the answer firstmate recorded.
test('a question whose decision firstmate closed is settled, not answerable', () => {
  const closed = Object.assign({}, stopped, { closed: true, answer: { text: 'REST' } });
  assert.deepStrictEqual(
    replyTarget({ question: true, task: 't1', question_key: 'k1' }, [closed]),
    { kind: 'note', settled: true, item: closed },
    'a closed decision was offered as the answer route');
  assert.deepStrictEqual(
    replyTarget({ question: true, task: 't1', question_key: 'k1' }, [closed, stopped]),
    { kind: 'answer', item: stopped },
    'a reopened decision was shadowed by its old closed copy');
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

// His rule 2026-09-28: "Waiting on you is things u need input / decisions from
// me. messages are messages that i need to see / review. info is just ...
// routine messages like nothing to review, its working etc."
test('a message that only recalls an ask made elsewhere is not itself waiting on him', () => {
  assert.strictEqual(looksLikeQuestion('Nothing new for you. Waiting on your A, B or C for the Koin build tools.'), false);
  assert.strictEqual(looksLikeQuestion('Captain, the labels are fixed. Still waiting on your read of the feature list.'), false);
  assert.strictEqual(looksLikeQuestion('Eight diamond items are built and waiting on your word, none merged.'), true,
    'a first ask phrased as waiting on him still waits');
  assert.strictEqual(looksLikeQuestion('Three ways to install it. Reply A, B or C.'), true);
  // His reply 2026-10-05 on "Still waiting on your prototype pick" filed as
  // Info: "this is fucking important should go in waiting for u".
  assert.strictEqual(isInfoOnlyMessage({ text: '*(no message - still waiting on your A, B or C for the Koin build tools)*' }), false,
    'a recall of an ask he still owes was filed as Info');
});

test('a long explanation written back to him is never routine, whatever quiet words it quotes', () => {
  const long = 'Captain, that one is entirely me, not the page. I kept typing little placeholders - "nothing needing you", '
    + '"no message" - and everything I type gets captured and becomes a row in your Messages. '.repeat(5);
  assert.ok(long.length > 400);
  assert.strictEqual(isInfoOnlyMessage({ text: long }), false);
});

test('a message needs a reply only when recorded as a question, until he replies', () => {
  const flagged = { id: 'm1', question: true, text: 'status update, nothing to decide' };
  const worded = { id: 'm2', question: false, text: 'Can I merge this branch?' };
  const plain = { id: 'm3', question: false, text: 'Deployed to staging.' };
  assert.strictEqual(messageNeedsReply(flagged, []), true);
  assert.strictEqual(messageNeedsReply(worded, []), false, 'its words promoted a plain message');
  assert.strictEqual(messageNeedsReply(plain, []), false);
  assert.strictEqual(messageNeedsReply(flagged, [{ msg: 'm1' }]), false,
    'a message he already replied to is no longer waiting on him');
  assert.strictEqual(messageNeedsReply(flagged, [{ msg: 'm9' }]), true,
    'a reply to a different message must not settle this one');
});

// His report 2026-10-05, the two real rows (captured from the transcript, no
// question flag, both attached to task b2b): "there is no input needed from me
// that u put such message in waiting on you, these are just simple messages."
// Neither its words, its task, nor that task's own open decision promotes one.
test('a plain captured message is never in Waiting on you, whatever it says or is attached to', () => {
  const items = [{ home: 'main', source: 'hold', id: 'b2b', key: '' }];
  const messages = [
    { id: 'c722110c6da3ba584', task: 'b2b', source: 'transcript',
      text: 'Nothing new for you in that, captain. Still yours: 1. Koin prototype - A, B, C or D. '
        + '2. Merge diamond - the next item cannot start until you say the word.' },
    { id: 'c5a77be02b8de0cc7', task: 'b2b', source: 'transcript',
      text: 'Captain, two things: 1. b2becom is under way. 2. luminaire - I can\'t find it. Which is it: '
        + 'a folder under a different name, a repo I should clone, or something new?' },
    { id: 'real', task: 'b2b', question: true, question_key: 'k', text: 'Which shape?' },
  ];
  assert.deepStrictEqual(waitingMessageRows(messages, [], items).map(m => m.id), ['real']);
  assert.deepStrictEqual(messages.filter(m => inMessagesTab(m, [], items)).map(m => m.id),
    ['c722110c6da3ba584', 'c5a77be02b8de0cc7']);
  assert.strictEqual(waitingCount(items, messages, [], 0), 2, 'the hold and the one recorded question');
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

// His ruling 2026-09-28: "If an item is in Waiting for You, don't put the same
// item in the message tab" - archiving everything in Messages had taken rows
// out of Waiting on you. A message is in exactly one of the two, and only his
// reply to IT (or firstmate settling its decision) moves it across.
test('a message is listed in Waiting on you or in Messages, never both', () => {
  const items = [Object.assign({}, stopped, { closed: true })];
  const messages = [
    { id: 'q1', question: true, text: 'Merge feature/x?' },
    { id: 'q2', question: true, text: 'Should I ship it?' },
    { id: 'q3', question: true, task: 't1', question_key: 'k1', text: 'Which shape?' },
    { id: 'n1', text: 'Deployed to staging.' },
    { id: 'h1', text: 'Tabs or spaces?', held: true },
  ];
  const said = [{ msg: 'q2', text: 'Ship it.' }];
  const waiting = waitingMessageRows(messages, said, items).map(m => m.id);
  const listed = messages.filter(m => inMessagesTab(m, said, items)).map(m => m.id);
  assert.deepStrictEqual(waiting, ['q1'], 'only the unanswered question waits on him');
  assert.deepStrictEqual(listed, ['q2', 'q3', 'n1'],
    'an answered question, one firstmate settled, and a plain message are what Messages lists');
  assert.strictEqual(waiting.filter(id => listed.includes(id)).length, 0,
    'a message was listed in two tabs at once');
  assert.strictEqual(waitingCount(items, messages, said, 0) + listed.length, 4,
    'the two badges count some message twice, or a held one at all');
  // A reply to q1 moves q1 and nothing else.
  const after = [{ msg: 'q1', text: 'Yes, merge it.' }].concat(said);
  assert.deepStrictEqual(waitingMessageRows(messages, after, items).map(m => m.id), []);
  assert.deepStrictEqual(messages.filter(m => inMessagesTab(m, after, items)).map(m => m.id),
    ['q1', 'q2', 'q3', 'n1'], 'a reply moved a message other than the one it answered');
});

// His ruling 2026-09-28 ("CI check failing: ... provider reported failure" -
// "what the fuck is this?"): only what firstmate put to him is on his board. A
// worker's own status decision is the worker asking firstmate.
test('a worker status decision is never on his board, a captain hold is', () => {
  const items = [
    { home: 'main', source: 'hold', id: 'a', key: 'a' },
    { home: 'main', source: 'status', id: 'b', key: 'ci-failing', title: 'CI check failing' },
    { home: 'main', source: 'status', id: 'c', key: 'k', closed: true },
  ];
  assert.deepStrictEqual(items.filter(onHisBoard).map(it => it.id), ['a']);
  assert.strictEqual(waitingCount(items, [], [], 0), 1,
    'a worker status decision was counted on his board');
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

// His report 2026-09-28: "why the fuck now important message which i need to
// review is in info instead of fucking message" - firstmate's finding that the
// cause of his vanishing items was established had been filed as Info. The
// test is "would he want to know this": results, findings, failures, changes
// and asks are Messages; only genuine noise is Info, and a message the rules
// cannot place is Messages. Cases below are real lines from the log.
test('only genuine noise is Info; any result, finding, failure, change or ask stays in Messages', () => {
  const info = [
    'Captain, understood on both counts. Encryption at rest: off. Four now waiting on your word.',
    'Captain, shipshape. Nothing new — the fleet is quiet and waiting on your three calls.',
    'Captain, a worker is now looking into it.',
    'Checks still running, none failing. Nothing new for the captain.',
    'Captain, shipshape. Same held wait — nothing stuck, nothing new.',
    'Routine progress. Both are validating. Nothing new for the captain.',
    "That's a leftover alert from the Codex worker I just stopped on purpose. Nothing new for the captain.",
    'Captain, on it — the gutter icons are dispatched, the names are being recorded.',
    '*(No message — nothing for you.)*',
  ];
  const messages = [
    'Captain, the cause of the vanishing items is established — project fm-command-center, repo talktejas/fm-command-center, branch main: 1. **Firstmate closing a decision dropped your items.**',
    'Captain, three command center problems, all found and now being fixed in one worker: 1. **Slow and unresponsive:** loading the message list takes 108 seconds.',
    'Captain, I checked `develop` itself, including its history. Facts: 1. On `develop` today, the Diamonds section has exactly two screens.',
    'Captain, Codex is on hold. Nothing runs on it now, and nothing new will be sent to it until you say otherwise. 1. **Stopped:** the old parked firstmate fix.',
    'Captain, shipshape. The consignor-statement worker finished and is parked on its pull request.',
    "Captain, you're right, and it changes. Koin will store 12.34 as 12.34. I'll bring the stack page back for your yes when it's done.",
    'Already handled and deployed. Nothing new for the captain.',
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
  assert.strictEqual(isInfoOnlyMessage({ text: 'Captain, here is how the sort works now.' }), false,
    'a message no rule places defaults to Messages');
  const long = 'Captain, I checked it. ' + 'Here is the reasoning. '.repeat(12) + 'The real cause was the window.';
  assert.strictEqual(isInfoOnlyMessage({ text: long }), false,
    'a finding anywhere in the text keeps it in Messages, not only in the lead');
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

// A home whose conversation record cannot be read captures nothing, so its
// messages are all hand-recorded. That is the normal state while they land:
// no banner at the top, only a quiet line at the foot of the page.
test('hand-recorded messages landing recently are not a banner', () => {
  const now = Date.parse('2026-10-05T18:00:00Z');
  const ctx = { newestAt: Date.parse('2026-10-05T16:46:15Z'), nowMs: now, workActive: true };
  const capture = { present: true, ok: true, active: false, named: 1 };
  assert.strictEqual(captureBand(capture, ctx), null);
  assert.strictEqual(captureBand(capture, { ...ctx, workActive: false }), null);
  assert.match(handRecordedNote(capture, ctx), /recorded by hand.*automatic capture is off/);
  assert.strictEqual(handRecordedNote(
    { present: true, ok: true, active: true, named: 1 }, ctx), null);
});

// The one case that still doubts the list: nothing recorded for a long stretch
// while work is underway, and no capture reading the conversation.
test('a silent stretch with work underway still says what to do', () => {
  const now = Date.parse('2026-10-05T18:00:00Z');
  const old = { newestAt: Date.parse('2026-10-03T00:00:00Z'), nowMs: now, workActive: true };
  const band = captureBand({ present: true, ok: true, active: false }, old);
  assert.match(band, /may be missing/);
  assert.match(band, /Start firstmate again/);
  assert.strictEqual(captureBand({ present: true, ok: true, active: false },
    { ...old, workActive: false }), null);
  assert.strictEqual(handRecordedNote({ present: true, ok: true, active: false }, old), null);
});

test('the newest message time is read from the rows that carry one', () => {
  assert.strictEqual(newestMessageMs([]), null);
  assert.strictEqual(newestMessageMs([{ at: 'bad' }, { at: '2026-10-05T16:46:15Z' },
    { at: '2026-10-05T10:00:00Z' }]), Date.parse('2026-10-05T16:46:15Z'));
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

test('an answer continues the conversation it answers instead of a row of its own', () => {
  // His ruling 2026-09-28: "i think u unarchive that and continue the thread".
  const original = shapeMessage({ id: 'm1', at: '2026-09-28T10:00:00Z', title: 'Heads up on answers', text: 'From now on...' });
  const other = shapeMessage({ id: 'm0', at: '2026-09-28T10:07:00Z', title: 'Unrelated', text: 'Build passed.' });
  const send = { kind: 'note', msg: 'm1', title: 'Heads up on answers', at: '2026-09-28T10:05:00Z',
    text: 'but what if i have already archived that message?', note_id: 'n1' };
  const answer = shapeMessage({ id: 'a1', at: '2026-09-28T10:10:00Z', title: 'Comes back', text: 'Nothing new for the captain.', answers: 'n1' });
  const all = [answer, other, original];
  const rows = foldAnswers(all, [send], all);
  // One record, one tab: the answer is not a row; the conversation carries it
  // and leads the list at the answer's time, marked with the newest answer.
  assert.deepStrictEqual(rows.map(m => m.id), ['m0', 'm1']);
  const m1 = rows.find(m => m.id === 'm1');
  assert.strictEqual(m1.answered_by, 'a1');
  assert.strictEqual(m1.since_epoch, answer.since_epoch);
  assert.strictEqual(rows.find(m => m.id === 'm0').answered_by, undefined);
  // Folded wherever the original sits - archived rows are in `all` too.
  assert.deepStrictEqual(foldAnswers([answer, other], [send], all).map(m => m.id), ['m0']);
  // The original aged out of everything the page holds: the answer keeps its
  // own row, says what it answers, and is never buried under Info.
  assert.deepStrictEqual(foldAnswers([answer, other], [send], [answer, other]).map(m => m.id), ['a1', 'm0']);
  assert.deepStrictEqual(answerFor(answer, [send], [answer]), { send, original: null, title: 'Heads up on answers' });
  assert.strictEqual(isInfoOnlyMessage(answer), false);
  assert.strictEqual(answerFor(original, [send], all), null);
  // It threads under the original, archived itself or not.
  assert.deepStrictEqual(threadRows([send], [original, Object.assign({ archived: true }, answer)])
    .map(e => e.kind + ':' + (e.row.id || e.row.text)), ['you:' + send.text, 'firstmate:a1']);
});


// His report 2026-09-28: a note read "Firstmate has not recorded an answer"
// while firstmate had answered it in ordinary conversation, which names no
// note. The first thing said after it, before his next send, is its answer -
// never an empty turn, a recorded answer to something else, or a reply about
// the task of another send of his.
test('a note is matched to what firstmate said next, and to nothing after his next send', () => {
  const note = { kind: 'note', sid: 'n1', at: '2026-09-28T11:33:26Z', text: 'is flutter open source?' };
  const said = [note];
  const empty = shapeMessage({ id: 'e', at: '2026-09-28T11:33:40Z', title: '*(no message)*' });
  const other = shapeMessage({ id: 'o', at: '2026-09-28T11:34:00Z', title: 'x', answers: 'someone-else' });
  const reply = shapeMessage({ id: 'r', at: '2026-09-28T11:34:56Z', title: 'Captain, yes — Flutter is open source' });
  assert.strictEqual(noteMomentAnswer(note, [reply, other, empty], said).id, 'r');
  // His next send closes the window.
  const later = { kind: 'note', sid: 'n2', at: '2026-09-28T11:34:30Z', text: 'and dart?' };
  assert.strictEqual(noteMomentAnswer(note, [reply], [later, note]), null);
  // Nothing inside the window at all.
  const late = shapeMessage({ id: 'l', at: '2026-09-28T12:30:00Z', title: 'much later' });
  assert.strictEqual(noteMomentAnswer(note, [late], said), null);
  // A reply about the task of his other send just before is that send's answer.
  const asked = shapeMessage({ id: 'q', at: '2026-09-28T11:30:00Z', title: 'Q', task: 'koin' });
  const onTask = shapeMessage({ id: 't', at: '2026-09-28T11:34:00Z', title: 'about koin', task: 'koin' });
  const replyToQ = { kind: 'reply', sid: 's0', msg: 'q', at: '2026-09-28T11:32:00Z', text: 'yes' };
  assert.strictEqual(noteMomentAnswer(note, [asked, onTask, reply], [note, replyToQ]).id, 'r');
});

// --- Jev's sorting (message.sort, served by command-center.py's Sorter) ----------
// His three tabs 2026-10-05: "Waiting on you is things u need input / decisions
// from me. messages are messages that i need to see / review. info is just
// messages routine messages like nothing to review, its working etc."
const sortedAs = (tab, extra) => Object.assign(
  { id: 'j1', text: 'The audit is in.', sort: { tab, choice: tab, confidence: 0.9 } }, extra);

test('a row Jev has not sorted is placed exactly as before', () => {
  for (const sort of [undefined, null, {}, { tab: 'elsewhere' }]) {
    assert.strictEqual(sortedTab({ sort }), null);
    assert.strictEqual(messageNeedsReply({ id: 'p', text: 'Reply 1 or 2?', sort }, []), false);
    assert.strictEqual(isInfoOnlyMessage({ text: 'Still running.', sort }), true);
    assert.strictEqual(isInfoOnlyMessage({ text: 'The audit is in.', sort }), false);
  }
});

test('Jev moves an unflagged row between Messages and Info', () => {
  // Against what the phrase lists alone would say, both ways.
  assert.strictEqual(isInfoOnlyMessage({ text: 'Still running.', sort: sortedAs('message').sort }), false);
  assert.strictEqual(isInfoOnlyMessage(sortedAs('info')), true);
  assert.strictEqual(inMessagesTab(sortedAs('info'), [], []), true, 'Info is still a Messages-side row');
  assert.strictEqual(messageNeedsReply(sortedAs('info'), []), false);
  assert.strictEqual(messageNeedsReply(sortedAs('message'), []), false);
});

test('a row Jev reads as a decision waits on him, in one tab, until he answers', () => {
  const row = sortedAs('decision');
  assert.strictEqual(messageNeedsReply(row, []), true);
  assert.strictEqual(inMessagesTab(row, [], []), false, 'listed in two tabs');
  assert.deepStrictEqual(waitingMessageRows([row], [], []).map(m => m.id), ['j1']);
  assert.strictEqual(waitingCount([], [row], [], NOW), 1);
  // A reply that only asks back leaves it; one that decides moves it to Messages.
  assert.strictEqual(messageNeedsReply(row, [{ msg: 'j1', text: 'Which one?' }]), true);
  const decided = [{ msg: 'j1', text: 'Go with the first.' }];
  assert.strictEqual(messageNeedsReply(row, decided), false);
  assert.strictEqual(inMessagesTab(row, decided, []), true);
  assert.strictEqual(isInfoOnlyMessage(row), false, 'an answered decision was filed as Info');
});

test('a recorded question is never Jev\'s to move', () => {
  // The server never sorts one; even a sort that slipped through changes nothing.
  for (const tab of ['info', 'message']) {
    const flagged = sortedAs(tab, { question: true });
    assert.strictEqual(messageNeedsReply(flagged, []), true, tab + ' took it out of Waiting on you');
    assert.strictEqual(isInfoOnlyMessage(flagged), false);
  }
  assert.strictEqual(isInfoOnlyMessage(sortedAs('info', { answers: 'note-1' })), false,
    'an answer to his own send was filed as Info');
});

test('a sort that arrives on a later poll changes the list signature', () => {
  const before = [{ id: 'a', at: '2026-10-05T10:00:00Z' }, { id: 'b', at: '2026-10-05T09:00:00Z' }];
  const after = [before[0], Object.assign({}, before[1], { sort: { tab: 'info' } })];
  assert.notStrictEqual(listSignature(before), listSignature(after));
  assert.strictEqual(listSignature(before), listSignature(before.slice()));
});

// His replies 2026-10-05, on rows Jev had lifted into Messages: "these are just
// info why fuck u are putting it in messages instead of in info tab", "Nothing
// for you, captain all these kind go in info".
test('a message that itself says there is nothing for him is Info always, whatever Jev says', () => {
  const { declaresNothingForHim, looksLikeInfoOnly } = require('../web/command-center-state.js');
  const real = [
    'Nothing for you, captain — another GitHub read timing out from here.',
    'Nothing for you, captain — the worker had misread why its check was failing; the evidence '
      + 'says the hand-opened pull request simply never got the pipeline\'s stamp. I sent it the '
      + 'correction: let the pipeline open its own. Still lands without asking you.',
    "Held, captain — I've stopped the worker before it binds anything, so it won't fight you "
      + 'for the ports. It keeps what it built and waits for your word.',
    'Nothing new, captain — a failed status read on my side; all workers fine.',
    'Landed, captain, nothing needed from you — the false alarm fix is merged.',
    'No change. Still running.',
  ];
  for (const text of real) {
    assert.strictEqual(declaresNothingForHim(text), true, text);
    assert.strictEqual(looksLikeInfoOnly(text), true, 'the rules alone: ' + text);
    for (const tab of ['decision', 'message', 'info']) {
      const row = { id: 'n1', text, sort: { tab, choice: tab, confidence: 0.99 } };
      assert.strictEqual(isInfoOnlyMessage(row), true, tab + ' lifted it out of Info: ' + text);
      assert.strictEqual(messageNeedsReply(row, []), false, tab + ' put it under Waiting on you');
    }
  }
  // Only the opening words declare it; and what he must answer still waits on him.
  for (const text of ['JewelTrek metals check app is back up at http://127.0.0.1:4303.',
    'The audit is in. Nothing changed in billing, but the ledger export is broken.',
    'Holding pattern explained: the cause is a stale lock, and here is the full finding. '
      + 'x'.repeat(400)])
    assert.strictEqual(declaresNothingForHim(text), false, text);
  // The always-Info rule never fires on a row that also asks him something.
  const pick = 'Still waiting on your prototype pick — A, B, C or D.';
  assert.strictEqual(looksLikeInfoOnly(pick), false, 'a pick he owes was filed as Info');
  assert.strictEqual(isInfoOnlyMessage({ id: 'p0', text: pick }), false);
  for (const text of ['Nothing new, captain. Still waiting on your prototype pick — A, B, C or D.',
    'Nothing new for you in that, captain — the mate is back up.\n\nStill yours:\n1. Koin prototype — A, B, C or D.',
    'Nothing for you, captain — unless you want it faster: say the word and I restart it.',
    'No change. Which one do you want?']) {
    assert.strictEqual(declaresNothingForHim(text), false, text);
    const row = { id: 'p1', text, sort: { tab: 'decision', choice: 'decision', confidence: 0.9 } };
    assert.strictEqual(isInfoOnlyMessage(row), false, 'an ask was buried in Info: ' + text);
    assert.strictEqual(messageNeedsReply(row, []), true, 'Jev could not list an ask: ' + text);
  }
  const asked = { id: 'q1', question: true, text: 'Nothing new for you, captain — except: A or B?' };
  assert.strictEqual(isInfoOnlyMessage(asked), false);
  assert.strictEqual(messageNeedsReply(asked, []), true);
  assert.strictEqual(isInfoOnlyMessage({ id: 'a1', answers: 'note-1', text: 'Nothing new.' }), false);
});

// His ruling 2026-10-05: "merge will go in seperate PR tab and not in action
// tab. action is only where u need my input."
test('a question that is nothing but a merge ask is shown in its PRs row, never under Input', () => {
  const pr = { id: 'media2', url: 'https://github.com/talktejas/interactp/pull/39' };
  const ask = { id: 'q39', question: true, text: 'Captain, INTERACT media slice 2 is ready for your '
    + 'merge call. 306 tests pass. Merge it? https://github.com/talktejas/interactp/pull/39' };
  const pick = { id: 'q1', question: true, text: 'Koin: pick a prototype - A, B, C or D?' };
  const both = { id: 'q2', question: true, text: 'Merge it? https://github.com/talktejas/interactp/pull/39 '
    + 'And which name do you want for the module?' };
  const all = [ask, pick, both];
  assert.strictEqual(mergeAskOnly(ask), true);
  assert.strictEqual(mergeAskOnly(pick), false);
  assert.strictEqual(mergeAskOnly(both), false, 'a second, different question still needs his input');
  assert.deepStrictEqual(waitingMessageRows(all, [], [], [pr]).map(m => m.id), ['q1', 'q2']);
  assert.strictEqual(waitingCount([], all, [], 0, [pr]), 2);
  assert.deepStrictEqual(prAsks(pr, all, [], []).map(m => m.id), ['q39']);
  // One record, one tab: inside the PRs row it is not also a row under Info.
  assert.strictEqual(inMessagesTab(ask, [], [], [pr]), false);
  // Its pull request no longer waits (merged): it is a message to read, not lost.
  assert.strictEqual(inMessagesTab(ask, [], [], []), true);
  assert.strictEqual(isInfoOnlyMessage(ask), false);
  // Answered, it leaves the PRs row for Info like any answered question.
  const said = [{ msg: 'q39', text: 'merge it' }];
  assert.deepStrictEqual(prAsks(pr, all, said, []), []);
  assert.strictEqual(inMessagesTab(ask, said, [], [pr]), true);
  // pull/3 is not pull/39.
  assert.strictEqual(namesPr(ask, { url: 'https://github.com/talktejas/interactp/pull/3' }), false);
});

// His ask 2026-10-05: "these repeted messages about pr waiting to be merged
// should not come in command center. should be ignored."
test('the first report of a pull request is Info; later still-waiting notes and copies are Ignore', () => {
  const url = 'https://github.com/talktejas/jeweltrek2627-slim/pull/230';
  const rows = markRepeats([   // newest first, as the page holds them
    { id: 'm6', text: 'Still waiting on your prototype pick — A, B, C or D.' },
    { id: 'm5', text: 'Still waiting on your prototype pick — A, B, C or D.' },
    { id: 'm4', text: 'The metals app is back   up.' },
    { id: 'm3', text: 'Cert mismatch (PR 230) is still holding for your merge word.' },
    { id: 'm2', text: 'Captain, ' + url + ' failed its checks after the rebase.' },
    { id: 'm1', text: 'The metals app is back up.' },
    { id: 'm0', text: 'The cert-mismatch work is finished and parked on your merge word: ' + url },
  ]);
  const by = Object.fromEntries(rows.map(m => [m.id, m]));
  assert.strictEqual(by.m0.repeat, false, 'the first report of a pull request was ignored');
  assert.strictEqual(isInfoOnlyMessage(by.m0), false);
  assert.strictEqual(by.m2.repeat, false, 'news about a known pull request was ignored');
  assert.strictEqual(by.m3.repeat, true);
  assert.strictEqual(isInfoOnlyMessage(by.m3), true);
  assert.strictEqual(by.m4.repeat, true, 'a word-for-word copy was listed twice');
  assert.strictEqual(by.m1.repeat, false);
  // A pick he owes is never noise, even repeated (his reply 2026-10-05).
  assert.strictEqual(by.m6.repeat, false);
  // Jev cannot lift a repeat into Input or Info; a recorded question is never one.
  const sorted = Object.assign({}, by.m3, { sort: { tab: 'decision', choice: 'decision', confidence: 0.9 } });
  assert.strictEqual(messageNeedsReply(sorted, []), false);
  assert.strictEqual(isInfoOnlyMessage(sorted), true);
  assert.strictEqual(isInfoOnlyMessage(Object.assign({}, by.m3, { question: true })), false);
  // A still-waiting note about a pull request never reported is not a repeat.
  assert.strictEqual(markRepeats([{ id: 'x', text: 'PR 7 is still waiting on your merge word.' }])[0].repeat, false);
});

// His ask 2026-10-05: "put all the separate projects separately". Work rows
// group by their own one project; a row with none is its own group, last.
test('work rows group by their own project, finished ones kept apart', () => {
  const items = [
    { id: 'a2', project: 'alpha', state: 'queued', waits_on: [{ id: 'a1', title: 'Build A' }] },
    { id: 'b1', project: 'beta', state: 'waiting', detail: 'Pick one' },
    { id: 'a1', project: 'alpha', state: 'building' },
    { id: 'a0', project: 'alpha', state: 'done', done_on: '2026-10-05' },
    { id: 'x1', project: null, state: 'queued' },
    { id: 'x2', project: 'unknown', state: 'building' },
  ];
  const groups = workGroups(items, 'project');
  assert.deepStrictEqual(groups.map(g => [g.name, g.rows.map(r => r.id), g.done.map(r => r.id)]), [
    ['alpha', ['a1', 'a2'], ['a0']],
    ['beta', ['b1'], []],
    ['Project unknown', ['x2', 'x1'], []],
  ]);
  // Every row is in exactly one group, whatever the sort.
  for (const sort of ['project', 'state'])
    assert.strictEqual(workGroups(items, sort).reduce((n, g) => n + g.rows.length + g.done.length, 0),
      items.length, sort);
  assert.deepStrictEqual(workGroups(items, 'state').map(g => [g.name, g.rows.length, g.done.length]),
    [['Waiting on you', 1, 0], ['Being built now', 2, 0], ['Not started', 2, 0], ['Done', 0, 1]]);
  assert.strictEqual(workStateLabel(items[0], '2026-10-05'), 'Not started — waits on Build A');
  assert.strictEqual(workStateLabel(items[1], '2026-10-05'), 'Waiting on you — Pick one');
  assert.strictEqual(workStateLabel(items[3], '2026-10-05'), 'Done today');
  assert.strictEqual(workStateLabel(items[3], '2026-10-06'), 'Done yesterday');
  assert.strictEqual(workStateLabel(items[3], '2026-10-09'), 'Done 2026-10-05');
});

// His report 2026-10-05: "the above answer i gave against some other ticket
// why the fuck it is coming against this?" - a reply typed on a message was
// threaded under the hold its task carried.
test('a reply written on a message is never shown under an item', () => {
  const key = 'main/hold/t1/t1';
  const said = [{ sid: 'b', item_key: key, text: 'written on the item' },
                { sid: 'a', msg: 'm1', item_key: key, text: 'written on the message' }];
  assert.deepStrictEqual(saidOnItem(said, key).map(r => r.sid), ['b']);
});

// His report 2026-10-05: a note already in firstmate's inbox stayed the same
// white ring as one still going out. Each recorded fact has its own state.
test('the sent marker follows the record: going, delivered, read, failed', () => {
  const dot = (row, pending) => (sendDot(row, pending) || {}).state || null;
  assert.strictEqual(dot({ kind: 'draft' }), null);
  assert.strictEqual(dot({ sid: 'a', outcome: 'sending' }), 'going');
  assert.strictEqual(dot({ sid: 'a', outcome: 'unknown' }), 'going');
  assert.strictEqual(dot({ sid: 'a', outcome: 'sent', note_id: 'n1' }), 'delivered');
  assert.strictEqual(dot({ sid: 'a', outcome: 'sent' }), 'delivered', 'a send from before note ids');
  assert.strictEqual(dot({ sid: 'a', outcome: 'sent', note_id: 'n1', received: true }), 'read');
  assert.strictEqual(dot({ sid: 'a', outcome: 'failed' }), 'failed');
  // Every state says what it means in words.
  for (const row of [{ sid: 'a', outcome: 'sending' }, { sid: 'a', outcome: 'unknown' },
                     { sid: 'a', outcome: 'sent' }, { sid: 'a', outcome: 'failed' }])
    assert.ok(sendDot(row).title.length > 10);
});

// His report 2026-10-05, at 00:05 on his own clock (UTC+7), 17:05 UTC: rows
// filed seconds earlier read "17h". A hold's "(since 2026-10-05)" is a date,
// served as that day's 00:00 UTC - the hours since UTC midnight are not an age.
test('an age is now minus a recorded instant; a date-only record is worded by the day', () => {
  const now = Date.parse('2026-10-05T17:05:00Z') / 1000;       // 2026-10-06 00:05 +07:00
  const filedToday = Date.parse('2026-10-05T00:00:00Z') / 1000; // "(since 2026-10-05)"
  assert.strictEqual(ageWords(filedToday, now, 'created'), 'today', 'not 17h');
  assert.strictEqual(ageWords(filedToday - 86400, now, 'created'), '1d');
  assert.strictEqual(ageWords(filedToday - 5 * 86400, now, 'created'), '6d');
  // A real instant keeps its real age on either side of his midnight.
  const set = Date.parse('2026-10-05T16:51:13Z') / 1000;
  assert.strictEqual(ageWords(set, now, 'hold-set'), '14m');
  assert.strictEqual(ageWords(set, Date.parse('2026-10-05T16:59:13Z') / 1000, 'hold-set'), '8m');
  assert.strictEqual(ageWords(now - 20, now), '1m');
  assert.strictEqual(ageWords(Date.parse('2026-10-05T00:05:00Z') / 1000, now), '17h');
  assert.strictEqual(ageWords(null, now), 'no recorded time');
});

// His report 2026-10-05: "where is the fucking worktree and branch?"
test('every card names project, worktree and branch, and says which is not recorded', () => {
  assert.deepStrictEqual(cardLabels({ project: 'koin', worktree: '/home/tds/p/koin', branch: 'develop' })
    .map(l => [l.text, l.missing]), [['koin', false], ['~/p/koin', false], ['develop', false]]);
  assert.deepStrictEqual(cardLabels({ project: 'koin', worktree: 'unknown', branch: null })
    .map(l => [l.text, l.missing]),
    [['koin', false], ['worktree not recorded', true], ['branch not recorded', true]]);
  assert.deepStrictEqual(cardLabels({}).map(l => l.text),
    ['project not recorded', 'worktree not recorded', 'branch not recorded']);
  assert.strictEqual(lacksWorkLabel({ project: 'koin', worktree: '~/p/koin', branch: 'develop' }), false);
  assert.strictEqual(lacksWorkLabel({ project: 'koin', worktree: '~/p/koin' }), true);
});

// His report 2026-10-05: notes firstmate had read still said "awaiting firstmate".
test('a send firstmate has acknowledged is no longer awaiting firstmate', () => {
  const sent = { sid: 'a', kind: 'note', at: '2026-10-05T17:09:13Z', note_id: 'n1', outcome: 'sent' };
  assert.strictEqual(threadStatus([{ kind: 'you', row: sent }]).state, 'awaiting');
  assert.strictEqual(threadStatus([{ kind: 'you', row: Object.assign({ received: true }, sent) }]), null);
  assert.strictEqual(threadStatus([{ kind: 'you', row: sent },
    { kind: 'firstmate', row: { id: 'm1', at: '2026-10-05T17:09:58Z' } }]).state, 'answered');
});

process.exit(failures ? 1 : 0);

// His report 2026-10-05 ("why the fuck pr is coming under input?"): a recorded
// question on a task whose pull request waits in the PRs data, asking only for
// the merge, is shown in that PR row and never under Action - even when its
// words name no pull request URL and match no merge wording test. The proof is
// message m20261005T164859Z-36852 ("say \"merge 38\"").
test('a recorded merge ask on a task with a waiting pull request is never under Action', () => {
  const pr = { id: 'fm-jev-wake-triage', url: 'https://github.com/talktejas/firstmate/pull/38' };
  const proof = { id: 'm20261005T164859Z-36852', question: true, task: 'fm-jev-wake-triage',
    text: 'Captain, one merge is ready for your word (firstmate): '
      + 'https://github.com/talktejas/firstmate/pull/38 - say "merge 38".\n\n'
      + '1. **What it does:** Jev quietly closes the routine re-checks of a pull request.' };
  assert.strictEqual(mergeAskOnly(proof, [pr]), true);
  assert.deepStrictEqual(waitingMessageRows([proof], [], [], [pr]).map(m => m.id), []);
  assert.strictEqual(inMessagesTab(proof, [], [], [pr]), false, 'one record, one tab');
  assert.deepStrictEqual(prAsks(pr, [proof], [], []).map(m => m.id), [proof.id]);
  assert.strictEqual(waitingCount([], [proof], [], 0, [pr]), 0);
  // Without that pull request in the PRs data, it is a plain recorded question again.
  assert.strictEqual(mergeAskOnly(proof, []), false);
  assert.strictEqual(waitingCount([], [proof], [], 0, []), 1);
});
