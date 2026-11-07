import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const deviceId = '11111111-1111-4111-8111-111111111111';
const hostId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';

test('archive and delete release the writer before touching the thread', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  const calls = [];
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    allowInsecureForTests: true,
    ownerRouter: { localOwner: { async request(method, params) { calls.push([method, params]); return {}; } } },
    listThreads: async () => ({ projects: [], recent: [] }),
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
    assert.deepEqual(calls, [['thread/unsubscribe', { threadId }], ['thread/archive', { threadId }]]);

    calls.length = 0;
    socket.send(JSON.stringify({ type: 'thread-action', id: 'a2', deviceId, conversationId: threadId, action: 'delete' }));
    assert.equal((await waitFor('a2')).status, 'accepted');
    assert.deepEqual(calls, [['thread/unsubscribe', { threadId }], ['thread/delete', { threadId }]]);

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
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    allowInsecureForTests: true,
    ownerRouter: { localOwner: { async request(method) { if (method === 'thread/delete') throw Object.assign(new Error('denied'), { code: 'unavailable' }); return {}; } } },
    listThreads: async () => ({ projects: [], recent: [] }),
  });
  connector.start();
  const [socket] = await incoming;
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  try {
    socket.send(JSON.stringify({ type: 'thread-action', id: 'b1', deviceId, conversationId: threadId, action: 'delete' }));
    for (let attempt = 0; attempt < 100 && !messages.some(message => message.id === 'b1'); attempt++) await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(messages.find(message => message.id === 'b1')?.status, 'unavailable');
  } finally { await connector.close(); server.close(); }
});
