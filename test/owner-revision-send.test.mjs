import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

const deviceId = '22222222-2222-4222-8222-222222222222';

test('a resumed local owner accepts a new send while retaining same-revision protection', { timeout: 10000 }, async () => {
  const owner = await fixture({ data: [turn('latest')], nextCursor: 'older' }, { graceMs: 30 });
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  let snapshot, sent = 0;
  const connection = once(server, 'connection');
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), hostId: 'test-host', allowInsecureForTests: true,
    createSession() {
      const session = new EventEmitter();
      session.status = 'ready'; session.revision = snapshot.params.change.revision;
      session.conversation = { ownerId: snapshot.sourceClientId };
      session.value = snapshot.params.change.conversationState;
      session.start = () => session.emit('state', { status: 'ready', value: session.value, revision: session.revision });
      session.sendText = async () => { sent++; };
      session.close = async () => {};
      return session;
    },
  });
  connector.start();
  const [peer] = await connection;
  const waiters = new Set();
  peer.on('message', raw => {
    const message = JSON.parse(raw);
    for (const waiter of waiters) if (waiter.match(message)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message); }
  });
  const request = (message, match) => new Promise((resolve, reject) => {
    const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout: ${message.id}`)); }, 5000) };
    waiters.add(waiter); peer.send(JSON.stringify(message));
  });
  const open = id => request({ type: 'request', id, deviceId, path: `/api/threads/${threadId}/events` }, m => m.id === id && m.event === 'state');
  const write = id => request({ type: 'write', id, deviceId, conversationId: threadId, text: id }, m => m.id === id && m.type === 'response');
  try {
    await owner.resume();
    owner.follower(true);
    const count = owner.snapshots().length;
    await until(() => owner.snapshots().length > count, 'follower snapshot');
    snapshot = owner.snapshots().at(-1);
    await open('first-stream');
    assert.equal((await write('first')).status, 'accepted');
    assert.equal((await write('duplicate-revision')).status, 'unavailable');
    peer.send(JSON.stringify({ type: 'cancel', id: 'first-stream' }));
    owner.follower(false);
    await until(() => owner.requests.some(r => r.method === 'thread/unsubscribe'), 'unsubscribe dispatch');
    owner.reply(owner.requests.find(r => r.method === 'thread/unsubscribe'), { status: 'unsubscribed' });
    await until(() => owner.local.releasedThreads.has(threadId), 'acknowledged release');
    const beforeResume = owner.snapshots().length;
    await owner.local.resume(threadId);
    await until(() => owner.snapshots().length > beforeResume, 'resumed snapshot');
    const resumed = owner.snapshots().at(-1);
    assert.equal(typeof snapshot.sourceClientId, 'string');
    assert.equal(resumed.sourceClientId, snapshot.sourceClientId);
    assert.ok(resumed.params.change.revision > snapshot.params.change.revision);
    snapshot = resumed;
    await open('resumed-stream');
    assert.equal((await write('after-resume')).status, 'accepted');
    assert.equal(sent, 2);
  } finally {
    await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve));
    await owner.close();
  }
});
