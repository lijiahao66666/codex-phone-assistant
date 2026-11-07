import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRecordedHistoryPager } from '../src/desktop/recorded-history-page.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const parent = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const scope = { hostId: 'host', deviceId: 'phone' };
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), 'recorded-page-'));
  const state = new DatabaseSync(join(home, 'state_5.sqlite'));
  state.exec('CREATE TABLE threads (id TEXT PRIMARY KEY, title TEXT, name TEXT, archived INTEGER, source TEXT, thread_source TEXT, cwd TEXT)');
  const history = new DatabaseSync(join(home, 'thread_history_1.sqlite'));
  history.exec(`CREATE TABLE thread_turns (thread_id TEXT, turn_id TEXT, rollout_ordinal INTEGER, status TEXT, started_at INTEGER, PRIMARY KEY(thread_id,turn_id));
    CREATE UNIQUE INDEX idx_thread_turns_page ON thread_turns(thread_id,rollout_ordinal);
    CREATE TABLE thread_items (thread_id TEXT, turn_id TEXT, item_id TEXT, rollout_ordinal INTEGER, item_json TEXT, updated_at_ordinal INTEGER, PRIMARY KEY(thread_id,turn_id,item_id));
    CREATE UNIQUE INDEX idx_thread_items_page ON thread_items(thread_id,rollout_ordinal);
    CREATE INDEX idx_thread_items_by_turn_page ON thread_items(thread_id,turn_id,rollout_ordinal);
    CREATE INDEX idx_thread_items_updated_page ON thread_items(thread_id,updated_at_ordinal);
    CREATE TABLE thread_history_projection_state(thread_id TEXT PRIMARY KEY,next_rollout_ordinal INTEGER,next_rollout_byte_offset INTEGER);`);
  let ordinal = 1;
  const project = thread => history.prepare('INSERT INTO thread_history_projection_state VALUES (?, ?, ?) ON CONFLICT(thread_id) DO UPDATE SET next_rollout_ordinal=excluded.next_rollout_ordinal,next_rollout_byte_offset=excluded.next_rollout_byte_offset').run(thread, ordinal, ordinal * 100);
  const register = (thread = id, options = {}) => {
    state.prepare('INSERT INTO threads VALUES (?, ?, NULL, 0, ?, ?, ?)').run(thread, 'History', options.parent ? JSON.stringify({ subagent: { thread_spawn: { parent_thread_id: options.parent } } }) : 'vscode', options.parent ? 'subagent' : 'user', '/project/app');
    project(thread);
  };
  const turn = (turnId, thread = id, status = 'completed') => { history.prepare('INSERT INTO thread_turns VALUES (?, ?, ?, ?, ?)').run(thread, turnId, ordinal++, status, 1); project(thread); };
  const item = (turnId, itemId, text = itemId, thread = id, extra = {}) => {
    const value = { id: itemId, type: 'agentMessage', text, phase: 'final_answer', ...extra };
    history.prepare('INSERT INTO thread_items VALUES (?, ?, ?, ?, ?, ?)').run(thread, turnId, itemId, ordinal, JSON.stringify(value), ordinal);
    ordinal++; project(thread);
  };
  const update = (turnId, itemId, text, thread = id) => {
    history.prepare('UPDATE thread_items SET item_json=?,updated_at_ordinal=? WHERE thread_id=? AND turn_id=? AND item_id=?').run(JSON.stringify({ id: itemId, type: 'agentMessage', text }), ordinal++, thread, turnId, itemId);
    project(thread);
  };
  register();
  return { home, state, history, register, turn, item, update, pager: createRecordedHistoryPager({ codexHome: home }),
    async close() { history.close(); state.close(); await rm(home, { recursive: true, force: true }); } };
}

test('reads recent content first and retrieves every item of large turns without OFFSET or silent limits', async () => {
  const f = await fixture();
  try {
    for (let turn = 0; turn < 15; turn++) {
      f.turn('turn-' + turn);
      for (let item = 0; item < (turn === 14 ? 450 : 2); item++) f.item('turn-' + turn, `item-${turn}-${item}`);
    }
    const read = cursor => f.pager.read(id, { scope, cursor, maxTurns: 3, maxItems: 75 });
    let page = read(null), count = 0;
    assert.equal(page.turns.at(-1).id, 'turn-14');
    assert.equal(page.turns.at(-1).items.at(-1).id, 'item-14-449');
    assert.equal(page.turns.at(-1).itemsPagination.hasLoadedOldest, false);
    const merged = new Map();
    for (;;) {
      assert.ok(++count < 30);
      assert.equal(page.runtimeStatus, 'unknown'); assert.deepEqual(page.requests, []);
      for (const turn of page.turns) merged.set(turn.id, [...turn.items.map(item => item.id), ...(merged.get(turn.id) || [])]);
      if (page.nextCursor === null) break;
      page = read(page.nextCursor);
    }
    assert.equal(merged.size, 15);
    assert.deepEqual(merged.get('turn-14'), Array.from({ length: 450 }, (_, item) => `item-14-${item}`));
    assert.equal([...merged.values()].flat().length, 478);
    assert.equal(page.history.olderComplete, true);
    assert.equal(page.history.complete, false, 'index completion must not claim the entire live rollout is complete');
  } finally { await f.close(); }
});

test('single items above 128 KB load alone and items beyond the explicit hard cap produce an error', async () => {
  const f = await fixture();
  try {
    f.turn('one'); f.item('one', 'large', 'x'.repeat(200 * 1024));
    const page = f.pager.read(id, { maxBytes: 1024 });
    assert.equal(page.turns[0].items[0].text.length, 200 * 1024);
    assert.ok(page.page.bytes > 128 * 1024);
    assert.throws(() => f.pager.read(id, { maxSingleItemBytes: 128 * 1024 }), error => error.code === 'item-too-large' && error.itemId === 'large');
  } finally { await f.close(); }
});

test('signed cursors bind thread, parent, device, project and expiration', async () => {
  const f = await fixture();
  try {
    f.turn('one'); f.item('one', 'a'); f.item('one', 'b'); f.register(other); f.turn('two', other); f.item('two', 'c', 'c', other);
    let now = 1000;
    const pager = createRecordedHistoryPager({ codexHome: f.home, cursorSecret: Buffer.alloc(32, 7), ttlMs: 1000, now: () => now });
    const options = { scope, projectPath: '/project', maxItems: 1 };
    const first = pager.read(id, options), cursor = first.nextCursor;
    assert.ok(cursor);
    assert.throws(() => pager.read(other, { ...options, cursor }), { code: 'invalid-cursor' });
    assert.throws(() => pager.read(id, { ...options, scope: { ...scope, deviceId: 'other-phone' }, cursor }), { code: 'invalid-cursor' });
    assert.throws(() => pager.read(id, { ...options, projectPath: '/project/app', cursor }), { code: 'invalid-cursor' });
    const [body, signature] = cursor.split('.');
    const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body, 'base64url')), turnBefore: 0 })).toString('base64url') + '.' + signature;
    assert.throws(() => pager.read(id, { ...options, cursor: tampered }), { code: 'invalid-cursor' });
    assert.equal(pager.read(id, { ...options, projectPath: '/sibling' }), null);
    now = 2001;
    assert.throws(() => pager.read(id, { ...options, cursor }), { code: 'invalid-cursor' });
  } finally { await f.close(); }
});

test('subagent access rechecks the actual parent and archive state for every page', async () => {
  const f = await fixture();
  try {
    f.register(other, { parent }); f.turn('child', other); f.item('child', 'a', 'a', other); f.item('child', 'b', 'b', other);
    assert.equal(f.pager.read(other), null);
    assert.equal(f.pager.read(other, { parentThreadId: id }), null);
    const page = f.pager.read(other, { parentThreadId: parent, maxItems: 1 });
    assert.ok(page.nextCursor);
    f.state.prepare('UPDATE threads SET archived=1 WHERE id=?').run(other);
    assert.equal(f.pager.read(other, { parentThreadId: parent, cursor: page.nextCursor }), null);
  } finally { await f.close(); }
});

test('tail appends do not invalidate a frozen historical cursor and do not leak into its pages', async () => {
  const f = await fixture();
  try {
    f.turn('one'); f.item('one', 'a'); f.item('one', 'b'); f.item('one', 'c');
    const page = f.pager.read(id, { maxItems: 1 });
    f.item('one', 'd'); f.turn('new'); f.item('new', 'e');
    const next = f.pager.read(id, { cursor: page.nextCursor });
    assert.deepEqual(next.turns.map(turn => turn.id), ['one']);
    assert.deepEqual(next.turns[0].items.map(item => item.id), ['a', 'b']);
    assert.equal(next.nextCursor, null);
    assert.equal(f.pager.read(id).turns.at(-1).id, 'new');
  } finally { await f.close(); }
});

test('updates to the indexed historical region and projection rewind invalidate old cursors', async () => {
  const f = await fixture();
  try {
    f.turn('one'); f.item('one', 'a'); f.item('one', 'b');
    const page = f.pager.read(id, { maxItems: 1 });
    f.update('one', 'a', 'changed');
    assert.throws(() => f.pager.read(id, { cursor: page.nextCursor }), { code: 'history-changed' });
    const current = f.pager.read(id, { maxItems: 1 });
    f.history.prepare('UPDATE thread_history_projection_state SET next_rollout_ordinal=1,next_rollout_byte_offset=1 WHERE thread_id=?').run(id);
    assert.throws(() => f.pager.read(id, { cursor: current.nextCursor }), { code: 'history-changed' });
  } finally { await f.close(); }
});

test('budget boundaries preserve empty turns, unsupported activities and every older item', async () => {
  const f = await fixture();
  try {
    f.turn('empty'); f.turn('items');
    f.item('items', 'a', 'x'.repeat(800)); f.item('items', 'b', 'x'.repeat(800));
    f.item('items', 'unknown', 'hidden', id, { type: 'futureActivity', secret: 'never expose' });
    let cursor = null, merged = [], turns = new Set();
    do {
      const page = f.pager.read(id, { cursor, maxBytes: 1024, maxItems: 2, maxTurns: 1 });
      assert.ok(page.turns.length > 0);
      for (const turn of page.turns) { turns.add(turn.id); merged = [...turn.items, ...merged]; }
      cursor = page.nextCursor;
    } while (cursor);
    assert.deepEqual(merged.map(item => item.id), ['a', 'b', 'unknown']);
    assert.equal(merged[2].type, 'error');
    assert.doesNotMatch(JSON.stringify(merged), /never expose/);
    assert.ok(turns.has('empty'));
  } finally { await f.close(); }
});

test('reads leave both databases byte-for-byte unchanged and reject corrupt indexed items', async () => {
  const f = await fixture();
  try {
    f.turn('running', id, 'inProgress'); f.item('running', 'a');
    const stateBefore = await readFile(join(f.home, 'state_5.sqlite'));
    const historyBefore = await readFile(join(f.home, 'thread_history_1.sqlite'));
    const page = f.pager.read(id);
    assert.equal(page.turns[0].status, 'unknown');
    assert.deepEqual(await readFile(join(f.home, 'state_5.sqlite')), stateBefore);
    assert.deepEqual(await readFile(join(f.home, 'thread_history_1.sqlite')), historyBefore);
    f.history.prepare('UPDATE thread_items SET item_json=? WHERE thread_id=?').run('{broken', id);
    assert.throws(() => f.pager.read(id), { code: 'history-invalid' });
  } finally { await f.close(); }
});


test('phone-created rows require the current host journal authorization on every page', async () => {
  const f = await fixture();
  try {
    f.turn('one'); f.item('one', 'a'); f.item('one', 'b');
    f.state.prepare('UPDATE threads SET thread_source=NULL WHERE id=?').run(id);
    assert.equal(f.pager.read(id, { scope }), null);
    assert.equal(f.pager.read(id, { scope, phoneThreadIds: [other] }), null);
    const first = f.pager.read(id, { scope, phoneThreadIds: [id], maxItems: 1 });
    assert.ok(first.nextCursor);
    assert.equal(f.pager.read(id, { scope, cursor: first.nextCursor }), null);
    const next = f.pager.read(id, { scope, phoneThreadIds: [id], cursor: first.nextCursor });
    assert.deepEqual(next.turns[0].items.map(item => item.id), ['a']);
    f.state.prepare('UPDATE threads SET archived=1 WHERE id=?').run(id);
    assert.equal(f.pager.read(id, { scope, phoneThreadIds: [id], cursor: first.nextCursor }), null);
  } finally { await f.close(); }
});
