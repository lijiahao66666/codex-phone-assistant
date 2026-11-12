import test from 'node:test';
import assert from 'node:assert/strict';
import { projectActivitySnapshot } from '../src/desktop/activity-snapshot.mjs';

const scope = 'a'.repeat(64), a = '11111111-1111-4111-8111-111111111111', b = '22222222-2222-4222-8222-222222222222';
const taskList = { projects: [{ threads: [{ id: a, title: 'A', unread: true }] }], recent: [{ id: b, title: 'B' }], nativeUnread: { status: 'available', scopeKey: scope } };
const record = (recency, controls = [], active = false) => ({ recency, readScopeKey: scope, failed: false, summary: { active, controls } });

test('activity projection includes only authorized rows, orders them and retains distinct waiting states', () => {
  const monitor = { hasListed: true, listConfirmed: true, records: new Map([[a, record(100, [{ kind: 'question', eventId: 'private' }, { kind: 'approval', eventId: 'private2' }], true)], [b, record(200)]]) };
  const value = projectActivitySnapshot(taskList, monitor);
  assert.deepEqual(value.items, [
    { id: b, title: 'B', recency: 200, unread: false, active: false, waiting: null, statusKnown: true },
    { id: a, title: 'A', recency: 100, unread: true, active: true, waiting: 'both', statusKnown: true },
  ]);
  assert.equal(value.complete, true); assert.equal(JSON.stringify(value).includes('private'), false);
});

test('missing or stale observations, switched identities and truncated lists cannot claim complete', () => {
  const monitor = { hasListed: true, listConfirmed: true, records: new Map([[a, { ...record(100), readScopeKey: 'b'.repeat(64) }], [b, { ...record(200), failed: true }]]) };
  const result = projectActivitySnapshot(taskList, monitor);
  assert.equal(result.complete, false); assert.ok(result.items.every(item => !item.statusKnown && item.active === null));
  const unavailable = projectActivitySnapshot({ ...taskList, nativeUnread: { status: 'unavailable' }, truncated: true }, monitor);
  assert.equal(unavailable.complete, false); assert.ok(unavailable.items.every(item => item.unread === null));
  assert.equal(projectActivitySnapshot(taskList, monitor, { limit: 1 }).truncated, true);
});
