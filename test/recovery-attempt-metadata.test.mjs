import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

test('connector reports scoped execution tracking without exposing identities or changing accepted records', { timeout: 5000 }, async () => {
  const hostId = randomUUID(), deviceId = randomUUID(), threadId = randomUUID();
  const journal = new CreationJournal(':memory:');
  const unbound = randomUUID(), tracked = randomUUID();
  for (const request of [unbound, tracked]) {
    journal.beginRecoveryAttempt(hostId, deviceId, threadId, request);
    journal.finishRecoveryAttempt(hostId, deviceId, threadId, request, 'accepted');
  }
  journal.db.prepare('UPDATE recovery_attempts SET execution_id=?,execution_pid=?,execution_started=? WHERE request_id=?').run('private-instance', 12345, 'private-start', tracked);
  const before = journal.db.prepare('SELECT * FROM recovery_attempts').all();
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  let started;
  const sessionStarted = new Promise(resolve => { started = resolve; });
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId, allowInsecureForTests: true,
    ownerRouter: { journal, isRecoveryLocked: () => false, async route() { throw new Error('cancelled attempt must never reach route'); } },
    createSession: ({ conversationId }) => Object.assign(new EventEmitter(), { conversationId, start() { started(); }, async close() {} }),
  });
  connector.start();
  const [socket] = await incoming;
  const waiters = new Map();
  socket.on('message', raw => { const message = JSON.parse(raw); const resolve = waiters.get(message.id); if (resolve) { waiters.delete(message.id); resolve(message); } });
  const query = (request, device = deviceId) => new Promise(resolve => {
    const id = randomUUID(); waiters.set(id, resolve);
    socket.send(JSON.stringify({ type: 'request', id, deviceId: device, path: `/api/threads/${threadId}/recovery-attempt/${request}` }));
  });
  const command = value => new Promise(resolve => {
    const id=randomUUID();waiters.set(id,resolve);socket.send(JSON.stringify({id,deviceId,...value}));
  });
  try {
    socket.send(JSON.stringify({ type: 'request', id: 'stream', deviceId, path: `/api/threads/${threadId}/events` }));
    await sessionStarted;
    assert.deepEqual((await query(unbound)).data, { status: 'accepted', locked: false, executionTracked: false });
    const attributed = await query(tracked);
    assert.deepEqual(attributed.data, { status: 'accepted', locked: false, executionTracked: true });
    assert.doesNotMatch(JSON.stringify(attributed), /private-instance|private-start|12345/);
    assert.deepEqual((await query(randomUUID())).data, { status: 'missing', locked: false, executionTracked: null });
    assert.equal((await query(unbound, randomUUID())).ok, false);
    assert.deepEqual(journal.db.prepare('SELECT * FROM recovery_attempts').all(), before);
    const unseen=randomUUID();
    assert.equal((await query(unseen)).data.status,'missing');
    assert.equal((await command({type:'cancel-unseen-recovery',conversationId:threadId,requestId:unseen})).status,'accepted');
    assert.deepEqual((await query(unseen)).data,{status:'cancelled',locked:false,executionTracked:false});
    assert.equal((await command({type:'recover-chat',conversationId:threadId,requestId:unseen})).status,'unavailable');
    assert.equal(journal.recoveryAttempt(hostId,deviceId,threadId,unseen),'cancelled');
    assert.equal(journal.recoveryPending(hostId,threadId),false);
  } finally {
    await connector.close(); await new Promise(resolve => server.close(resolve)); journal.close();
  }
});
