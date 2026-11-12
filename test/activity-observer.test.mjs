import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityObserver } from '../src/desktop/activity-observer.mjs';

const id = '11111111-1111-4111-8111-111111111111', scope = 'a'.repeat(64);
const list = async () => ({ projects: [], recent: [{ id, title: 'Test' }], nativeUnread: { status: 'available', scopeKey: scope } });
const record = { recency: 1, observedAt: 1000, readScopeKey: scope, summary: { active: true, controls: [{ kind: 'question' }] } };

test('activity observation supplements the enabled monitor without notification delivery', async () => {
  const created = [], shared = { hasListed: true, listConfirmed: true, records: new Map([[id, record]]) }; let activeShared = null;
  const observer = createActivityObserver({ list, listThreads: async () => ({}), createSession() {}, sharedMonitor: () => activeShared, now: () => 1000,
    createMonitor(options) { const value = { options, hasListed: true, listConfirmed: true, records: new Map([[id, record]]), start() { return this; }, async close() { this.closed = true; } }; created.push(value); return value; } });
  try {
    assert.equal((await observer.snapshot()).items[0].waiting, 'question');
    await observer.snapshot(); assert.equal(created.length, 1);
    created[0].options.onEvent({ kind: 'approval' }); // no push or transport is attached
    activeShared = shared; assert.equal((await observer.snapshot()).complete, true);
    assert.equal(created[0].closed, undefined);
  } finally { observer.close(); }
});

test('bounded activity refresh progressively checks older authorized records and expires stale idle state', async () => {
  const ids = Array.from({ length: 300 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`);
  const rows = ids.map(id => ({ id, title: 'Task' }));
  let time = 1000000; const batches = [];
  const source = { records: new Map(ids.map((id, i) => [id, { recency: i, retryAt: 0 }])), entries: new Map(), hasListed: true, listConfirmed: true,
    start() { return this; }, async close() {}, requestActivityProbes(batch) { batches.push(batch); for (const id of batch) Object.assign(this.records.get(id), { observedAt: time, readScopeKey: scope, summary: { active: false, controls: [] } }); } };
  const observer = createActivityObserver({ list: async () => ({ projects: [], recent: rows, nativeUnread: { status: 'available', scopeKey: scope } }), listThreads: async () => ({}), createSession() {}, createMonitor: () => source, now: () => time });
  try {
    for (let i = 0; i < 10; i++) await observer.snapshot();
    const final = await observer.snapshot();
    assert.equal(new Set(batches.flat()).size, 300);
    assert.ok(batches.every(batch => batch.length <= 32));
    assert.equal(final.complete, true);
    time += 300001;
    const expired = await observer.snapshot();
    assert.equal(expired.complete, false);
    assert.equal(expired.items.filter(item => item.active === null).length, 268);
  } finally { observer.close(); }
});

test('closing or switching observers during a slow list cannot return the old snapshot', async () => {
  let release;
  const observer = createActivityObserver({ list: () => new Promise(resolve => { release = resolve; }), listThreads: async () => ({}), createSession() {},
    createMonitor: () => ({ start() { return this; }, async close() {} }) });
  const pending = observer.snapshot(); observer.close(); release(await list());
  await assert.rejects(pending, /changed/);
});

test('activity ignores uninitialized live entries and prefers an observation from the current identity', async () => {
  const stale = { ...record, observedAt: 1, summary: { active: false, controls: [] } };
  const owned = { records: new Map([[id, stale]]), entries: new Map([[id, { initialized: false }]]), hasListed: true, listConfirmed: true, start() { return this; }, requestActivityProbes() {}, async close() {} };
  const shared = { records: new Map([[id, { ...record, observedAt: 999, readScopeKey: 'b'.repeat(64) }]]), entries: new Map([[id, { initialized: true }]]) };
  const observer = createActivityObserver({ list, listThreads: async () => ({}), createSession() {}, sharedMonitor: () => shared, createMonitor: () => owned, now: () => 400000 });
  try { const result = await observer.snapshot(); assert.equal(result.complete, false); assert.equal(result.items[0].active, null); }
  finally { observer.close(); }
});
