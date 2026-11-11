import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const history = { id: threadId, title: 'Recorded', turns: [], requests: [], runtimeStatus: 'unknown', history: { readOnly: true } };
const live = { id: threadId, title: 'Live', turns: [], threadRuntimeStatus: { type: 'idle' } };

async function fixture({ read = () => history, ready = false, canRecoverHistory, ownerRouter } = {}) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  const session = new EventEmitter();
  let reads = 0, writes = 0;
  const readStarted = Promise.withResolvers();
  session.conversationId = threadId;
  session.status = 'connecting';
  session.start = () => { if (ready) publishReady(); };
  session.close = async () => { session.status = 'closed'; };
  session.sendText = async () => { writes++; };
  function publishReady() {
    session.status = 'ready'; session.value = live; session.revision = 1;
    session.emit('state', { status: 'ready', value: live, revision: 1 });
  }
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), hostId: 'test-host', allowInsecureForTests: true,
    createSession: () => session,
    readHistory(id) { reads++; readStarted.resolve(); assert.equal(id, threadId); return read(); },
    ...(canRecoverHistory ? { canRecoverHistory } : {}), ...(ownerRouter ? { ownerRouter } : {}),
  });
  connector.start();
  const [peer] = await incoming;
  const messages = [], waiters = new Set();
  peer.on('message', raw => {
    const message = JSON.parse(raw); messages.push(message);
    for (const waiter of waiters) if (waiter.matches(message)) { clearTimeout(waiter.timer); waiters.delete(waiter); waiter.resolve(message); }
  });
  const send = message => peer.send(JSON.stringify(message));
  const next = matches => {
    const found = messages.find(matches);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const waiter = { matches, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error('Stream event did not arrive while owner discovery was pending')); }, 1000) };
      waiters.add(waiter);
    });
  };
  const open = () => send({ type: 'request', id: 'view', deviceId, path: `/api/threads/${threadId}/events`, historyWindow: true });
  return { session, messages, send, next, open, publishReady, readStarted: readStarted.promise, reads: () => reads, writes: () => writes,
    async close() { for (const waiter of waiters) clearTimeout(waiter.timer); await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); } };
}

for (const permitted of [true, false]) test(`recovery ${permitted ? 'attaches' : 'rejects'} from fresh scoped metadata while recorded history is still loading`, async () => {
  const pending = Promise.withResolvers();
  let routes = 0, checkedOptions;
  const journal = { listThreadIds: () => [threadId], beginRecoveryAttempt: () => ({ inserted: true }), finishRecoveryAttempt: () => true };
  const f = await fixture({ read: () => pending.promise,
    canRecoverHistory(id, options) { assert.equal(id, threadId); checkedOptions = options; return permitted; },
    ownerRouter: { journal, route: async () => { routes++; }, isRecoveryLocked: () => false },
  });
  try {
    f.open(); await f.readStarted;
    f.send({ type: 'recover-chat', id: 'recover', deviceId, conversationId: threadId, requestId: '33333333-3333-4333-8333-333333333333' });
    const reply = await f.next(message => message.id === 'recover');
    assert.equal(reply.status, permitted ? 'accepted' : 'unavailable');
    assert.equal(routes, permitted ? 1 : 0);
    assert.deepEqual(checkedOptions, { phoneThreadIds: [threadId] });
    assert.equal(f.reads(), 1, 'recovery must not start a second message scan');
    assert.equal(f.session.status, 'connecting', 'metadata permission must not masquerade as a live snapshot');
  } finally { pending.resolve(history); await f.close(); }
});

test('recorded history arrives before owner discovery settles and cannot authorize a write', async () => {
  const f = await fixture();
  try {
    f.open();
    const event = await f.next(message => message.id === 'view' && message.event === 'history');
    assert.deepEqual(event.data.conversation, history);
    assert.equal(f.session.status, 'connecting', 'no live snapshot or unavailable event was needed');
    assert.equal(f.reads(), 1);
    f.send({ type: 'write', id: 'write', deviceId, conversationId: threadId, text: 'must not send' });
    assert.equal((await f.next(message => message.id === 'write')).status, 'unavailable');
    assert.equal(f.writes(), 0);
  } finally { await f.close(); }
});

test('unavailable notifications reuse the startup read and a live snapshot supersedes its late result', async () => {
  const pending = Promise.withResolvers();
  const f = await fixture({ read: () => pending.promise });
  try {
    f.open(); await f.readStarted;
    for (let index = 0; index < 5; index++) { f.session.status = 'unavailable'; f.session.emit('state', { status: 'unavailable' }); }
    assert.equal(f.reads(), 1, 'a discovery retry must not launch overlapping history scans');
    f.publishReady();
    assert.equal((await f.next(message => message.event === 'state')).data.conversation.title, 'Live');
    pending.resolve(history); await delay(20);
    assert.equal(f.messages.some(message => message.event === 'history'), false, 'late recorded data must never replace a live snapshot');
    assert.equal(f.reads(), 1);
  } finally { pending.resolve(history); await f.close(); }
});

for (const action of ['cancel', 'device-revoked']) test(`${action} prevents an in-flight initial history read from reaching the former viewer`, async () => {
  const pending = Promise.withResolvers();
  const f = await fixture({ read: () => pending.promise });
  try {
    f.open(); await f.readStarted;
    f.send({ type: action, id: 'view', deviceId });
    f.send({ type: 'flow-probe' }); await f.next(message => message.type === 'capabilities');
    pending.resolve(history); await delay(20);
    assert.equal(f.session.status, 'closed');
    assert.equal(f.messages.some(message => message.event === 'history'), false);
  } finally { pending.resolve(history); await f.close(); }
});

test('an immediately available live snapshot avoids reading recorded history', async () => {
  const f = await fixture({ ready: true });
  try {
    f.open();
    assert.equal((await f.next(message => message.event === 'state')).data.conversation.title, 'Live');
    assert.equal(f.reads(), 0);
    assert.equal(f.messages.some(message => message.event === 'history'), false);
  } finally { await f.close(); }
});
