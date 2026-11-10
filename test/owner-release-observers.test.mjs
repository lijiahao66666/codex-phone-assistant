import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';

const first = '11111111-1111-4111-8111-111111111111';
const second = '22222222-2222-4222-8222-222222222222';
const device = '33333333-3333-4333-8333-333333333333';
async function until(predicate) {
  const end = Date.now() + 2000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Observer did not settle'); await delay(5); }
}

test('a release invalidates only its conversation observers and removes its connector listener on close', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const owner = new EventEmitter(), sessions = new Map(), invalidated = [];
  const sidebar = new EventEmitter();
  sidebar.invalidateThread = id => invalidated.push(id);
  sidebar.close = async () => {};
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`,
    secret: 'x'.repeat(32), allowInsecureForTests: true, ownerRouter: { localOwner: owner }, sidebarStatusForTests: sidebar,
    createSession({ conversationId }) {
      const session = new EventEmitter();
      Object.assign(session, { conversationId, status: 'syncing', released: 0 });
      session.start = () => {};
      session.close = async () => {};
      session.ownershipReleased = () => { session.released++; };
      sessions.set(conversationId, session); return session;
    },
    readHistory: async () => ({ turns: [] }),
  });
  const connected = once(server, 'connection'); connector.start(); const [peer] = await connected;
  try {
    for (const [index, id] of [first, second].entries()) {
      peer.send(JSON.stringify({ type: 'request', id: `stream-${index}`, deviceId: device, path: `/api/threads/${id}/events` }));
    }
    await until(() => sessions.size === 2);
    owner.emit('threadReleased', first);
    assert.equal(sessions.get(first).released, 1, 'even a returning viewer awaiting its first snapshot must rebind');
    assert.equal(sessions.get(second).released, 0, 'another running/viewed task is undisturbed');
    assert.deepEqual(invalidated, [first]);
    assert.equal(owner.listenerCount('threadReleased'), 1);
    await connector.close();
    assert.equal(owner.listenerCount('threadReleased'), 0);
  } finally {
    await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve));
  }
});

test('a session retries its retired owner and rejects snapshots from the old generation', async () => {
  const clients = [];
  const session = new DesktopSession({ conversationId: first, retryBaseMs: 1, retryMaxMs: 1,
    createClient() {
      const client = new EventEmitter();
      client.connect = async () => {};
      client.subscribe = async (_id, listener) => { client.listener = listener; };
      client.close = async () => { client.closed = true; };
      clients.push(client); return client;
    } });
  const snapshot = (client, owner, revision) => client.listener({ type: 'snapshot', revision,
    conversationState: { id: first, turns: [], threadRuntimeStatus: { type: 'idle' } } }, { ownerId: owner });
  try {
    session.start(); await until(() => clients[0]?.listener);
    snapshot(clients[0], 'phone-owner', 1);
    assert.equal(session.status, 'ready');
    session.ownershipReleased();
    assert.equal(session.status, 'unavailable');
    assert.equal(session.value, null);
    snapshot(clients[0], 'phone-owner', 2);
    assert.equal(session.status, 'unavailable', 'a delayed old-owner snapshot cannot restore ready');
    await until(() => clients[1]?.listener);
    assert.equal(clients[0].closed, true);
    snapshot(clients[1], 'desktop-owner', 1);
    assert.equal(session.status, 'ready');
    assert.equal(session.conversation.ownerId, 'desktop-owner');
    await session.close(); session.ownershipReleased();
    assert.equal(session.status, 'closed');
  } finally { await session.close(); }
});
