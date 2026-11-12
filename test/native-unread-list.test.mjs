import test from 'node:test';
import assert from 'node:assert/strict';
import { listAllThreads } from '../src/transport/preview-connector.mjs';

const scopeA = 'a'.repeat(64), scopeB = 'b'.repeat(64);
const snapshotA = 'c'.repeat(64), snapshotB = 'd'.repeat(64);
const metadata = (scopeKey = scopeA, snapshotKey = snapshotA) => ({ status: 'available', scopeKey, snapshotKey });
const page = (name, nativeUnread, nextCursor = null) => ({
  projects: [{ id: 'project', name: 'Project', threads: [{ id: name, title: name, unread: true }] }],
  recent: [], nextCursor, nativeUnread,
});
const cursor = { id: 'first', recency: 10 };
const aggregate = pages => listAllThreads(async ({ before }) => pages[before ? 1 : 0]);

test('matching paginated native snapshots expose only the authorized rows and opaque scope', async () => {
  const result = await aggregate([page('first', metadata(), cursor), page('second', metadata())]);
  assert.deepEqual(result.nativeUnread, { status: 'available', scopeKey: scopeA });
  assert.deepEqual(result.projects[0].threads.map(item => [item.id, item.unread]), [['first', true], ['second', true]]);
  assert.equal(JSON.stringify(result).includes(snapshotA), false, 'whole-set digest remains inside the connector');
  assert.equal(result.truncated, false);
});

test('identity switch, changed unread set, malformed metadata or missing state cannot partially clear unread', async t => {
  for (const [label, first, second] of [
    ['identity changed', metadata(), metadata(scopeB)],
    ['same identity changed unread set', metadata(), metadata(scopeA, snapshotB)],
    ['second page unavailable', metadata(), { status: 'unavailable' }],
    ['first page unavailable', { status: 'unavailable' }, metadata()],
    ['legacy connector', undefined, metadata()],
    ['invalid scope', metadata('invalid'), metadata()],
    ['invalid digest', metadata(scopeA, 'invalid'), metadata()],
  ]) await t.test(label, async () => {
    const result = await aggregate([page('first', first, cursor), page('second', second)]);
    assert.deepEqual(result.nativeUnread, { status: 'unavailable' });
    assert.ok(result.projects[0].threads.every(item => !Object.hasOwn(item, 'unread')));
  });
});

test('a truncated list reports its native snapshot without treating missing tasks as read', async () => {
  const huge = 'x'.repeat(512 * 1024);
  const result = await listAllThreads(async () => ({ projects: [], recent: [{ id: 'first', title: huge, unread: true }], nativeUnread: metadata() }));
  assert.equal(result.truncated, true);
  assert.deepEqual(result.nativeUnread, { status: 'available', scopeKey: scopeA });
  assert.deepEqual(result.recent, []);
});
