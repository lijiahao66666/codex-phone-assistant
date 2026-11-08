import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopView } from '../src/desktop/view.mjs';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

test('1 GiB history marker resumes with only an authoritative finite page and unchanged runtime settings', async () => {
  const f = await fixture({ data: [turn('new', 3), turn('middle', 2), turn('old', 1)], nextCursor: 'opaque-older', backwardsCursor: 'different-anchor' });
  try {
    await f.resume();
    assert.equal(f.metadata.extra.fixtureRolloutBytes, 1024 ** 3);
    assert.deepEqual(f.requests.find(r => r.method === 'thread/resume').params,
      { threadId, excludeTurns: true, initialTurnsPage: { limit: 3, itemsView: 'summary', sortDirection: 'desc' } });
    assert.equal(f.reads.length, 0);
    assert.equal(f.requests.some(r => r.method === 'thread/settings/update'), false);
    const state = f.state();
    assert.deepEqual(state.turns.map(t => t.turnId), ['old', 'middle', 'new']);
    assert.equal(state.historyMode, 'paginated');
    assert.equal(state.turnHistory.history.isComplete, false);
    assert.equal(state.turnsPagination.olderCursor, 'opaque-older');
    assert.equal(state.turnHistory.history.islands[0].olderBoundary.handle.cursor, 'opaque-older');
    assert.ok(state.turns.every(t => t.itemsPagination.hasLoadedOldest === false));
    assert.equal(desktopView(state).history.complete, false);
    assert.deepEqual([desktopView(state).model, desktopView(state).reasoningEffort], ['actual-model', 'high']);
    assert.ok(Buffer.byteLength(JSON.stringify(f.snapshots().at(-1))) < 65536);
  } finally { await f.close(); }
});

test('a legitimate empty page is ready without placeholder turns or automatic complete read', async () => {
  const f = await fixture({ data: [], nextCursor: null, backwardsCursor: null });
  try {
    await f.resume();
    assert.deepEqual(f.state().turns, []);
    assert.equal(f.reads.length, 0);
    assert.equal(f.state().turnHistory.history.isComplete, true);
    assert.equal(desktopView(f.state()).history.complete, true);
  } finally { await f.close(); }
});

test('last turn page still reports incomplete items when every returned turn is a summary', async () => {
  const f = await fixture({ data: [turn('only')], nextCursor: null });
  try {
    await f.resume();
    assert.equal(f.state().turnHistory.history.isComplete, true);
    assert.equal(f.state().turns[0].itemsPagination.hasLoadedOldest, false);
    assert.equal(f.snapshots().at(-1).params.change.conversationState.turnHistory.history.entitiesByKey['turn:only'].itemsPagination.hasLoadedOldest, false);
    assert.equal(desktopView(f.state()).history.complete, false);
    assert.equal(desktopView({ ...f.state(), turns: [] }).history.complete, false);
    assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});

test('native complete-history performs a real complete read and returns revision only after the complete snapshot', async () => {
  const f = await fixture({ data: [turn('latest', 2)], nextCursor: 'older' });
  try {
    await f.resume();
    const requestId = f.native('thread-follower-load-complete-history');
    await until(() => f.reads.length === 1, 'native full read');
    assert.deepEqual(f.reads[0].params, { threadId, includeTurns: true });
    assert.equal(f.replyFor(requestId), undefined);
    assert.equal(f.state().turnHistory.history.isComplete, false);
    // Legacy complete-read responses can omit itemsView; includeTurns:true is
    // their full-history contract. No GiB is allocated in this isolated test.
    const full = [turn('older', 1, 'full'), turn('latest', 2, 'full')].map(({ itemsView, ...t }) => t);
    f.fullRead({ thread: { ...f.metadata, turns: full } });
    await until(() => f.replyFor(requestId), 'native revision response');
    const reply = f.replyFor(requestId);
    assert.equal(reply.resultType, 'success');
    const snapshot = f.snapshots().find(s => s.params.change.revision === reply.result.revision);
    assert.ok(snapshot);
    assert.ok(f.frames.indexOf(snapshot) < f.frames.indexOf(reply));
    const state = snapshot.params.change.conversationState;
    assert.equal(state.turnHistory.history.isComplete, true);
    assert.equal(state.turnsPagination.hasLoadedOldest, true);
    assert.ok(state.turns.every(t => t.itemsPagination.hasLoadedOldest));
    assert.deepEqual(state.turns.map(t => t.turnId), ['older', 'latest']);
  } finally { await f.close(); }
});

test('failed native complete read cannot acknowledge a known partial baseline', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: 'older' });
  try {
    await f.resume(); f.failRead();
    const requestId = f.native('thread-follower-load-complete-history');
    await until(() => f.replyFor(requestId), 'native error response');
    assert.equal(f.replyFor(requestId).resultType, 'error');
    assert.equal(f.state().turnHistory.history.isComplete, false);
  } finally { await f.close(); }
});

test('authoritative full history with empty items replaces a prior display summary', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: 'older' });
  try {
    await f.resume();
    const requestId = f.native('thread-follower-load-complete-history');
    await until(() => f.reads.length === 1, 'native full read');
    f.fullRead({ thread: { ...f.metadata, turns: [{ id: 'latest', startedAt: 1,
      status: 'completed', itemsView: 'full', items: [] }] } });
    await until(() => f.replyFor(requestId), 'native full-history response');
    assert.equal(f.replyFor(requestId).resultType, 'success');
    assert.equal(f.state().turns[0].items.length, 0);
    assert.equal(f.state().turnHistory.history.entitiesByKey['turn:latest'].items.length, 0);
    assert.equal(f.state().turns[0].itemsPagination.hasLoadedOldest, true);
  } finally { await f.close(); }
});

test('an explicitly partial full-read response cannot be relabeled complete', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: 'older' });
  try {
    await f.resume();
    const requestId = f.native('thread-follower-load-complete-history');
    await until(() => f.reads.length === 1, 'native full read');
    f.fullRead({ thread: { ...f.metadata, turns: [turn('latest')] } });
    await until(() => f.replyFor(requestId), 'native partial-read rejection');
    assert.equal(f.replyFor(requestId).resultType, 'error');
    assert.equal(f.state().turnHistory.history.isComplete, false);
    assert.equal(f.state().turns[0].itemsPagination.hasLoadedOldest, false);
  } finally { await f.close(); }
});

test('live updates, native approval and queued follow-ups retain the partial baseline', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: 'older' });
  try {
    await f.resume();
    f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', status: 'inProgress', items: [] } } });
    f.notify({ id: 'approval-1', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'active', itemId: 'command-1', command: 'true' } });
    await until(() => f.state().requests.some(r => r.id === 'approval-1'), 'approval request');
    const approval = f.native('thread-follower-command-approval-decision', { requestId: 'approval-1', decision: 'accept' });
    await until(() => f.replyFor(approval), 'approval response');
    assert.equal(f.replyFor(approval).resultType, 'success');
    assert.deepEqual(f.rawResponses.find(r => r.id === 'approval-1'), { id: 'approval-1', result: { decision: 'accept' } });
    const queue = f.native('thread-follower-set-queued-follow-ups-state', { state: { [threadId]: [{ id: 'queued-1', text: 'next' }] } });
    await until(() => f.replyFor(queue), 'queue response');
    assert.ok(f.frames.some(m => m.method === 'thread-queued-followups-changed' && m.params.messages[0]?.id === 'queued-1'));
    assert.equal(f.requests.some(r => r.method === 'turn/start'), false);
    f.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'active', status: 'completed', items: [] } } });
    await until(() => f.requests.some(r => r.method === 'turn/start'), 'queued follow-up dispatch');
    assert.deepEqual(f.requests.find(r => r.method === 'turn/start').params.input, [{ type: 'text', text: 'next' }]);
    await until(() => f.frames.some(m => m.method === 'thread-queued-followups-changed' && m.params.messages.length === 0), 'drained queue broadcast');
    const initialRevision = f.snapshots()[0].params.change.revision;
    await until(() => f.frames.some(m => m.method === 'thread-stream-state-changed' && m.params.change.revision > initialRevision), 'live broadcast');
    const state = f.state();
    assert.equal(state.turnHistory.history.isComplete, false);
    assert.equal(state.turnsPagination.olderCursor, 'older');
    assert.equal(state.turns.find(t => t.turnId === 'latest').itemsPagination.hasLoadedOldest, false);
    assert.equal(f.reads.length, 0);
  } finally { await f.close(); }
});
