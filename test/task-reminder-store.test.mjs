import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const source = await readFile(new URL('../public/task-reminder-store.js', import.meta.url), 'utf8');
const workerSource = await readFile(new URL('../public/notification-worker.js', import.meta.url), 'utf8');
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

test('inspection distinguishes a stored reminder from an exact read receipt across context restarts', async () => {
  const db = indexedDbFixture(), page = context(db), first = { ...event(), createdAt: 200 };
  await page.activate(pairA);
  await page.put(pairA, first);
  assert.deepEqual(plain(await context(db).inspectEvent(pairA, first)), { status: 'seen', stored: true });
  await page.removeEvent(pairA, first);
  const reloaded = context(db);
  assert.deepEqual(plain(await reloaded.inspectEvent(pairA, first)), { status: 'seen', stored: false });
  assert.equal(await reloaded.hasEvent(pairA, first), true, 'worker duplicate suppression still accepts a read receipt');
  await reloaded.put(pairA, first);
  assert.deepEqual(plain(await reloaded.list(pairA)), [], 'an exact replay must not restore the read reminder');
  const next = { ...event(first.threadId), createdAt: 200 };
  await reloaded.put(pairA, next);
  assert.deepEqual(plain(await context(db).inspectEvent(pairA, first)), { status: 'seen', stored: false });
  assert.deepEqual(plain(await context(db).inspectEvent(pairA, next)), { status: 'seen', stored: true });
  await reloaded.remove(pairA, first.threadId);
  assert.deepEqual(plain(await context(db).inspectEvent(pairA, next)), { status: 'seen', stored: false });
});

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

function pushWorkerContext(db, navigator = {}, beforeDisplay = async () => {}) {
  const listeners = {}, displayed = [], root = {
    indexedDB: db.indexedDB, navigator, location: { origin: 'https://assistant.example' },
    addEventListener(type, callback) { listeners[type] = callback; },
    registration: {
      async showNotification(title, options) {
        const notification = { title, ...options, closed: false, close() { this.closed = true; } };
        displayed.push(notification); await beforeDisplay(notification);
      },
      async getNotifications({ tag } = {}) { return displayed.filter(notification => !notification.closed && (!tag || notification.tag === tag)); },
    },
    clients: { async matchAll() { return []; } },
  };
  const sandbox = vm.createContext({ self: root, URL, URLSearchParams,
    importScripts(path) { assert.equal(path, '/task-reminder-store.js'); vm.runInContext(source, sandbox); },
  });
  vm.runInContext(workerSource, sandbox);
  assert.equal(vm.runInContext('typeof window', sandbox), 'undefined'); assert.equal(vm.runInContext('typeof document', sandbox), 'undefined');
  return { root, displayed, async push(pair, notification) {
    let completion;
    listeners.push({ data: { json: () => ({ ...pair, ...notification }) }, waitUntil(promise) { completion = promise; } });
    await completion;
  } };
}

test('with no H5 windows, push waits for IndexedDB persistence and the worker badge call, then survives a worker restart', async () => {
  const db = indexedDbFixture(), page = context(db), badges = [];
  await page.activate(pairA);
  let releaseBadge;
  const worker = pushWorkerContext(db, { async setAppBadge(count) {
    await new Promise(resolve => { releaseBadge = resolve; }); badges.push(count);
  }, async clearAppBadge() { badges.push(0); } });
  const first = event(); let finished = false;
  const pushed = worker.push(pairA, first).then(() => { finished = true; });
  while (!releaseBadge) await new Promise(resolve => setImmediate(resolve));
  assert.equal(finished, false, 'push event waitUntil must include the asynchronous Badging API call');
  assert.equal(worker.displayed.length, 1); assert.deepEqual(plain(await page.list(pairA)), [first]);
  releaseBadge(); await pushed;
  assert.deepEqual(badges, [1]);
  const restarted = pushWorkerContext(db, { async setAppBadge(count) { badges.push(count); }, async clearAppBadge() { badges.push(0); } });
  await restarted.push(pairA, first); assert.equal(restarted.displayed.length, 0, 'a new worker reads the persisted receipt before notifying');
  const second = event(); await restarted.push(pairA, second);
  assert.equal(restarted.displayed.length, 1); assert.equal(badges.at(-1), 2);
  assert.deepEqual(plain(await context(db).list(pairA)), [first, second]);
});

test('a pairing revoked while the OS display is pending cannot restore its badge and its late notification is closed', async () => {
  const db = indexedDbFixture(), badges = [], page = context(db, { async clearAppBadge() { badges.push(0); } });
  await page.activate(pairA);
  let releaseDisplay;
  const worker = pushWorkerContext(db, { async setAppBadge(count) { badges.push(count); }, async clearAppBadge() { badges.push(0); } },
    () => new Promise(resolve => { releaseDisplay = resolve; }));
  const pushed = worker.push(pairA, event());
  while (!releaseDisplay) await new Promise(resolve => setImmediate(resolve));
  await page.activate(null); releaseDisplay(); await pushed;
  assert.equal(worker.displayed[0].closed, true);
  assert.deepEqual(plain(await page.list(pairA)), []); assert.equal(badges.at(-1), 0);
});

test('an exact read receipt arriving while the OS display is pending prevents a late badge or system notification', async () => {
  const db = indexedDbFixture(), badges = [], page = context(db);
  await page.activate(pairA);
  let releaseDisplay;
  const worker = pushWorkerContext(db, { async setAppBadge(count) { badges.push(count); }, async clearAppBadge() { badges.push(0); } },
    () => new Promise(resolve => { releaseDisplay = resolve; }));
  const notification = event(), pushed = worker.push(pairA, notification);
  while (!releaseDisplay) await new Promise(resolve => setImmediate(resolve));
  await page.removeEvent(pairA, notification); releaseDisplay(); await pushed;
  assert.equal(worker.displayed[0].closed, true); assert.deepEqual(plain(await page.list(pairA)), []); assert.equal(badges.at(-1), 0);
});

test('verified event timestamps reject older and unknown-time updates but equal timestamps retain arrival order', async () => {
  const db = indexedDbFixture(), store = context(db); await store.activate(pairA);
  const latest = { ...event(), kind: 'question', createdAt: 200 }, older = { ...event(latest.threadId, 'older'), createdAt: 100 };
  await store.put(pairA, latest);
  assert.equal((await store.inspectEvent(pairA, older)).status, 'stale');
  assert.deepEqual(plain(await store.put(pairA, older)), { stale: true });
  for (const createdAt of [undefined, -1, 1.5, '300', Infinity]) {
    const unknown = { ...event(latest.threadId), createdAt };
    assert.equal((await store.inspectEvent(pairA, unknown)).status, 'stale');
    assert.deepEqual(plain(await store.put(pairA, unknown)), { stale: true });
  }
  assert.deepEqual(plain(await store.list(pairA)), [latest]);
  const equal = { ...event(latest.threadId, 'same-ms', 'approval'), createdAt: 200 };
  assert.equal((await store.inspectEvent(pairA, equal)).status, 'new'); await store.put(pairA, equal);
  assert.deepEqual(plain(await store.list(pairA)), [equal], 'different IDs in the same millisecond have no provable ordering');
  const newer = { ...event(latest.threadId, 'newest'), createdAt: 201 }; await store.put(pairA, newer);
  assert.deepEqual(plain(await store.list(pairA)), [newer]);
});

test('read-before-push writes a per-task watermark, removes strictly older rows and never removes a newer event', async () => {
  const store = context(indexedDbFixture()); await store.activate(pairA);
  const previous = { ...event(), createdAt: 100 }, receipt = { ...event(previous.threadId, 'already-read'), createdAt: 200 };
  await store.put(pairA, previous);
  assert.deepEqual(plain(await store.removeEvent(pairA, receipt)), { removed: true });
  assert.deepEqual(plain(await store.list(pairA)), []);
  const delayed = { ...event(previous.threadId, 'late-different-id'), createdAt: 150 };
  assert.equal((await store.inspectEvent(pairA, delayed)).status, 'stale'); await store.put(pairA, delayed);
  assert.deepEqual(plain(await store.list(pairA)), []);
  const equal = { ...event(previous.threadId, 'same-ms-other-event'), createdAt: 200 }; await store.put(pairA, equal);
  await store.removeEvent(pairA, receipt); assert.deepEqual(plain(await store.list(pairA)), [equal], 'same timestamp alone cannot identify which different event is newer');
  const newer = { ...event(previous.threadId, 'newer-unread'), createdAt: 300 }; await store.put(pairA, newer);
  await store.removeEvent(pairA, receipt); assert.deepEqual(plain(await store.list(pairA)), [newer]);
});

test('task watermarks survive remove, clear and worker restart without changing the database schema', async () => {
  const db = indexedDbFixture(), store = context(db); await store.activate(pairA);
  const first = { ...event(), createdAt: 100 }, second = { ...event(), createdAt: 200 };
  await store.put(pairA, first); await store.put(pairA, second);
  await store.remove(pairA, first.threadId); await store.clear(pairA);
  const worker = context(db, {}, true);
  for (const saved of [first, second]) {
    const late = { ...event(saved.threadId), createdAt: saved.createdAt - 1 };
    assert.equal((await worker.inspectEvent(pairA, late)).status, 'stale'); await worker.put(pairA, late);
  }
  assert.deepEqual(plain(await worker.list(pairA)), []);
  assert.equal(db.opens, 2, 'a new execution context reopens the same version-1 state store');
  await store.activate(pairB);
  assert.equal((await worker.inspectEvent(pairA, first)).status, 'inactive');
  assert.deepEqual(plain(await worker.put(pairA, { ...event(), createdAt: 999 })), { ignored: true });
  const otherPair = { ...event(first.threadId), createdAt: 1 }; await store.put(pairB, otherPair);
  assert.deepEqual(plain(await store.list(pairB)), [otherPair], 'one paired computer never inherits another scope watermark');
});

test('removing or clearing existing timestamped rows preserves their proof even when the watermark key did not exist yet', async () => {
  for (const operation of ['remove', 'clear']) {
    const db = indexedDbFixture(), store = context(db); await store.activate(pairA);
    const saved = { ...event(), createdAt: 200 };
    db.committed.set('scope:' + JSON.stringify([pairA.hostId, pairA.deviceId]), [saved]);
    if (operation === 'remove') await store.remove(pairA, saved.threadId); else await store.clear(pairA);
    assert.equal((await store.inspectEvent(pairA, { ...event(saved.threadId), createdAt: 100 })).status, 'stale');
    assert.deepEqual(plain(await store.list(pairA)), []);
  }
});

test('per-task watermarks remain bounded to the most recent 512 tasks independently of the visible reminder rows', async () => {
  const db = indexedDbFixture(), store = context(db); await store.activate(pairA);
  const events = Array.from({ length: 515 }, (_, index) => ({ ...event(), createdAt: index }));
  for (const notification of events) await store.removeEvent(pairA, notification);
  const entries = [...db.committed].filter(([key]) => key.startsWith('watermarks:'));
  assert.equal(entries.length, 1); assert.equal(entries[0][1].length, 512);
  assert.deepEqual(plain(entries[0][1][0]), { threadId: events[3].threadId, createdAt: 3 });
  assert.deepEqual(plain(await store.list(pairA)), []);
});

test('a restarted worker rejects a delayed older notification before display or badge changes', async () => {
  const db = indexedDbFixture(), store = context(db), badges = []; await store.activate(pairA);
  const newest = { ...event(), kind: 'question', createdAt: 200 }; await store.put(pairA, newest);
  const worker = pushWorkerContext(db, { async setAppBadge(count) { badges.push(count); }, async clearAppBadge() { badges.push(0); } });
  await worker.push(pairA, { ...event(newest.threadId, 'old-completed'), createdAt: 100 });
  assert.equal(worker.displayed.length, 0); assert.deepEqual(plain(await store.list(pairA)), [newest]); assert.equal(badges.at(-1), 1);
  await store.remove(pairA, newest.threadId);
  await worker.push(pairA, event(newest.threadId, 'legacy-without-time'));
  assert.equal(worker.displayed.length, 0); assert.deepEqual(plain(await store.list(pairA)), []); assert.equal(badges.at(-1), 0);
});

test('a duplicate push can enrich an older exact read receipt with its timestamp without restoring its reminder', async () => {
  const db = indexedDbFixture(), store = context(db); await store.activate(pairA);
  const read = event(); await store.removeEvent(pairA, read);
  const worker = pushWorkerContext(db);
  await worker.push(pairA, { ...read, createdAt: 300 });
  await worker.push(pairA, { ...event(read.threadId, 'older-other-id'), createdAt: 200 });
  assert.equal(worker.displayed.length, 0); assert.deepEqual(plain(await store.list(pairA)), []);
  assert.equal((await store.inspectEvent(pairA, { ...event(read.threadId), createdAt: 299 })).status, 'stale');
});

test('a newer timestamped receipt arriving during OS display closes a stale different event and keeps its badge empty', async () => {
  const db = indexedDbFixture(), store = context(db), badges = []; await store.activate(pairA);
  let releaseDisplay;
  const worker = pushWorkerContext(db, { async setAppBadge(count) { badges.push(count); }, async clearAppBadge() { badges.push(0); } },
    () => new Promise(resolve => { releaseDisplay = resolve; }));
  const old = { ...event(), createdAt: 100 }, pushing = worker.push(pairA, old);
  while (!releaseDisplay) await new Promise(resolve => setImmediate(resolve));
  await store.removeEvent(pairA, { ...event(old.threadId, 'newer-viewed'), createdAt: 200 });
  releaseDisplay(); await pushing;
  assert.equal(worker.displayed[0].closed, true); assert.deepEqual(plain(await store.list(pairA)), []); assert.equal(badges.at(-1), 0);
});
