import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../public/task-reminder-store.js', import.meta.url), 'utf8');
const pairA = { hostId: randomUUID(), deviceId: randomUUID() };
const pairB = { hostId: randomUUID(), deviceId: randomUUID() };
const event = (threadId = randomUUID(), eventId = randomUUID(), kind = 'completed') => ({ threadId, eventId, kind });
const plain = value => JSON.parse(JSON.stringify(value));

// A transactional request/event stub: connections share committed state,
// readwrite transactions serialize, and abort discards its working copy.
// Production still uses the browser's IndexedDB implementation unchanged.
function indexedDbFixture({ failures = 0 } = {}) {
  const committed = new Map(); let created = false, opens = 0, tail = Promise.resolve();
  const indexedDB = { open() {
    const request = {}; opens++;
    queueMicrotask(() => {
      if (failures-- > 0) return request.onerror?.();
      request.result = { createObjectStore() {}, close() {}, transaction(_name, mode) {
        let finish, aborted = false, scheduled = false, working;
        const requests = [], finished = new Promise(resolve => { finish = resolve; });
        const tx = { abort() { aborted = true; }, objectStore() { return {
          get(key) { const request = {}; requests.push(() => { request.result = structuredClone(working.get(key)); request.onsuccess?.(); }); return request; },
          put(value, key) { const request = {}; requests.push(() => { working.set(key, structuredClone(value)); request.onsuccess?.(); }); return request; },
        }; } };
        const drain = () => {
          if (aborted) { tx.onabort?.(); finish(); return; }
          if (!requests.length) {
            if (mode === 'readwrite') { committed.clear(); for (const [key, value] of working) committed.set(key, value); }
            tx.oncomplete?.(); finish(); return;
          }
          requests.shift()(); queueMicrotask(drain);
        };
        const predecessor = tail; tail = finished;
        void predecessor.then(() => {
          if (scheduled) return; scheduled = true;
          working = structuredClone(committed); queueMicrotask(drain);
        });
        return tx;
      } };
      if (!created) { created = true; request.onupgradeneeded?.(); }
      request.onsuccess?.();
    });
    return request;
  } };
  return { indexedDB, committed, get opens() { return opens; } };
}

function context(db, navigator = {}, worker = false) {
  const root = { indexedDB: db.indexedDB, navigator };
  vm.runInNewContext(source, worker ? { self: root } : { window: root });
  return root.taskReminderStore;
}

test('reminders persist across page/worker contexts and only retain generic task event identities', async () => {
  const db = indexedDbFixture(), badges = [];
  const navigator = { async setAppBadge(value) { badges.push(value); }, async clearAppBadge() { badges.push(0); } };
  const page = context(db, navigator), first = event();
  await page.activate(pairA);
  await page.put(pairA, { ...first, title: 'PRIVATE', text: 'PRIVATE' });
  assert.equal(badges.at(-1), 1);
  const worker = context(db, navigator, true);
  assert.deepEqual(plain(await worker.list(pairA)), [first]);
  assert.doesNotMatch(JSON.stringify([...db.committed]), /PRIVATE/);
  const second = event(first.threadId, 'next-event', 'question');
  await worker.put(pairA, second);
  await worker.put(pairA, second);
  assert.deepEqual(plain(await page.list(pairA)), [second]);
  assert.equal(badges.at(-1), 1, 'one task contributes at most one unread count');
  await page.remove(pairA, first.threadId);
  assert.equal((await worker.list(pairA)).length, 0); assert.equal(badges.at(-1), 0);
  await worker.put(pairA, first); await worker.put(pairA, second);
  assert.equal((await worker.list(pairA)).length, 0, 'late duplicated events cannot restore a task already read');
});

test('switching scope isolates tasks, ignores late old-pair writes and restores only the active pair badge', async () => {
  const db = indexedDbFixture(), badges = [];
  const store = context(db, { async setAppBadge(value) { badges.push(value); }, async clearAppBadge() { badges.push(0); } });
  const a = event(), b = event();
  await store.activate(pairA); await store.put(pairA, a);
  await store.activate(pairB);
  assert.equal(badges.at(-1), 0); assert.equal(await store.isActive(pairA), false);
  assert.deepEqual(plain(await store.put(pairA, event())), { ignored: true });
  await store.put(pairB, b);
  assert.deepEqual(plain(await store.list(pairB)), [b]);
  assert.deepEqual(plain(await store.remove(pairA, a.threadId)), { ignored: true });
  assert.equal(badges.at(-1), 1);
  await store.activate(null); assert.equal(badges.at(-1), 0);
  assert.deepEqual(plain(await store.list(pairA)), [a]); assert.equal(badges.at(-1), 0);
  await store.activate(pairA); assert.equal(badges.at(-1), 1);
});

test('concurrent contexts cannot mix scopes and a delayed old badge is corrected after a switch', async () => {
  const db = indexedDbFixture(), badges = [];
  let release, delayed = false;
  const navigator = { async setAppBadge(value) {
    if (value === 1 && !delayed) { delayed = true; await new Promise(resolve => { release = resolve; }); }
    badges.push(value);
  }, async clearAppBadge() { badges.push(0); } };
  const page = context(db, navigator), worker = context(db, navigator, true);
  await page.activate(pairA);
  const pending = worker.put(pairA, event());
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await page.activate(pairB);
  assert.equal(badges.at(-1), 0);
  release(); await pending;
  assert.equal(badges.at(-1), 0, 'late old-scope badge completion must restore the fresh current count');
  await Promise.all([page.put(pairB, event()), worker.put(pairA, event())]);
  assert.equal((await page.list(pairB)).length, 1);
  assert.equal((await page.list(pairA)).length, 1, 'only the earlier authorized A event remains');
});

test('scope storage is bounded, newest task replaces its previous event, and unsupported badge APIs are harmless', async () => {
  const store = context(indexedDbFixture());
  await store.activate(pairA);
  const events = Array.from({ length: 260 }, () => event());
  for (const value of events) await store.put(pairA, value);
  const saved = plain(await store.list(pairA));
  assert.equal(saved.length, 256); assert.deepEqual(saved[0], events[4]);
  await store.put(pairA, event(events[4].threadId, 'latest'));
  assert.equal((await store.list(pairA)).length, 256);
  assert.equal((await store.list(pairA)).at(-1).eventId, 'latest');
  await store.clear(pairA); assert.equal((await store.list(pairA)).length, 0);
});

test('failed database opening can retry and rejected badge calls do not undo a saved reminder', async () => {
  const db = indexedDbFixture({ failures: 1 });
  const store = context(db, { async setAppBadge() { throw new Error('unsupported'); }, async clearAppBadge() { throw new Error('unsupported'); } });
  await assert.rejects(store.activate(pairA), /storage unavailable/);
  await store.activate(pairA); const value = event(); await store.put(pairA, value);
  assert.equal(db.opens, 2); assert.deepEqual(plain(await store.list(pairA)), [value]);
  await assert.rejects(store.put(pairA, { ...value, threadId: '../private' }), /Invalid reminder/);
  await assert.rejects(store.list({}), /Invalid reminder pair/);
});

test('exact resolved event cannot remove a newer reminder and clear-before-push persists a receipt', async () => {
  const db = indexedDbFixture(), store = context(db);
  await store.activate(pairA);
  const old = event(), newer = event(old.threadId, 'newer', 'approval');
  await store.put(pairA, newer);
  assert.deepEqual(plain(await store.removeEvent(pairA, old)), { removed: false });
  assert.deepEqual(plain(await store.list(pairA)), [newer]);
  await store.put(pairA, old);
  assert.deepEqual(plain(await store.list(pairA)), [newer], 'clear-before-push receipt blocks the delayed old event');
  const worker = context(db, {}, true);
  await worker.removeEvent(pairA, newer);
  assert.equal((await store.list(pairA)).length, 0);
  await worker.put(pairA, newer);
  assert.equal((await store.list(pairA)).length, 0);
  await store.activate(pairB);
  assert.deepEqual(plain(await store.removeEvent(pairA, event())), { ignored: true });
});

test('hasEvent detects read receipts and stored duplicates only in the active pair while allowing new task events', async () => {
  const db = indexedDbFixture(), store = context(db), worker = context(db, {}, true);
  const old = event(), newer = event(old.threadId, 'new-event', 'question');
  await store.activate(pairA);
  assert.equal(await worker.hasEvent(pairA, old), false);
  await store.removeEvent(pairA, old);
  assert.equal(await worker.hasEvent(pairA, old), true, 'clear-before-push receipt suppresses a late system notification');
  assert.equal(await worker.hasEvent(pairA, newer), false);
  await worker.put(pairA, newer);
  assert.equal(await store.hasEvent(pairA, newer), true);
  await store.remove(pairA, newer.threadId);
  assert.equal(await worker.hasEvent(pairA, newer), true);
  await store.activate(pairB);
  assert.equal(await worker.hasEvent(pairA, newer), false, 'inactive scope does not reveal receipts');
  assert.equal(await worker.hasEvent(pairB, newer), false);
});
