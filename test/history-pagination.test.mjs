import test from 'node:test';
import assert from 'node:assert/strict';
import { makeWindow, makePage } from '../src/desktop/history-pagination.mjs';
const conversation = () => ({ id: 't', runtimeStatus: 'active', requests: [{ id: 'q' }], history: { complete: true }, turns: Array.from({ length: 8 }, (_, i) => ({ id: String(i), items: [{ id: `i${i}`, text: 'x'.repeat(100) }] })) });
test('live window supports strictly cursor-based retrieval without duplicates', () => {
  const full = conversation(), window = makeWindow(full, { recentCount: 3 });
  assert.deepEqual(window.turns.map(t => t.id), ['5','6','7']); assert.equal(window.runtimeStatus, 'active'); assert.equal(window.requests[0].id, 'q');
  const opts = { recentCount: 3, historicalHash: window.history.historicalHash, maxBytes: 350 };
  let before = window.history.cursor, turns = [...window.turns];
  while (before) { const page = makePage(full, { ...opts, before }); turns = [...page.turns, ...turns]; before = page.nextBefore; }
  assert.deepEqual(turns, full.turns);
});
test('recent updates keep older cursor stable; edits or reorder of history invalidate it', () => {
  const full = conversation(), window = makeWindow(full), hash = window.history.historicalHash;
  full.turns[7].items[0].text = 'new'; assert.doesNotThrow(() => makePage(full, { historicalHash: hash, before: window.history.cursor }));
  full.turns[1].items[0].text = 'edited'; assert.throws(() => makePage(full, { historicalHash: hash, before: window.history.cursor }), /history-changed/);
});
test('unbounded or invalid pages are rejected', () => {
  const full = conversation(), window = makeWindow(full);
  assert.equal(makePage(full, { historicalHash: window.history.historicalHash, before: window.history.cursor, maxBytes: 1 }).turns.length, 1);
  assert.throws(() => makePage(full, { historicalHash: window.history.historicalHash, before: window.history.cursor, maxBytes: 1, maxSingleTurnBytes: 1 }), /turn-too-large/);
  assert.throws(() => makePage(full, { historicalHash: window.history.historicalHash, before: 'missing' }), /invalid-cursor/);
  full.turns[1].id = full.turns[0].id; assert.throws(() => makeWindow(full), /unstable/);
});
test('a 623 KiB historical turn loads alone instead of exceeding the default page target', () => {
  const full = conversation(); full.turns[4].items[0].text = 'x'.repeat(623 * 1024);
  const window = makeWindow(full), page = makePage(full, { historicalHash: window.history.historicalHash, before: window.history.cursor });
  assert.equal(page.turns.length, 1); assert.equal(page.turns[0].items[0].text.length, 623 * 1024);
});
test('temporary image handles do not change historical content identity', () => {
  const full = conversation(); full.turns[0].items[0].images = ['old'];
  const window = makeWindow(full), hash = window.history.historicalHash;
  const first = makePage(full, { historicalHash: hash, before: window.history.cursor, maxBytes: 4096 });
  full.turns[0].items[0].images = ['new'];
  const second = makePage(full, { historicalHash: hash, before: window.history.cursor, maxBytes: 4096 });
  assert.equal(second.pageHash, first.pageHash);
  assert.equal(makeWindow(full).history.historicalHash, hash);
  assert.notEqual(makeWindow(full).history.mediaRevision, window.history.mediaRevision);
});
test('media identity tracks payload, type and location without changing content identity', () => {
  const full = conversation();
  full.turns[0].items[0].images = ['one'];
  full.turns[1].items[0].videos = [{ id: 'v1', mime: 'video/mp4' }];
  const initial = makeWindow(full).history;
  full.turns[0].items[0].images = ['two'];
  const changed = makeWindow(full).history;
  assert.equal(changed.historicalHash, initial.historicalHash);
  assert.notEqual(changed.mediaRevision, initial.mediaRevision);
  delete full.turns[0].items[0].images;
  full.turns[2].items[0].images = ['one'];
  const moved = makeWindow(full).history;
  assert.equal(moved.historicalHash, initial.historicalHash);
  assert.notEqual(moved.mediaRevision, initial.mediaRevision);
  delete full.turns[1].items[0].videos;
  full.turns[1].items[0].images = [{ id: 'v1', mime: 'video/mp4' }];
  assert.notEqual(makeWindow(full).history.mediaRevision, moved.mediaRevision);
  full.turns[0].items[0].text = 'edited';
  assert.notEqual(makeWindow(full).history.historicalHash, initial.historicalHash);
});
test('media digest distinguishes changes at every historical item position', () => {
  const variants = [];
  for (let i = 0; i < 5; i++) {
    for (const [field, value] of [['images', ['image-a']], ['images', ['image-b']], ['videos', [{ id: 'video-a', mime: 'video/mp4' }]]]) {
      const view = conversation(); view.turns[i].items[0][field] = value;
      variants.push(makeWindow(view).history);
    }
  }
  assert.equal(new Set(variants.map(value => value.historicalHash)).size, 1);
  assert.equal(new Set(variants.map(value => value.mediaRevision)).size, variants.length);
});
