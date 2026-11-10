import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const thread = '11111111-1111-4111-8111-111111111111', device = '22222222-2222-4222-8222-222222222222';

test('idle disconnected connector can shut down without waiting for reconnect', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), allowInsecureForTests: true, retryMs: 60000 });
  const connected = once(server, 'connection'); connector.start(); const [peer] = await connected;
  const closed = once(peer, 'close'); peer.terminate(); await closed; await new Promise(resolve => setTimeout(resolve, 30));
  try { await connector.beginShutdown(); } finally { await connector.close(); await new Promise(resolve => server.close(resolve)); }
});

test('shutdown blocks while an admitted write runs even after its reply is cancelled', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const hold = new Promise(resolve => { release = resolve; });
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), allowInsecureForTests: true,
    createSession() { const s = new EventEmitter(); s.status = 'ready'; s.revision = 1; s.conversation = { ownerId: 'owner' }; s.value = { id: thread, turns: [] }; s.start = () => s.emit('state', { status: 'ready', value: s.value, revision: 1 }); s.close = async () => {}; s.sendText = async () => { entered(); await hold; }; return s; } });
  const connected = once(server, 'connection'); connector.start(); const [peer] = await connected;
  const waiters = new Map(); peer.on('message', raw => { const m = JSON.parse(raw); waiters.get(m.id)?.(m); });
  const request = message => new Promise(resolve => { waiters.set(message.id, resolve); peer.send(JSON.stringify(message)); });
  try {
    await request({ type: 'request', id: 'stream', deviceId: device, path: `/api/threads/${thread}/events` });
    peer.send(JSON.stringify({ type: 'write', id: 'write', deviceId: device, conversationId: thread, text: 'test' })); await started;
    peer.send(JSON.stringify({ type: 'cancel-reply', id: 'write' }));
    await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(connector.beginShutdown(), { code: 'tasks-active' });
    release();
    await new Promise(resolve => setTimeout(resolve, 20));
    await connector.beginShutdown();
    const blocked = await request({ type: 'write', id: 'blocked', deviceId: device, conversationId: thread, text: 'test' });
    assert.equal(blocked.status, 'unavailable');
    connector.cancelShutdown();
    const admitted = await request({ type: 'approve', id: 'after', deviceId: device, conversationId: thread, requestId: 'x', kind: 'command', decision: 'accept' });
    assert.notEqual(admitted.id, 'blocked');
  } finally { release(); await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); }
});

test('shutdown blocks across upload chunks and releases after cancellation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'connector-shutdown-'));
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const host = '33333333-3333-4333-8333-333333333333';
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), hostId: host, imageUpload: true, uploadRoot: root, allowInsecureForTests: true });
  const connected = once(server, 'connection'); connector.start(); const [peer] = await connected;
  const waiters = new Map(); peer.on('message', raw => { const m = JSON.parse(raw); waiters.get(m.id)?.(m); });
  const request = message => new Promise(resolve => { waiters.set(message.id, resolve); peer.send(JSON.stringify(message)); });
  try {
    const start = await request({ type: 'upload', action: 'start', id: 'start', deviceId: device, conversationId: thread, name: 'test.txt', size: 4, kind: 'file' });
    assert.equal(start.ok, true); await assert.rejects(connector.beginShutdown(), { code: 'tasks-active' });
    const chunk = await request({ type: 'upload', action: 'chunk', id: 'chunk', deviceId: device, conversationId: thread, uploadId: start.data.uploadId, seq: 0, data: Buffer.from('test').toString('base64') });
    assert.equal(chunk.ok, true); await assert.rejects(connector.beginShutdown(), { code: 'tasks-active' });
    const finish = await request({ type: 'upload', action: 'finish', id: 'finish', deviceId: device, conversationId: thread, uploadId: start.data.uploadId });
    assert.equal(finish.ok, true); await assert.rejects(connector.beginShutdown(), { code: 'tasks-active' });
    const removed = await request({ type: 'upload', action: 'delete', id: 'delete', deviceId: device, conversationId: thread, uploadId: finish.data.attachmentId });
    assert.equal(removed.ok, true); await connector.beginShutdown(); connector.cancelShutdown();
  } finally { await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); await rm(root, { recursive: true, force: true }); }
});
