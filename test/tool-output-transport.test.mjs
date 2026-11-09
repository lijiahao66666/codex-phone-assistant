import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { createHash } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const otherDevice = '33333333-3333-4333-8333-333333333333';
const digest = value => createHash('sha256').update(value).digest('hex');
const output = 'x'.repeat(16383) + '😀' + '终端输出\n'.repeat(5000);
const command = (id = 'command', aggregatedOutput = output) => ({ id, type: 'commandExecution', command: 'printf fixture', aggregatedOutput, status: 'completed', exitCode: 0, durationMs: 12 });
const value = () => ({ id: threadId, resumeState: 'resumed', turns: [0, 1, 2, 3].map(i => ({ turnId: `turn-${i}`, status: 'completed', items: [command()] })) });

async function fixture(t, initial = value()) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); await once(server, 'listening');
  const sessions = [];
  const connection = once(server, 'connection');
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 'x'.repeat(32), hostId: 'test-host', allowInsecureForTests: true,
    createSession() {
      const session = new EventEmitter(); session.status = 'ready'; session.value = structuredClone(initial); session.revision = 1; session.conversation = { ownerId: 'owner' };
      session.start = () => session.emit('state', { status: session.status, value: session.value, revision: session.revision });
      session.close = async () => { session.closed = true; }; sessions.push(session); return session;
    },
  });
  connector.start(); const [peer] = await connection;
  const waiters = new Set(); let requestId = 0;
  peer.on('message', raw => { const message = JSON.parse(raw); for (const waiter of waiters) if (waiter.match(message)) { waiters.delete(waiter); clearTimeout(waiter.timer); waiter.resolve(message); } });
  const request = (message, match = m => m.id === message.id && m.type === 'response') => new Promise((resolve, reject) => { const waiter = { match, resolve, timer: setTimeout(() => { waiters.delete(waiter); reject(new Error(`timeout: ${message.id}`)); }, 5000) }; waiters.add(waiter); peer.send(JSON.stringify(message)); });
  const open = (id, flags = {}) => request({ type: 'request', id, deviceId, path: `/api/threads/${threadId}/events`, ...flags }, m => m.id === id && m.event === 'state');
  const read = (fields = {}) => request({ type: 'tool-output', id: `read-${++requestId}`, deviceId, conversationId: threadId, turnKey: 'turn-3', itemId: 'command', hash: digest(output), offset: 0, ...fields });
  const cancel = async id => { peer.send(JSON.stringify({ type: 'cancel', id })); await new Promise(resolve => setTimeout(resolve, 20)); };
  t.after(async () => { for (const waiter of waiters) clearTimeout(waiter.timer); await connector.close(); peer.terminate(); await new Promise(resolve => server.close(resolve)); });
  return { sessions, peer, request, open, read, cancel };
}

test('real connector negotiates lazy output only for windowed clients and preserves history pages', async t => {
  const f = await fixture(t);
  const legacy = await f.open('legacy');
  assert.equal(legacy.data.conversation.turns.length, 4); assert.equal(legacy.data.conversation.turns[3].items[0].output, output);
  assert.equal((await f.read()).ok, false);
  await f.cancel('legacy');
  const optInWithoutWindow = await f.open('without-window', { lazyOutput: true });
  assert.equal(optInWithoutWindow.data.conversation.turns[3].items[0].output, output);
  await f.cancel('without-window');
  const windowOnly = await f.open('window-only', { historyWindow: true });
  assert.equal(windowOnly.data.conversation.turns[2].items[0].output, output);
  assert.equal((await f.read()).ok, false); await f.cancel('window-only');
  const lazy = await f.open('lazy', { historyWindow: true, lazyOutput: true });
  const view = lazy.data.conversation, item = view.turns[2].items[0];
  assert.equal(view.turns.length, 3); assert.equal('output' in item, false);
  assert.deepEqual(item.outputRef, { hash: digest(output), bytes: Buffer.byteLength(output) });
  assert.equal(item.command, 'printf fixture'); assert.equal(item.exitCode, 0); assert.equal(item.durationMs, 12); assert.equal(item.status, 'completed');
  const page = await f.request({ type: 'history-page', id: 'history', deviceId, conversationId: threadId, historicalHash: view.history.historicalHash, before: view.history.cursor });
  assert.equal(page.ok, true); assert.equal(page.data.turns[0].items[0].output, output); assert.equal('outputRef' in page.data.turns[0].items[0], false);
});

test('pages reassemble Unicode exactly, reject stale active output and invalid offsets', async t => {
  const f = await fixture(t); await f.open('lazy', { viewDelta: 3, lazyOutput: true });
  let offset = 0, recovered = '';
  do { const response = await f.read({ offset }); assert.equal(response.ok, true); assert.equal(response.data.offset, offset); assert.ok(response.data.text.length <= 16384); recovered += response.data.text; offset = response.data.nextOffset; } while (offset !== null);
  assert.equal(recovered, output);
  assert.equal((await f.read({ offset: 16384 })).ok, false); // between the emoji's surrogates
  for (const offset of [-1, 1.5, output.length + 1, '0', Number.MAX_SAFE_INTEGER + 1]) assert.equal((await f.read({ offset })).ok, false);
  f.sessions[0].value.turns[3].items[0].aggregatedOutput += 'new'; // even without an artificial revision bump
  assert.equal((await f.read()).ok, false);
  assert.equal((await f.read({ hash: digest(output + 'new') })).ok, true);
});

test('same-device ready session is required; cancelled, replaced and foreign sessions cannot serve output', async t => {
  const f = await fixture(t); await f.open('lazy', { historyWindow: true, lazyOutput: true });
  assert.equal((await f.read({ deviceId: otherDevice })).ok, false);
  f.sessions[0].status = 'unavailable'; assert.equal((await f.read()).ok, false); f.sessions[0].status = 'ready';
  await f.cancel('lazy'); assert.equal((await f.read()).ok, false);
  await f.open('replacement', { historyWindow: true, lazyOutput: true });
  const session = f.sessions[1], project = session.projectFull;
  session.projectFull = input => { const full = project(input); session.status = 'unavailable'; return full; };
  assert.equal((await f.read()).ok, false);
  session.projectFull = project; session.status = 'ready'; assert.equal((await f.read()).ok, true);
  f.peer.send(JSON.stringify({ type: 'device-revoked', deviceId }));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(session.closed, true);
});

test('ambiguous or missing turn/item identities keep full output and deny paged lookup', async t => {
  const initial = value();
  initial.turns[3].items = [command('duplicate', 'x'.repeat(5000)), command('duplicate', 'x'.repeat(5000)), command(null, 'x'.repeat(5000))];
  const f = await fixture(t, initial); const response = await f.open('lazy', { historyWindow: true, lazyOutput: true });
  for (const item of response.data.conversation.turns[2].items) { assert.equal(item.output, 'x'.repeat(5000)); assert.equal('outputRef' in item, false); }
  assert.equal((await f.read({ itemId: 'duplicate' })).ok, false);
  const session = f.sessions[0]; session.value.turns[2].turnId = 'turn-3';
  assert.equal((await f.read()).ok, false);
});

test('outputs above 4 MiB remain pageable without truncation or the historical single-turn limit', async t => {
  const large = '😀终端'.repeat(700000), initial = value();
  initial.turns[3].items[0].aggregatedOutput = large;
  const f = await fixture(t, initial); const response = await f.open('large', { historyWindow: true, lazyOutput: true });
  const ref = response.data.conversation.turns[2].items[0].outputRef;
  assert.ok(ref.bytes > 4 * 1024 * 1024); assert.equal(ref.hash, digest(large));
  const offset = large.length - 128;
  const result = await f.read({ hash: ref.hash, offset });
  assert.equal(result.ok, true); assert.equal(result.data.text, large.slice(offset)); assert.equal(result.data.nextOffset, null);
});
