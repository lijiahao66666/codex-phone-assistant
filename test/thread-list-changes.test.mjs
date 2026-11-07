import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { ThreadListChanges, listDesktopThreads } from '../src/desktop/thread-list.mjs';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPairedDesktopConnector } from '../src/pairing/paired-connector.mjs';

async function until(check, label) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) { if (await check()) return; await delay(10); }
  throw new Error(`Timed out: ${label}`);
}

test('read-only list watcher detects index and project changes without fetching the list', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-list-changes-'));
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT)');
  const statePath = join(dir, '.codex-global-state.json');
  await writeFile(statePath, '{}');
  const watcher = new ThreadListChanges({ codexHome: dir, intervalMs: 20 });
  const changes = [];
  watcher.on('change', event => changes.push(event));
  try {
    watcher.start();
    await until(() => watcher.stateStamp, 'watcher baseline');
    db.exec("INSERT INTO threads VALUES ('new-desktop-thread')");
    await until(() => changes.length === 1, 'SQLite transaction notification');
    const stamp = watcher.stateStamp;
    await writeFile(statePath, JSON.stringify({ unrelatedDesktopWindowState: 'changed' }));
    await until(() => watcher.stateStamp !== stamp, 'unrelated state inspected');
    assert.equal(changes.length, 1, 'unrelated window settings do not reload the list');
    await writeFile(statePath, JSON.stringify({ 'local-projects': { p: { id: 'p', name: 'New project' } } }));
    await until(() => changes.length === 2, 'project notification');
    assert.deepEqual(changes.map(event => event.version), [1, 2]);
    assert.throws(() => watcher.database.exec("INSERT INTO threads VALUES ('must-not-write')"), /readonly/);
    watcher.stop();
    db.exec("INSERT INTO threads VALUES ('after-stop')");
    assert.equal(watcher.database, null);
    assert.equal(watcher.timer, null);
  } finally { watcher.stop(); db.close(); await rm(dir, { recursive: true, force: true }); }
});

test('desktop list changes cross connector and relay SSE before a phone reloads the list', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-list-stream-'));
  const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
  db.exec('PRAGMA journal_mode=WAL; CREATE TABLE threads (id TEXT, title TEXT, name TEXT, recency_at_ms INTEGER, archived INTEGER, source TEXT, thread_source TEXT, preview TEXT, cwd TEXT)');
  await writeFile(join(dir, '.codex-global-state.json'), '{}');
  const watcher = new ThreadListChanges({ codexHome: dir, intervalMs: 20 });
  const sidebar = Object.assign(new EventEmitter(), { snapshot: () => ({}), async close() {}, async updateAndWait() {}, get: () => 'unknown' });
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const base = `http://127.0.0.1:${port}`, origin = `https://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, database: join(dir, 'relay.sqlite') });
  let connector, reader, reading;
  try {
    await relay.listen(port);
    const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
    const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
    const host = await (await post('/api/enroll', { name: 'isolated Mac' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(paired.status, 200);
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const credential = join(dir, 'host.json');
    await writeFile(credential, JSON.stringify({ hostId: host.hostId, secret: host.secret, origin: base }), { mode: 0o600 });
    let listReads = 0;
    connector = await createPairedDesktopConnector({ credentialPath: credential, allowInsecureForTests: true,
      sidebarStatusForTests: sidebar, threadListChangesForTests: watcher,
      listThreads: options => { listReads++; return listDesktopThreads({ ...options, codexHome: dir }); } });
    connector.start();
    await until(async () => (await (await fetch(base + '/api/host-status', { headers: { ...headers, cookie } })).json()).online, 'connector online');
    const response = await fetch(base + '/api/sidebar/events', { headers: { ...headers, cookie }, signal: AbortSignal.timeout(7000) });
    assert.equal(response.status, 200);
    reader = response.body.getReader();
    let events = '';
    reading = (async () => { try { for (;;) { const part = await reader.read(); if (part.done) return; events += new TextDecoder().decode(part.value); } } catch {} })();
    await until(() => watcher.stateStamp, 'watcher is attached to sidebar');
    const threadId = randomUUID();
    db.prepare("INSERT INTO threads VALUES (?, 'Desktop-created chat', NULL, 1, 0, 'vscode', 'user', 'visible', ?)").run(threadId, dir);
    await until(() => events.includes('event: thread-list-changed'), 'change arrives through relay');
    assert.match(events, /event: thread-list-changed\ndata: \{"version":1\}/);
    assert.equal(listReads, 0, 'the watcher never queries the complete list');
    const list = await (await fetch(base + '/api/threads', { headers: { ...headers, cookie } })).json();
    assert.equal(list.recent[0].id, threadId);
    assert.equal(listReads, 1);
    await reader.cancel(); await reading;
    await until(() => watcher.timer === null, 'last sidebar disconnect stops the watcher');
  } finally {
    await reader?.cancel().catch(() => {}); await reading;
    await connector?.close(); await relay.close(); watcher.stop(); db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
