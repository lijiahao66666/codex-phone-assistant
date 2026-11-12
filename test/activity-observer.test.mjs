import test from 'node:test';
import assert from 'node:assert/strict';
import { createActivityObserver } from '../src/desktop/activity-observer.mjs';

const id = '11111111-1111-4111-8111-111111111111', scope = 'a'.repeat(64);
const list = async () => ({ projects: [], recent: [{ id, title: 'Test' }], nativeUnread: { status: 'available', scopeKey: scope } });
const record = { recency: 1, readScopeKey: scope, summary: { active: true, controls: [{ kind: 'question' }] } };

test('activity observation works without notifications and shares the enabled monitor when available', async () => {
  const created = [], shared = { hasListed: true, listConfirmed: true, records: new Map([[id, record]]) }; let activeShared = null;
  const observer = createActivityObserver({ list, listThreads: async () => ({}), createSession() {}, sharedMonitor: () => activeShared,
    createMonitor(options) { const value = { options, hasListed: true, listConfirmed: true, records: new Map([[id, record]]), start() { return this; }, async close() { this.closed = true; } }; created.push(value); return value; } });
  try {
    assert.equal((await observer.snapshot()).items[0].waiting, 'question');
    await observer.snapshot(); assert.equal(created.length, 1);
    created[0].options.onEvent({ kind: 'approval' }); // no push or transport is attached
    activeShared = shared; assert.equal((await observer.snapshot()).complete, true);
    assert.equal(created[0].closed, true);
  } finally { observer.close(); }
});

test('closing or switching observers during a slow list cannot return the old snapshot', async () => {
  let release;
  const observer = createActivityObserver({ list: () => new Promise(resolve => { release = resolve; }), listThreads: async () => ({}), createSession() {},
    createMonitor: () => ({ start() { return this; }, async close() {} }) });
  const pending = observer.snapshot(); observer.close(); release(await list());
  await assert.rejects(pending, /changed/);
});
