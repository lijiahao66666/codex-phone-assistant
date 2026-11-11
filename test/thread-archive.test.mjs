import test from 'node:test';
import assert from 'node:assert/strict';
import { createThreadArchive } from '../src/desktop/thread-archive.mjs';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

const service = (f, adapters = {}) => createThreadArchive({ localOwner: f.local,
  discover: async () => ({ kind: 'owner', ownerId: f.local.ownerId() }),
  isAuthorized: () => true, isLocked: () => false, ...adapters });

test('native owner is explicitly unsupported and never receives helper writes or releases', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: null });
  try {
    await f.resume();
    const before = f.requests.length;
    const archive = service(f, { discover: async () => ({ kind: 'owner', ownerId: 'native-owner' }) });
    assert.deepEqual(await archive.inspect(threadId), {
      available: false, reason: 'not-supported-desktop-owner', ownerKind: 'desktop',
    });
    await assert.rejects(archive.archive(threadId), { code: 'not-supported-desktop-owner' });
    assert.equal(f.requests.length, before);
    assert.equal(f.local.owner.isThreadOwned(threadId), true);
  } finally { await f.close(); }
});

test('unknown owners, denied devices and journal locks fail closed without runtime mutation', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    const before = f.requests.length;
    for (const adapters of [
      { discover: async () => ({ kind: 'none' }) },
      { discover: async () => { throw new Error('bus down'); } },
      { isAuthorized: () => false },
      { isAuthorized: () => { throw new Error('index unavailable'); } },
      { isAuthorized: async () => true },
      { isLocked: () => true },
      { isLocked: () => undefined },
    ]) await assert.rejects(service(f, adapters).archive(threadId), { code: 'unavailable' });
    await assert.rejects(service(f).archive('invalid'), { reason: 'invalid-thread' });
    assert.equal(f.requests.length, before);
  } finally { await f.close(); }
});

test('a discovered desktop owner remains explicitly unsupported when helper is not ready', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    f.local.ownerId = () => null;
    const archive = service(f, { discover: async () => ({ kind: 'owner', ownerId: 'native-owner' }) });
    const before = f.requests.length;
    assert.deepEqual(await archive.inspect(threadId), {
      available: false, reason: 'not-supported-desktop-owner', ownerKind: 'desktop',
    });
    await assert.rejects(archive.archive(threadId), { code: 'not-supported-desktop-owner' });
    assert.equal(f.requests.length, before);
  } finally { await f.close(); }
});

test('authorized helper-owned idle archive dispatches once without unsubscribe and broadcasts the result', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: null });
  try {
    await f.resume();
    const archive = service(f);
    assert.deepEqual(await archive.inspect(threadId), { available: true, reason: null, ownerKind: 'helper' });
    const before = f.requests.length;
    await archive.archive(threadId);
    assert.deepEqual(f.requests.slice(before).map(({ method }) => method), ['thread/archive']);
    await until(() => f.frames.some(frame => frame.method === 'thread-archived'), 'archive broadcast');
  } finally { await f.close(); }
});

test('device revoke, journal lock or activity appearing during discovery blocks dispatch', async () => {
  for (const change of ['revoke', 'lock', 'active', 'owner']) {
    const f = await fixture({ data: [], nextCursor: null });
    try {
      await f.resume();
      let authorized = true, locked = false;
      const archive = service(f, {
        isAuthorized: () => authorized, isLocked: () => locked,
        discover: async () => {
          const ownerId = f.local.ownerId();
          if (change === 'revoke') authorized = false;
          if (change === 'lock') locked = true;
          if (change === 'active') {
            f.notify({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } });
            await until(() => f.state()?.threadRuntimeStatus?.type === 'active', 'active runtime');
          }
          if (change === 'owner') f.local.ownerId = () => 'replacement-helper';
          return { kind: 'owner', ownerId };
        },
      });
      const before = f.requests.length;
      await assert.rejects(archive.archive(threadId));
      assert.equal(f.requests.length, before, change);
    } finally { await f.close(); }
  }
});

test('LocalOwner itself rejects archive of unowned and previously released threads', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    const before = f.requests.length;
    await assert.rejects(f.local.threadAction(threadId, 'archive'), { code: 'unavailable' });
    f.local.releasedThreads.add(threadId);
    await assert.rejects(f.local.threadAction(threadId, 'archive'), { code: 'unavailable' });
    assert.equal(f.requests.length, before);
  } finally { await f.close(); }
});

test('helper identity changing after inspection cannot authorize a dispatch', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    let checks = 0;
    const archive = service(f, { isLocked: () => {
      if (++checks === 3) f.local.ownerId = () => 'replacement-helper';
      return false;
    } });
    const before = f.requests.length;
    await assert.rejects(archive.archive(threadId), { code: 'unavailable' });
    assert.equal(checks, 3);
    assert.equal(f.requests.length, before);
  } finally { await f.close(); }
});

test('archive preserves RPC rejection and unknown timeout without retrying', async () => {
  for (const outcome of ['rejected', 'timeout']) {
    const f = await fixture({ data: [], nextCursor: null }, {
      holdMethods: ['thread/archive'], timeout: outcome === 'timeout' ? 100 : 1000,
    });
    try {
      await f.resume();
      const operation = service(f).archive(threadId);
      const rejected = assert.rejects(operation, error => outcome === 'rejected'
        ? error.rpcError?.message === 'archive rejected' : !error.rpcError);
      await until(() => f.requests.some(request => request.method === 'thread/archive'), 'archive request');
      if (outcome === 'rejected') f.reject(f.requests.find(request => request.method === 'thread/archive'), 'archive rejected');
      await rejected;
      assert.equal(f.requests.filter(request => request.method === 'thread/archive').length, 1);
      assert.equal(f.local.uncertainWrites, true);
    } finally { await f.close(); }
  }
});
