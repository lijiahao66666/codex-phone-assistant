import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { get } from 'node:http';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { createRecordedHistoryPager } from '../src/desktop/recorded-history-page.mjs';
import { StateChunkAssembler } from '../public/state-chunks.mjs';

const thread = '11111111-1111-4111-8111-111111111111';
async function fixture({ large = false, unavailableSession = false } = {}) {
  const home = await mkdtemp(join(tmpdir(), 'recorded-history-http-'));
  const state = new DatabaseSync(join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT, cwd TEXT)');
  state.prepare('INSERT INTO threads VALUES (?, ?, NULL, 0, ?, ?, ?)').run(thread, 'Offline history', 'vscode', 'user', '/project');
  state.close();
  const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
  db.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, PRIMARY KEY(thread_id,turn_id));
    CREATE UNIQUE INDEX turns_page ON thread_turns(thread_id,rollout_ordinal);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_json TEXT, updated_at_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE INDEX items_page ON thread_items(thread_id,turn_id,rollout_ordinal);
    CREATE TABLE thread_history_projection_state (thread_id TEXT PRIMARY KEY,next_rollout_ordinal INTEGER,next_rollout_byte_offset INTEGER);`);
  db.prepare('INSERT INTO thread_turns VALUES (?, ?, 1, ?, 0)').run(thread, 'offline-turn', 'inProgress');
  const insert = db.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)');
  const count = large ? 2 : 450;
  for (let index = 0; index < count; index++) insert.run(thread, 'offline-turn', `item-${index}`, index + 2, JSON.stringify({ id: `item-${index}`, type: 'agentMessage', text: large ? 'x'.repeat(160 * 1024) : String(index), phase: 'final_answer' }), index + 2);
  db.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, ?)').run(thread, count + 2, 10000);
  db.close();
  const reserved = createServer(); await new Promise(resolve => reserved.listen(0, '127.0.0.1', resolve));
  const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, requestTimeoutMs: 10000 }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, json, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(json) });
  const host = await (await post('/api/enroll', { name: 'recorded-history-test' })).json();
  async function pair() {
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const response = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(response.status, 200);
    const value = await response.json();
    return { ...value, cookie: response.headers.getSetCookie().map(v => v.split(';')[0]).join('; ') };
  }
  const phone = await pair();
  let sessionCount = 0, legacyReads = 0;
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, hostId: host.hostId, secret: host.secret,
    recordedHistoryPager: createRecordedHistoryPager({ codexHome: home }), allowInsecureForTests: true,
    readHistory() { legacyReads++; throw new Error('Legacy scan should not run when indexed history is available'); },
    createSession() {
      sessionCount++;
      if (!unavailableSession) throw new Error('No desktop owner is available');
      const session = new EventEmitter(); session.status = 'unavailable';
      session.start = () => session.emit('state', { status: 'unavailable' });
      session.close = async () => {};
      return session;
    } });
  connector.start();
  for (let attempt = 0; attempt < 100; attempt++) {
    const response = await fetch(base + '/api/host-status', { headers: { cookie: phone.cookie, 'sec-fetch-site': 'same-origin' } });
    if ((await response.json()).online) break;
    await delay(10);
  }
  const requestHeaders = selected => ({ cookie: selected.cookie, 'sec-fetch-site': 'same-origin', 'x-codex-expected-device': selected.deviceId, 'x-codex-history-chunks': '1' });
  const path = `/api/threads/${thread}/recorded-history`;
  async function read(cursor = null, selected = phone) {
    const response = await fetch(base + path + (cursor ? '?' + new URLSearchParams({ cursor }) : ''), { headers: requestHeaders(selected) });
    if (!response.ok) return { status: response.status, value: await response.json() };
    assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
    const assembler = new StateChunkAssembler({ maxBytes: 4 * 1024 * 1024 });
    const frames = (await response.text()).trim().split('\n').map(JSON.parse);
    let result;
    for (const frame of frames) result = await assembler.accept(frame) || result;
    assert.equal(result.seq, 1);
    return { status: response.status, value: result.value, frames };
  }
  const updateOldItem = () => {
    const db = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
    try {
      db.prepare('UPDATE thread_items SET updated_at_ordinal=99999 WHERE thread_id=? AND item_id=?').run(thread, 'item-0');
      db.prepare('UPDATE thread_history_projection_state SET next_rollout_ordinal=100000,next_rollout_byte_offset=100000 WHERE thread_id=?').run(thread);
    } finally { db.close(); }
  };
  return { base, path, phone, pair, read, requestHeaders, updateOldItem, sessions: () => sessionCount, legacyReads: () => legacyReads,
    async close() { await connector.close(); await relay.close(); await rm(home, { recursive: true, force: true }); } };
}

test('authenticated recorded history pages are chunked and available without a desktop owner or control session', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const ids = [];
    let cursor = null, pages = 0;
    do {
      const result = await f.read(cursor); assert.equal(result.status, 200);
      assert.equal(result.value.runtimeStatus, 'unknown'); assert.deepEqual(result.value.requests, []);
      assert.equal(result.value.history.readOnly, true);
      assert.equal(result.value.turns[0].status, 'unknown');
      ids.unshift(...result.value.turns[0].items.map(item => item.id));
      cursor = result.value.nextCursor;
      pages++;
    } while (cursor);
    assert.equal(pages, 3);
    assert.deepEqual(ids, Array.from({ length: 450 }, (_, i) => `item-${i}`));
    assert.equal(f.sessions(), 0, 'reading history must never open, resume or authorize a control session');
    const deniedWrite = await fetch(f.base + `/api/threads/${thread}/messages`, { method: 'POST', headers: { ...f.requestHeaders(f.phone), origin: f.base.replace('http:', 'https:'), 'content-type': 'application/json' }, body: JSON.stringify({ text: 'must not be sent' }) });
    assert.equal(deniedWrite.status, 409);
  } finally { await f.close(); }
});

test('recorded history enforces authentication, same-origin, expected device and signed cursor scope', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await fetch(f.base + f.path)).status, 401);
    assert.equal((await fetch(f.base + f.path, { headers: { ...f.requestHeaders(f.phone), 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await fetch(f.base + f.path, { headers: { ...f.requestHeaders(f.phone), 'x-codex-expected-device': '22222222-2222-4222-8222-222222222222' } })).status, 409);
    for (const query of ['?cursor=', '?other=1', '?cursor=one&cursor=two']) assert.equal((await fetch(f.base + f.path + query, { headers: f.requestHeaders(f.phone) })).status, 400);
    const first = await f.read();
    const secondPhone = await f.pair();
    assert.equal((await f.read(first.value.nextCursor)).status, 401);
    assert.equal((await f.read(first.value.nextCursor, secondPhone)).status, 409, 'another authenticated device cannot replay a cursor');
    assert.equal((await f.read(null, secondPhone)).status, 200);
    assert.equal(f.sessions(), 0);
  } finally { await f.close(); }
});

test('disconnecting chunked readers releases pending requests and permits subsequent reads', { timeout: 15000 }, async () => {
  const f = await fixture({ large: true });
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      await new Promise((resolve, reject) => {
        const request = get(f.base + f.path, { headers: f.requestHeaders(f.phone) }, response => {
          assert.equal(response.statusCode, 200);
          response.once('data', () => { response.destroy(); request.destroy(); resolve(); });
          response.on('error', () => {});
        });
        request.on('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
      });
      await delay(20);
    }
    const result = await f.read();
    assert.equal(result.status, 200);
    assert.ok(result.frames.length > 3);
    assert.equal(result.value.turns[0].items.length, 1, 'byte budget leaves the other large item for a continuation');
    assert.ok(result.value.nextCursor);
    assert.equal(f.sessions(), 0);
  } finally { await f.close(); }
});


test('unavailable live sessions show the newest indexed items without scanning the rollout', { timeout: 15000 }, async () => {
  const f = await fixture({ unavailableSession: true });
  const controller = new AbortController();
  try {
    const response = await fetch(f.base + `/api/threads/${thread}/events`, { headers: { ...f.requestHeaders(f.phone), 'x-codex-history-window': '1' }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer = '', conversation;
    try {
      while (!conversation) {
        const { value, done } = await reader.read();
        assert.equal(done, false); buffer += decoder.decode(value, { stream: true });
        let index;
        while ((index = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
          if (frame.startsWith('event: history\n')) conversation = JSON.parse(frame.slice(frame.indexOf('data: ') + 6)).conversation;
        }
      }
    } finally { controller.abort(); await reader.cancel().catch(() => {}); reader.releaseLock(); }
    assert.equal(conversation.id, thread);
    assert.equal(conversation.history.readOnly, true);
    assert.equal(conversation.runtimeStatus, 'unknown');
    assert.deepEqual(conversation.requests, []);
    assert.equal(conversation.turns[0].items.length, 200);
    assert.equal(conversation.turns[0].items.at(-1).id, 'item-449');
    assert.ok(conversation.nextCursor);
    assert.equal(f.legacyReads(), 0);
    assert.equal(f.sessions(), 1);
  } finally { controller.abort(); await f.close(); }
});


test('modified historical records return an explicit stale cursor response that permits a fresh read', { timeout: 15000 }, async () => {
  const f = await fixture();
  try {
    const first = await f.read(); assert.equal(first.status, 200); assert.ok(first.value.nextCursor);
    f.updateOldItem();
    const stale = await f.read(first.value.nextCursor);
    assert.equal(stale.status, 409); assert.deepEqual(stale.value, { error: 'history-changed' });
    assert.equal((await f.read()).status, 200);
    assert.equal(f.sessions(), 0);
  } finally { await f.close(); }
});
