import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { once } from 'node:events';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const deviceId = '11111111-1111-4111-8111-111111111111';
const hostId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';

for (const revokeAgain of [false, true]) test(`connector waits for cleanup and ${revokeAgain ? 'a later revocation wins' : 'then accepts restored requests'}`, { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  let releaseCleanup, cleanupStarted;
  const cleaning = new Promise(resolve => { cleanupStarted = resolve; });
  const gate = new Promise(resolve => { releaseCleanup = resolve; });
  let listCalls = 0, ownerCalls = 0;
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    imageUpload: true, allowInsecureForTests: true,
    ownerRouter: { creationStatus() { ownerCalls++; return { status: 'none' }; } },
    createUploadContext: async () => ({
      receiver: { start() { return 'upload-id'; }, async cancel() { cleanupStarted(); await gate; }, async close() {} },
      store: { async close() {} },
    }),
    listThreads: async () => { listCalls++; return { projects: [], recent: [] }; },
  });
  connector.start();
  const [socket] = await incoming;
  const messages = [], waiters = [];
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString()); messages.push(message);
    for (const waiter of [...waiters]) if (waiter.matches(message)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(message); }
  });
  const next = matches => new Promise(resolve => { const found = messages.find(matches); if (found) resolve(found); else waiters.push({ matches, resolve }); });
  const send = message => socket.send(JSON.stringify(message));
  const request = id => send({ type: 'request', id, deviceId, path: '/api/threads' });
  const ownerRequest = id => send({ type: 'creation-status', id, deviceId, requestId: threadId });
  try {
    send({ type: 'upload', id: 'start-upload', action: 'start', hostId, deviceId, conversationId: threadId, name: 'test.txt', size: 3, kind: 'file' });
    assert.equal((await next(m => m.id === 'start-upload')).ok, true);
    send({ type: 'device-revoked', deviceId });
    await cleaning;
    send({ type: 'device-restored', deviceId });
    request('during-cleanup');
    ownerRequest('owner-during-cleanup');
    if (revokeAgain) send({ type: 'device-revoked', deviceId });
    send({ type: 'flow-probe' });
    await next(m => m.type === 'capabilities');
    assert.equal(listCalls, 0); // A new request cannot run while old files are removed.
    assert.equal(ownerCalls, 0);
    releaseCleanup();
    if (!revokeAgain) {
      assert.equal((await next(m => m.id === 'during-cleanup')).ok, true);
      assert.equal((await next(m => m.id === 'owner-during-cleanup')).ok, true);
      assert.equal(listCalls, 1);
      assert.equal(ownerCalls, 1);
    } else {
      // A fresh restoration after the second revoke can proceed; the stale
      // request waiting on the first restoration must never resume.
      send({ type: 'device-restored', deviceId });
      request('after-second-restore');
      ownerRequest('owner-after-second-restore');
      assert.equal((await next(m => m.id === 'after-second-restore')).ok, true);
      assert.equal((await next(m => m.id === 'owner-after-second-restore')).ok, true);
      assert.equal(listCalls, 1);
      assert.equal(ownerCalls, 1);
      assert.equal(messages.some(m => m.id === 'during-cleanup'), false);
      assert.equal(messages.some(m => m.id === 'owner-during-cleanup'), false);
    }
  } finally {
    releaseCleanup(); await connector.close();
    await new Promise(resolve => server.close(resolve));
  }
});
