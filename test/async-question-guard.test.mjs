import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectQuestions, formatQuestionReply, parseQuestionReply, pendingAsyncQuestions } from '../src/desktop/async-question-guard.mjs';
import { desktopView } from '../src/desktop/view.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';
import { makeWindow } from '../src/desktop/history-pagination.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { buildConversationStateFromThread, projectAuthoritativeHistoryPage } = require('../src/desktop/vendor/remodex/desktop-ipc-conversation-adapter.cjs');

test('projects desktop async question IDs and formats the desktop reply', () => {
  const questions = inspectQuestions({ type: 'agentMessage', id: 'item', questions: [{ title: 'Choose', options: ['A', 'B'] }] });
  assert.deepEqual(questions, [{ id: '["request_user_input_async","item",0]', question: 'Choose', options: ['A', 'B'] }]);
  const expected = `<send_user_message_question_reply>\n${JSON.stringify([{ questionItemId: questions[0].id, question: 'Choose', answer: 'A' }])}\n</send_user_message_question_reply>`;
  assert.equal(formatQuestionReply(questions, { [questions[0].id]: 'A' }), expected);
  assert.equal(formatQuestionReply(questions, { wrong: 'A' }), null);
});

test('identity-based answers retain distinct identical questions across turns', async () => {
  const first = question('first'), second = question('second');
  const answerSecond = formatQuestionReply(inspectQuestions(second), { [JSON.stringify(['request_user_input_async', 'second', 0])]: 'yes' });
  const state = { id: 'thread', resumeState: 'resumed', cwd: '/tmp', threadRuntimeStatus: { type: 'idle' }, turns: [
    { turnId: 'one', status: 'completed', items: [first, second] },
    { turnId: 'two', status: 'completed', params: { input: [{ type: 'text', text: answerSecond }] }, items: [] },
  ] };
  const view = desktopView(state);
  const [a, b] = view.turns[0].items;
  assert.deepEqual(a.pendingQuestionIds, [a.questions[0].id]);
  assert.deepEqual(b.pendingQuestionIds, []);
  assert.deepEqual(view.turns[1].items[0].questionReplyIds, [b.questions[0].id]);
  const window = makeWindow(view, { recentCount: 1 });
  assert.equal(window.history.complete, false);
  assert.deepEqual(window.turns[0].items[0].questionReplyIds, [b.questions[0].id]);
  const allWindow = makeWindow(view, { recentCount: 2 });
  assert.deepEqual(allWindow.turns[0].items[0].pendingQuestionIds, [a.questions[0].id]);
  assert.deepEqual(pendingAsyncQuestions(view, 'first'), a.questions);
  assert.equal(pendingAsyncQuestions(view, 'second'), null);
  let dispatched = 0;
  const session = new DesktopSession({ conversationId: 'thread' });
  session.status = 'ready'; session.conversation = { value: state, revision: 5, ownerId: 'owner' };
  session.client = { startTurn: async (_id, _data, options) => { assert.equal(options.beforeWrite(), true); dispatched++; } };
  await session.replyAsyncQuestions('first', { [a.questions[0].id]: 'yes' });
  assert.equal(dispatched, 1);
  await assert.rejects(session.replyAsyncQuestions('second', { [b.questions[0].id]: 'yes' }), { code: 'unavailable' });
});

function question(id) { return { type: 'agentMessage', id, questions: [{ title: 'Same question', options: ['yes', 'no'] }] }; }

test('ambiguous or incomplete history cannot establish an old pending answer', () => {
  const first = question('first'), second = question('second');
  const view = desktopView({ id: 'thread', turns: [{ turnId: 'one', items: [first, second] }] });
  assert.equal(view.history.complete, false);
  assert.equal(view.turns[0].items[0].pendingQuestionIds, undefined);
  assert.equal(pendingAsyncQuestions(view, 'first'), null);
  assert.ok(pendingAsyncQuestions(view, 'second'));
  const duplicate = desktopView({ id: 'thread', resumeState: 'resumed', turns: [{ turnId: 'one', items: [first, first] }] });
  assert.equal(pendingAsyncQuestions(duplicate, 'first'), null);
  assert.equal(duplicate.turns[0].items[0].pendingQuestionIds, undefined);
});

test('a complete newest turn from the real adapter preserves independent questions despite older turn pagination', () => {
  const state = buildConversationStateFromThread({ id: 'thread', cwd: '/tmp', turns: [{ id: 'one', status: 'completed', itemsView: 'full', items: [question('first'), question('second')] }] });
  projectAuthoritativeHistoryPage(state, { hasLoadedOldest: false, olderCursor: 'older', oldestLoadedTurnId: 'one' });
  const view = desktopView(state);
  assert.equal(view.history.complete, false);
  assert.deepEqual(view.turns[0].items[0].pendingQuestionIds, [questionIdFor('first')]);
  assert.deepEqual(pendingAsyncQuestions(view, 'first'), view.turns[0].items[0].questions);
  const cases = [
    s => { s.turnHistory.history.islands[0].newerBoundary.status = 'available'; },
    s => { s.turnHistory.history.islands.push(structuredClone(s.turnHistory.history.islands[0])); },
    s => { s.turns[0].itemsPagination.evicted = true; },
    s => { s.turns[0].itemsPagination.hasLoadedNewest = false; },
    s => { s.turns[0].itemsPagination.hasLoadedOldest = false; },
    s => { s.turns[0] = structuredClone(s.turns[0]); s.turns[0].items.push(question('later')); },
  ];
  for (const alter of cases) {
    const changed = structuredClone(state); alter(changed);
    const candidate = desktopView(changed);
    assert.equal(candidate.turns[0].items[0].pendingQuestionIds, undefined);
    assert.equal(pendingAsyncQuestions(candidate, 'first'), null);
  }
});

test('a canonical complete claim requires a complete newest boundary and item tail', () => {
  const state = buildConversationStateFromThread({ id: 'thread', cwd: '/tmp', turns: [{ id: 'one', status: 'completed', itemsView: 'full', items: [question('first'), question('second')] }] });
  state.turns = [];
  const normal = desktopView(state);
  assert.equal(normal.history.complete, true);
  assert.ok(pendingAsyncQuestions(normal, 'first'));
  for (const alter of [
    s => { s.turnHistory.history.islands[0].newerBoundary.status = 'available'; },
    s => { delete s.turnHistory.history.islands[0].newerBoundary; },
    s => { s.turnHistory.history.entitiesByKey['turn:one'].itemsPagination.hasLoadedNewest = false; },
  ]) {
    const changed = structuredClone(state); alter(changed);
    const view = desktopView(changed);
    assert.equal(view.history.complete, false);
    assert.equal(view.turns[0].items[0].pendingQuestionIds, undefined);
    assert.equal(pendingAsyncQuestions(view, 'first'), null);
  }
});

test('reply parser rejects malformed, duplicate or noncanonical question identities', () => {
  const wrap = replies => `<send_user_message_question_reply>\n${JSON.stringify(replies)}\n</send_user_message_question_reply>`;
  const reply = { questionItemId: JSON.stringify(['request_user_input_async', 'item', 0]), question: 'Q', answer: 'A' };
  assert.deepEqual(parseQuestionReply(wrap([reply])), [reply]);
  assert.deepEqual(parseQuestionReply(wrap(reply)), [reply]);
  assert.equal(parseQuestionReply(wrap([reply, reply])), null);
  assert.equal(parseQuestionReply(wrap([{ ...reply, questionItemId: '["request_user_input_async", "item",0]' }])), null);
  assert.equal(parseQuestionReply(wrap([{ ...reply, answer: '' }])), null);
});

test('async reply retains the existing owner and revision check before dispatch', async () => {
  const item = question('item');
  const state = { id: 'thread', resumeState: 'resumed', cwd: '/tmp', threadRuntimeStatus: { type: 'idle' }, turns: [{ turnId: 'turn', items: [item] }] };
  const session = new DesktopSession({ conversationId: 'thread' });
  session.status = 'ready'; session.conversation = { value: state, revision: 4, ownerId: 'owner' };
  session.client = { startTurn: async (_id, _data, options) => {
    session.conversation.revision++;
    if (!options.beforeWrite()) throw Object.assign(new Error('changed'), { code: 'unavailable' });
  } };
  await assert.rejects(session.replyAsyncQuestions('item', { [questionIdFor('item')]: 'yes' }), { code: 'unavailable' });
});

test('only an accepted or acknowledged steer resolves an async question', () => {
  const item = question('item'), id = questionIdFor('item');
  const text = formatQuestionReply(inspectQuestions(item), { [id]: 'yes' });
  for (const [status, steerAcknowledged, answered] of [['pending', false, false], ['failed', false, false], ['accepted', false, true], ['pending', true, true]]) {
    const state = { id: 'thread', resumeState: 'resumed', turns: [{ turnId: 'turn', items: [item, { type: 'steeringUserMessage', id: 'steer', status, steerAcknowledged, input: [{ type: 'text', text }] }] }] };
    const view = desktopView(state), [questionItem, steer] = view.turns[0].items;
    assert.deepEqual(questionItem.pendingQuestionIds, answered ? [] : [id]);
    assert.deepEqual(steer.questionReplyIds, answered ? [id] : undefined);
    assert.deepEqual(steer.questionReplyPendingIds, answered ? undefined : [id]);
    assert.deepEqual(questionItem.submittingQuestionIds, answered ? undefined : [id]);
  }
});

test('optimistic turn input does not resolve a question before actual confirmation', () => {
  const item = question('item'), id = questionIdFor('item');
  const text = formatQuestionReply(inspectQuestions(item), { [id]: 'yes' });
  const questionTurn = { turnId: 'question-turn', status: 'completed', items: [item] };
  const replyTurn = { turnId: 'optimistic', status: 'inProgress', remodexOptimisticPendingTurn: true,
    params: { threadId: 'thread', input: [{ type: 'text', text }], clientUserMessageId: 'client' }, items: [] };
  const state = { id: 'thread', resumeState: 'resumed', turns: [questionTurn, replyTurn] };
  const optimistic = desktopView(state);
  assert.deepEqual(optimistic.turns[0].items[0].pendingQuestionIds, [id]);
  assert.deepEqual(optimistic.turns[1].items[0].questionReplyPendingIds, [id]);
  assert.deepEqual(optimistic.turns[0].items[0].submittingQuestionIds, [id]);
  assert.equal(pendingAsyncQuestions(optimistic, 'item'), null);
  assert.equal(optimistic.turns[1].items[0].questionReplyIds, undefined);
  const partial = desktopView({ ...state, resumeState: undefined });
  assert.equal(partial.history.complete, false);
  assert.deepEqual(partial.turns[0].items[0].submittingQuestionIds, [id]);
  assert.equal(partial.turns[0].items[0].pendingQuestionIds, undefined);
  const rejected = desktopView({ ...state, turns: [questionTurn] });
  assert.deepEqual(rejected.turns[0].items[0].pendingQuestionIds, [id]);
  const confirmed = desktopView({ ...state, turns: [questionTurn, { ...replyTurn, remodexOptimisticPendingTurn: false, turnId: 'confirmed' }] });
  assert.deepEqual(confirmed.turns[0].items[0].pendingQuestionIds, []);
  assert.deepEqual(confirmed.turns[1].items[0].questionReplyIds, [id]);
  assert.equal(confirmed.turns[1].items[0].questionReplyPendingIds, undefined);
  assert.equal(confirmed.turns[0].items[0].submittingQuestionIds, undefined);
});

function questionIdFor(id) { return JSON.stringify(['request_user_input_async', id, 0]); }
