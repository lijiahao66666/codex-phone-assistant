import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { fixture, threadId as localThreadId, turn, until } from './helpers/owner-history-fixture.mjs';

const deviceId = '11111111-1111-4111-8111-111111111111';
const hostId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const listed = id => ({ projects: [], recent: [{ id, title: 'fixture' }] });
const routerFor = localOwner => ({ localOwner,
  discover: async () => ({ kind: 'owner', ownerId: localOwner.ownerId() }),
  isRecoveryLocked: () => false, journal: { threadWritePending: () => false },
});
const idleOwner = methods => ({ state: 'ready', pendingWrites: 0, uncertainWrites: false,
  ownerId: () => 'fixture-helper', client: { pending: new Map() },
  owner: { isThreadOwned: () => true, canPerformThreadAction: () => true, isThreadReleasing: () => false },
  ...methods,
});

test('archive and delete use the guarded owner action without unsubscribing first', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  const calls = [];
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    allowInsecureForTests: true,
    ownerRouter: routerFor(idleOwner({
      async threadAction(id, action) { calls.push([`thread/${action}`, { threadId: id }]); return {}; },
      async request() { assert.fail('thread actions must not bypass the owner action guard'); },
    })),
    listThreads: async () => listed(threadId),
  });
  connector.start();
  const [socket] = await incoming;
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  const waitFor = async id => {
    for (let attempt = 0; attempt < 100; attempt++) {
      const found = messages.find(message => message.id === id);
      if (found) return found;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`no reply for ${id}`);
  };
  try {
    socket.send(JSON.stringify({ type: 'thread-action', id: 'a1', deviceId, conversationId: threadId, action: 'archive' }));
    assert.deepEqual(await waitFor('a1'), { type: 'response', id: 'a1', status: 'accepted' });
    assert.deepEqual(calls, [['thread/archive', { threadId }]]);

    calls.length = 0;
    socket.send(JSON.stringify({ type: 'thread-action', id: 'a2', deviceId, conversationId: threadId, action: 'delete' }));
    assert.equal((await waitFor('a2')).status, 'accepted');
    assert.deepEqual(calls, [['thread/delete', { threadId }]]);

    calls.length = 0;
    socket.send(JSON.stringify({ type: 'thread-action', id: 'a3', deviceId, conversationId: threadId, action: 'rename' }));
    assert.equal((await waitFor('a3')).status, 'unavailable');
    assert.deepEqual(calls, []);
  } finally { await connector.close(); server.close(); }
});

test('a failed owner request is reported instead of a silent success', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  const calls = [];
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    allowInsecureForTests: true,
    ownerRouter: routerFor(idleOwner({ async threadAction(id, action) {
      calls.push([id, action]);
      throw Object.assign(new Error('denied'), { code: 'unavailable' });
    } })),
    listThreads: async () => listed(threadId),
  });
  connector.start();
  const [socket] = await incoming;
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  try {
    socket.send(JSON.stringify({ type: 'thread-action', id: 'b1', deviceId, conversationId: threadId, action: 'delete' }));
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.id === 'b1'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(messages.find(message => message.id === 'b1')?.status, 'unavailable');
    assert.deepEqual(calls, [[threadId, 'delete']], 'the real action rejection, rather than an authorization failure, is reported');
  } finally { await connector.close(); server.close(); }
});

test('the production owner archives and deletes idle owned threads without a separate unsubscribe', async () => {
  for (const action of ['archive', 'delete']) {
    const f = await fixture({ data: [turn('latest')], nextCursor: null });
    try {
      await f.resume();
      const before = f.requests.length;
      await f.local.threadAction(localThreadId, action);
      assert.deepEqual(f.requests.slice(before).map(({ method, params }) => ({ method, params })), [
        { method: `thread/${action}`, params: { threadId: localThreadId } },
      ]);
    } finally { await f.close(); }
  }
});

test('thread actions never archive or delete locally running, uncertain, queued or approval-blocked work', { timeout: 10000 }, async () => {
  for (const state of ['active', 'turn', 'unknown', 'goal', 'queue', 'approval', 'pending', 'uncertain']) {
    const f = await fixture({ data: [turn('latest')], nextCursor: null }, { holdMethods: ['thread/settings/update'] });
    const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
    const listening = once(server, 'listening');
    let connector, pending;
    try {
      assert.equal(typeof f.local.threadAction, 'function', 'exercise the production owner guard');
      await f.resume();
      if (state === 'active' || state === 'unknown') {
        f.notify({ method: 'thread/status/changed', params: { threadId: localThreadId, status: { type: state === 'active' ? 'active' : 'notLoaded' } } });
        await until(() => f.state()?.threadRuntimeStatus?.type === (state === 'active' ? 'active' : 'notLoaded'), 'runtime status');
      }
      if (state === 'turn') {
        f.notify({ method: 'turn/started', params: { threadId: localThreadId, turn: { id: 'running', status: 'inProgress', items: [] } } });
        await until(() => f.state()?.turns?.some(turn => turn.id === 'running' && turn.status === 'inProgress'), 'running turn');
      }
      if (state === 'goal') {
        f.notify({ method: 'thread/goal/updated', params: { threadId: localThreadId, goal: { threadId: localThreadId, status: 'active', objective: 'ongoing' } } });
        await until(() => f.state()?.threadGoal?.status === 'active', 'active goal');
      }
      if (state === 'queue') {
        const request = f.native('thread-follower-set-queued-follow-ups-state', { state: { [localThreadId]: [{ id: 'draft', text: 'keep', pausedReason: 'user-paused' }] } });
        await until(() => f.replyFor(request), 'queued followup');
      }
      if (state === 'approval') {
        f.notify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId: localThreadId, turnId: 'latest', command: 'true' } });
        await until(() => f.state()?.requests?.some(request => request.completed !== true), 'unresolved approval');
      }
      if (state === 'pending') {
        pending = f.local.write('thread/settings/update', { threadId: localThreadId, model: 'pending' }).catch(() => {});
        await until(() => f.requests.some(request => request.method === 'thread/settings/update'), 'pending runtime mutation');
      }
      if (state === 'uncertain') f.local.uncertainWrites = true;
      await listening;
      const incoming = once(server, 'connection');
      connector = createPreviewConnector({
        url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
        allowInsecureForTests: true, ownerRouter: routerFor(f.local),
        listThreads: async () => listed(localThreadId),
      });
      connector.start();
      const [socket] = await incoming;
      const messages = [];
      socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
      const before = f.requests.length;
      for (const action of ['archive', 'delete']) {
        const id = `${state}-${action}`;
        socket.send(JSON.stringify({ type: 'thread-action', id, deviceId, conversationId: localThreadId, action }));
        await until(() => messages.some(message => message.id === id), 'guarded action response');
        assert.equal(messages.find(message => message.id === id).status, 'unavailable', `${state}: ${action}`);
      }
      assert.equal(f.requests.length, before, `${state}: blocked controls must not reach the CLI`);
      assert.equal(f.local.owner.isThreadOwned(localThreadId), true, `${state}: writer remains owned`);
    } finally {
      await connector?.close(); await new Promise(resolve => server.close(resolve)); await f.close(); await pending;
    }
  }
});
