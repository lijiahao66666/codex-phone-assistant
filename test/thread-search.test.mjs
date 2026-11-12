import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { authorizedSearchThreads, createThreadSearch, searchAuthorizedTitles } from '../src/desktop/thread-search.mjs';

const hostId = '11111111-1111-4111-8111-111111111111', deviceId = '22222222-2222-4222-8222-222222222222', otherDevice = '33333333-3333-4333-8333-333333333333';
const ids = [...'456789a'].map(x => `${x.repeat(8)}-${x.repeat(4)}-4${x.repeat(3)}-8${x.repeat(3)}-${x.repeat(12)}`);

test('search authorization follows the current sidebar policy, including journal-owned null sources', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-search-'));
  try {
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT, preview TEXT, attached_thread_parent_id TEXT)');
    const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    add.run(ids[0], 'visible', null, 0, 'vscode', 'user', 'yes', null);
    add.run(ids[1], 'old title', 'renamed', 0, 'vscode', 'agent_created_thread', 'yes', null);
    add.run(ids[2], 'owned', null, 0, 'vscode', null, 'yes', null);
    add.run(ids[3], 'not owned', null, 0, 'vscode', null, 'yes', null);
    add.run(ids[4], 'archived', null, 1, 'vscode', 'user', 'yes', null);
    add.run(ids[5], 'subagent', null, 0, 'vscode', 'user', 'yes', ids[0]);
    add.run(ids[6], 'empty preview', null, 0, 'vscode', 'user', '', null); db.close();
    const allowed = authorizedSearchThreads(ids, { codexHome: dir, phoneThreadIds: [ids[2]] });
    assert.deepEqual([...allowed.entries()], [[ids[0], 'visible'], [ids[1], 'renamed'], [ids[2], 'owned']]);
    assert.throws(() => authorizedSearchThreads(['not-a-uuid'], { codexHome: dir }), { code: 'invalid' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('renamed titles are searched under the same authorization policy and paged without a sidebar cap', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'phone-title-search-'));
  try {
    const db = new DatabaseSync(join(dir, 'state_5.sqlite'));
    db.exec('CREATE TABLE threads (id TEXT, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT, preview TEXT, attached_thread_parent_id TEXT)');
    const add = db.prepare('INSERT INTO threads VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const all = Array.from({ length: 24 }, (_, i) => `${i.toString(16).padStart(8, '0')}-1111-4111-8111-111111111111`);
    for (const id of all) add.run(id, '', '手机验收_100%', 0, 'vscode', 'user', 'yes', null);
    add.run(ids[0], '', '手机验收_100%', 1, 'vscode', 'user', 'yes', null);
    add.run(ids[1], '', '手机验收_100%', 0, 'vscode', null, 'yes', null);
    add.run(ids[2], '', '手机验收_100%', 0, 'vscode', null, 'yes', null);
    add.run(ids[3], '', '手机验收_100%', 0, 'vscode', 'user', 'yes', ids[0]); db.close();
    const first = searchAuthorizedTitles('验收_100%', { codexHome: dir, phoneThreadIds: [ids[1]] });
    assert.equal(first.results.length, 20); assert.ok(first.nextCursor);
    const second = searchAuthorizedTitles('验收_100%', { codexHome: dir, phoneThreadIds: [ids[1]], after: first.nextCursor });
    assert.deepEqual([...first.results, ...second.results].map(x => x.id), [...all, ids[1]]);
    assert.equal(second.nextCursor, null);
    assert.equal(searchAuthorizedTitles('验收_101%', { codexHome: dir }).results.length, 0);
    const search = createThreadSearch({ hostId, cursorKey: Buffer.alloc(32, 2),
      searchTitles: (q, opts) => searchAuthorizedTitles(q, { ...opts, codexHome: dir }),
      request: async () => ({ data: [{ thread: { id: ids[2] }, snippet: '正文命中' }] }),
      authorize: async () => new Map([[ids[2], '正文任务']]) });
    const a = await search.search({ query: '验收_100%', deviceId, phoneThreadIds: [ids[1]] });
    const b = await search.search({ query: '验收_100%', deviceId, phoneThreadIds: [ids[1]], cursor: a.nextCursor });
    assert.equal(a.results.length, 20); assert.equal(b.results.length, 6);
    assert.deepEqual(b.results.at(-1), { id: ids[2], title: '正文任务', snippet: '正文命中' }); assert.equal(b.nextCursor, null);
    await assert.rejects(search.search({ query: '其他', deviceId, cursor: a.nextCursor }), { code: 'invalid-cursor' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('native search is projected and cursor bound to host, device, query and expiry', async () => {
  let clock = 1000; const calls = [];
  const search = createThreadSearch({ hostId, cursorKey: Buffer.alloc(32, 7), now: () => clock, ttlMs: 1000,
    request: async (method, params) => { calls.push({ method, params }); return { data: [{ thread: { id: ids[0], path: '/private', turns: [{ secret: 'hidden' }] }, snippet: '正文 匹配\n片段' }, { thread: { id: ids[4] }, snippet: 'not authorized' }], nextCursor: 'native-cursor' }; },
    authorize: async () => new Map([[ids[0], '可见任务']]),
  });
  const first = await search.search({ query: ' 手机助手 ', deviceId });
  assert.deepEqual(first.results, [{ id: ids[0], title: '可见任务', snippet: '正文 匹配 片段' }]);
  assert.equal(JSON.stringify(first).includes('/private'), false); assert.equal(JSON.stringify(first).includes('hidden'), false);
  assert.equal(calls[0].method, 'thread/search'); assert.equal(calls[0].params.searchTerm, '手机助手');
  assert.deepEqual(calls[0].params.sourceKinds, ['vscode']); assert.equal(calls[0].params.limit, 20);
  await search.search({ query: '手机助手', cursor: first.nextCursor, deviceId }); assert.equal(calls[1].params.cursor, 'native-cursor');
  for (const input of [{ query: 'other', deviceId }, { query: '手机助手', deviceId: otherDevice }]) await assert.rejects(search.search({ ...input, cursor: first.nextCursor }), { code: 'invalid-cursor' });
  const foreign = createThreadSearch({ hostId, cursorKey: randomBytes(32), now: () => clock, request: async () => ({ data: [] }) });
  await assert.rejects(foreign.search({ query: '手机助手', deviceId, cursor: first.nextCursor }), { code: 'invalid-cursor' });
  clock += 1000; await assert.rejects(search.search({ query: '手机助手', deviceId, cursor: first.nextCursor }), { code: 'invalid-cursor' });
  assert.equal(calls.length, 2, 'invalid cursors do not reach the desktop');
});

test('search rejects malformed responses and cancellation without returning a result', async () => {
  for (const data of [null, {}, { data: Array(21).fill({}) }, { data: [], nextCursor: 'x'.repeat(2049) }]) {
    const search = createThreadSearch({ hostId, request: async () => data, authorize: async () => new Map() });
    await assert.rejects(search.search({ query: 'x', deviceId }), { code: 'unavailable' });
  }
  let release, cancelled = false; const gate = new Promise(resolve => { release = resolve; });
  const search = createThreadSearch({ hostId, request: async () => { await gate; return { data: [] }; } });
  const pending = search.search({ query: 'x', deviceId, isCancelled: () => cancelled }); cancelled = true; release();
  await assert.rejects(pending, { code: 'unavailable' });
  for (const query of ['', 'x\ny', '超'.repeat(171)]) await assert.rejects(search.search({ query, deviceId }), { code: 'invalid' });
});
