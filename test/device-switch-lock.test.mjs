import test from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_SWITCH_LOCK, withDeviceSwitchLock } from '../public/device-switch-lock.mjs';

function sharedLocks() {
  let held = false;
  return { async request(name, options, fn) {
    assert.equal(name, DEVICE_SWITCH_LOCK); assert.deepEqual(options, { mode: 'exclusive', ifAvailable: true });
    if (held) return fn(null);
    held = true; try { return await fn({ name }); } finally { held = false; }
  } };
}

test('overlapping switches across tabs cannot both enter; lock releases after completion', async () => {
  const locks = sharedLocks(); let release, entered = 0;
  const first = withDeviceSwitchLock({ locks, run: async () => { entered++; await new Promise(resolve => { release = resolve; }); return 7; } });
  assert.deepEqual(await withDeviceSwitchLock({ locks, run: async () => { entered++; } }), { status: 'busy' });
  assert.equal(entered, 1); release(); assert.deepEqual(await first, { status: 'completed', value: 7 });
  assert.deepEqual(await withDeviceSwitchLock({ locks, run: async () => 8 }), { status: 'completed', value: 8 });
});

test('unsupported, rejected and pre-cancelled lock requests never dispatch the mutation', async () => {
  let calls = 0; const run = () => { calls++; };
  assert.equal((await withDeviceSwitchLock({ locks: null, run })).status, 'unsupported');
  assert.equal((await withDeviceSwitchLock({ locks: { request: async () => { throw new Error('denied'); } }, run })).status, 'unavailable');
  const controller = new AbortController(); controller.abort();
  assert.equal((await withDeviceSwitchLock({ locks: sharedLocks(), signal: controller.signal, run })).status, 'cancelled');
  assert.equal(calls, 0);
});

test('mutation failure is reported as unknown and is never automatically retried', async () => {
  const locks = sharedLocks(); let calls = 0;
  const result = await withDeviceSwitchLock({ locks, run: async () => { calls++; throw new Error('connection lost'); } });
  assert.equal(result.status, 'outcome-unknown'); assert.equal(calls, 1);
  assert.equal((await withDeviceSwitchLock({ locks, run: async () => 1 })).status, 'completed');
});
