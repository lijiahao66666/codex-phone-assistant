import test from 'node:test';
import assert from 'node:assert/strict';
import { navigateDesktopUnread } from '../src/desktop/native-read-navigation.mjs';

const id = '33333333-3333-4333-8333-333333333333';
const scope = 'a'.repeat(64), other = 'b'.repeat(64);
const native = (ids = [id], key = scope) => ({ status: 'available', canReadUnread: true, scopeKey: key, unreadThreadIds: new Set(ids) });

test('explicit navigation waits for the same native scope to confirm unread is cleared', async () => {
  let state = native(), opened = 0, reads = 0;
  const result = await navigateDesktopUnread(id, scope, { readState: async () => { reads++; return state; }, openThread: async actual => { assert.equal(actual, id); opened++; state = native([]); } });
  assert.deepEqual(result, { read: true }); assert.equal(opened, 1); assert.equal(reads, 2);
});

test('already read, invalid, unavailable or changed identity never opens Desktop', async () => {
  for (const state of [native([]), native([id], other), { status: 'unavailable' }, { ...native(), unreadThreadIds: [] }]) {
    let opened = false;
    await assert.rejects(navigateDesktopUnread(id, scope, { readState: async () => state, openThread: async () => { opened = true; } }), { code: 'unavailable' });
    assert.equal(opened, false);
  }
  await assert.rejects(navigateDesktopUnread('../bad', scope), { code: 'unavailable' });
  await assert.rejects(navigateDesktopUnread(id, 'bad'), { code: 'unavailable' });
});

test('cancel, identity changes and unread timeout cannot report a native confirmation', async () => {
  for (const situation of ['cancel', 'identity', 'unavailable', 'still-unread']) {
    let state = native(), cancelled = false, opened = 0;
    await assert.rejects(navigateDesktopUnread(id, scope, { timeoutMs: 2, pollMs: 1,
      readState: async () => state, isCancelled: () => cancelled,
      openThread: async () => { opened++; if (situation === 'cancel') cancelled = true; if (situation === 'identity') state = native([], other); if (situation === 'unavailable') state = { status: 'unavailable' }; },
    }), { code: 'unavailable' });
    assert.equal(opened, 1);
  }
});
