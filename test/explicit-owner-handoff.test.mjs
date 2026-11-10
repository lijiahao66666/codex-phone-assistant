import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

const unsubscribes = f => f.requests.filter(request => request.method === 'thread/unsubscribe');

test('explicit handoff releases an empty thread while a phone is still following, only after confirmed closure', async () => {
  const f = await fixture({ data: [], nextCursor: null }, { disableAutoClosed: true });
  try {
    await f.resume();
    f.follower(true, 'phone', { phone: true });
    await until(() => f.snapshots().length > 1, 'phone baseline');
    assert.equal(f.local.owner.canPerformThreadAction(threadId), true);
    const snapshots = f.snapshots().length;
    const release = f.local.owner.releaseThreadForHandoff(threadId);
    await until(() => unsubscribes(f).length === 1, 'explicit unsubscribe');
    assert.equal(f.local.owner.isThreadReleasing(threadId), true);
    await assert.rejects(f.local.startTurn(threadId, 'late write'), { code: 'unavailable' });
    f.reply(unsubscribes(f)[0], { status: 'unsubscribed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.local.owner.isThreadOwned(threadId), true, 'ACK alone must retain ownership');
    f.notify({ method: 'thread/closed', params: { threadId } });
    assert.equal(await release, true);
    assert.equal(f.local.owner.isThreadOwned(threadId), false);
    assert.equal(f.local.releasedThreads.has(threadId), true);
    assert.equal(f.snapshots().length, snapshots, 'handoff must not clear Desktop history');
  } finally { await f.close(); }
});

test('explicit handoff rejects active work and outstanding follower controls', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: null }, { holdMethods: ['thread/compact/start'] });
  try {
    await f.resume();
    f.notify({ method: 'thread/status/changed', params: { threadId, status: { type: 'active' } } });
    await until(() => f.state().threadRuntimeStatus.type === 'active', 'active status');
    await assert.rejects(f.local.owner.releaseThreadForHandoff(threadId), { code: 'unavailable' });
    f.notify({ method: 'thread/status/changed', params: { threadId, status: { type: 'idle' } } });
    await until(() => f.state().threadRuntimeStatus.type === 'idle', 'idle status');
    f.native('thread-follower-compact-thread');
    await until(() => f.requests.some(request => request.method === 'thread/compact/start'), 'in-flight follower action');
    await assert.rejects(f.local.owner.releaseThreadForHandoff(threadId), { code: 'unavailable' });
    assert.equal(unsubscribes(f).length, 0);
  } finally { await f.close(); }
});

test('a definite handoff RPC rejection retains the writer and reopens its admission gate', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    const release = assert.rejects(f.local.owner.releaseThreadForHandoff(threadId), /fixture rejection/);
    await until(() => unsubscribes(f).length === 1, 'explicit unsubscribe');
    f.reject(unsubscribes(f)[0]);
    await release;
    assert.equal(f.local.owner.isThreadOwned(threadId), true);
    assert.equal(f.local.owner.isThreadReleasing(threadId), false);
  } finally { await f.close(); }
});

test('a malformed handoff acknowledgement retains the uncertain writer behind its gate', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    const release = assert.rejects(f.local.owner.releaseThreadForHandoff(threadId));
    await until(() => unsubscribes(f).length === 1, 'explicit unsubscribe');
    f.reply(unsubscribes(f)[0], { status: 'unexpected' });
    await release;
    assert.equal(f.local.owner.isThreadOwned(threadId), true);
    assert.equal(f.local.owner.isThreadReleasing(threadId), true);
    await assert.rejects(f.local.owner.releaseThreadForHandoff(threadId), { code: 'unavailable' });
    assert.equal(unsubscribes(f).length, 1);
  } finally { await f.close(); }
});
