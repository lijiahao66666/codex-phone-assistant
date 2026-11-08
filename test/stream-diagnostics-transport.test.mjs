import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:net';
import os from 'node:os';
import { join } from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairRelay } from '../src/relay/server.mjs';
import { StateChunkAssembler } from '../public/state-chunks.mjs';

// Isolate connector diagnostics from the installed helper's actual bridge log.
const directory = await mkdtemp(join(os.tmpdir(), 'hub-stream-diagnostics-'));
const originalHomedir = os.homedir;
let createPreviewConnector;
try {
  os.homedir = () => directory; syncBuiltinESMExports();
  ({ createPreviewConnector } = await import('../src/transport/preview-connector.mjs'));
} finally { os.homedir = originalHomedir; syncBuiltinESMExports(); }
after(() => rm(directory, { recursive: true, force: true }));
const threadId = '33333333-3333-4333-8333-333333333333';
const waitFor = async check => { for (let i = 0; i < 100; i++) { if (await check()) return; await delay(10); } assert.fail('diagnostic condition timed out'); };
const connectorRows = async () => (await readFile(join(directory, '.codex-phone', 'bridge.log'), 'utf8')).split('\n').filter(line => line.includes(' stream timing ')).map(line => JSON.parse(line.split(' stream timing ')[1]));

for (const mode of ['legacy', 'modern', 'chunked']) test(`${mode} stream correlates relay and connector diagnostics without changing state or leaking content`, { timeout: 15000 }, async () => {
  const relayRows = [], originalInfo = console.info;
  console.info = (...args) => { if (args[0] === 'stream-timing') relayRows.push(JSON.parse(args[1])); else originalInfo(...args); };
  const reservation = createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin });
  let connector, reader, control;
  const sessions = [];
  try {
    await relay.listen(port); const base = `http://127.0.0.1:${port}`;
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
    const host = await (await post('/api/enroll', { name: 'diagnostic-test' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const text = mode === 'chunked' ? 'PRIVATE MESSAGE '.repeat(600000) : 'PRIVATE MESSAGE';
    connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, secret: host.secret, hostId: host.hostId, allowInsecureForTests: true,
      createSession() {
        const session = new EventEmitter();
        session.status = 'ready'; session.revision = 1;
        session.value = { id: threadId, title: 'PRIVATE TITLE', resumeState: 'resumed', turnsPagination: { hasLoadedOldest: true }, threadRuntimeStatus: { type: 'idle' },
          turns: [{ turnId: 'private-turn', status: 'completed', items: [{ id: 'private-item', type: 'agentMessage', text }] }] };
        session.start = () => session.emit('state', { status: 'ready', value: session.value, revision: 1 });
        session.close = async () => { session.closed = true; };
        sessions.push(session); return session;
      } });
    connector.start();
    await waitFor(async () => (await (await fetch(base + '/api/host-status', { headers: { ...headers, cookie } })).json()).online);
    control = new AbortController();
    const response = await fetch(base + `/api/threads/${threadId}/events`, { headers: { ...headers, cookie, ...(mode === 'legacy' ? {} : { 'x-codex-view-delta': '3', 'x-codex-history-window': '1' }) }, signal: control.signal });
    assert.equal(response.status, 200);
    const streamId = response.headers.get('x-codex-stream-id');
    assert.match(streamId, /^[0-9a-f-]{36}$/);
    assert.notEqual(streamId, threadId);
    reader = response.body.getReader();
    const decoder = new TextDecoder(), assembler = new StateChunkAssembler();
    let pending = '', result;
    while (!result) {
      const { value, done } = await reader.read(); assert.equal(done, false);
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n\n')) !== -1) {
        const block = pending.slice(0, end); pending = pending.slice(end + 2);
        const type = /^event:\s*(.+)$/m.exec(block)?.[1], data = /^data:\s*(.+)$/m.exec(block)?.[1];
        if (!data) continue;
        if (type === 'state') result = JSON.parse(data).conversation;
        if (type === 'state-chunk') { const assembled = await assembler.accept(JSON.parse(data)); if (assembled) result = assembled.value.data.conversation; }
        assert.notEqual(type, 'stream-error');
      }
    }
    assert.equal(result.id, threadId);
    assert.equal(result.turns[0].items[0].text, text);
    control.abort(); await reader.cancel().catch(() => {});
    await waitFor(async () => relayRows.some(row => row.streamId === streamId && row.stage === 'closed') && (await connectorRows()).some(row => row.streamId === streamId && row.stage === 'closed'));
    const rows = (await connectorRows()).filter(row => row.streamId === streamId), relayTiming = relayRows.filter(row => row.streamId === streamId);
    assert.ok(rows.some(row => row.stage === 'first-ready'));
    const encoded = rows.find(row => row.stage === 'first-encoded');
    assert.equal(encoded.chunked, mode === 'chunked');
    assert.ok(encoded.bytes > 0);
    assert.ok(encoded.projectMs >= 0); assert.ok(encoded.encodeMs >= 0);
    assert.equal(relayTiming.find(row => row.stage === 'first-received').chunked, mode === 'chunked');
    for (const set of [rows, relayTiming]) {
      assert.ok(set.length <= 9);
      assert.equal(new Set(set.map(row => row.stage)).size, set.length);
      assert.equal(set.at(-1).stage, 'closed');
      assert.doesNotMatch(JSON.stringify(set), /PRIVATE|private-|33333333|deviceId|hostId|conversationId|title|payload|path/);
      for (let i = 1; i < set.length; i++) assert.ok(set[i].elapsedMs >= set[i - 1].elapsedMs);
      if (mode === 'chunked') { assert.ok(set.some(row => row.stage === 'chunk-begin')); assert.ok(set.some(row => row.stage === 'chunk-end')); }
    }
    sessions[0].emit('state', { status: 'ready', value: sessions[0].value, revision: 2 });
    await delay(5);
    assert.deepEqual((await connectorRows()).filter(row => row.streamId === streamId), rows);
  } finally {
    control?.abort(); await reader?.cancel().catch(() => {}); await connector?.close(); await relay.close(); console.info = originalInfo;
  }
});
