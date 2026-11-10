import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

const otherThreadId = '22222222-2222-4222-8222-222222222222';
const closed = id => ({ method: 'thread/closed', params: { threadId: id } });
const unsubscribes = f => f.requests.filter(request => request.method === 'thread/unsubscribe');

async function releasing(options = {}) {
  const f = await fixture({ data: [turn('latest')], nextCursor: null }, {
    graceMs: 15, timeout: 1000, disableAutoClosed: true, ...options,
  });
  await f.resume();
  const count = f.snapshots().length;
  f.follower(true);
  await until(() => f.snapshots().length > count, 'follower baseline');
  f.follower(false);
  await until(() => unsubscribes(f).length === 1, 'unsubscribe dispatched');
  return f;
}

async function retainedAndGated(f) {
  assert.equal(f.local.owner.isThreadOwned(threadId), true);
  assert.equal(f.local.owner.isThreadReleasing(threadId), true);
  assert.equal(f.local.threads.has(threadId), true);
  assert.equal(f.local.releasedThreads.has(threadId), false);
  const count = f.requests.length;
  await assert.rejects(f.local.startTurn(threadId, 'must wait for confirmed release'), { code: 'unavailable' });
  await assert.rejects(f.local.request('thread/settings/update', { threadId, model: 'blocked' }), { code: 'unavailable' });
  const control = f.native('thread-follower-compact-thread');
  await until(() => f.replyFor(control), 'native control gated');
  assert.equal(f.replyFor(control).resultType, 'error');
  assert.equal(f.requests.length, count, 'no phone or native control reaches the runtime');
  const discovery = f.native('thread-owner-discovery', { hostId: 'local' });
  await until(() => f.replyFor(discovery), 'known writer discovery');
  assert.equal(f.replyFor(discovery).resultType, 'success', 'pending release must keep advertising the existing writer');
}

function assertReleased(f) {
  assert.equal(f.local.owner.isThreadOwned(threadId), false);
  assert.equal(f.local.owner.isThreadReleasing(threadId), false);
  assert.equal(f.local.threads.has(threadId), false);
  assert.equal(f.local.releasedThreads.has(threadId), true);
  assert.equal(f.local.uncertainWrites, false);
  assert.equal(f.local.pendingWrites, 0);
}

test('unsubscribe ACK alone and a different thread closing keep writer ownership and controls gated', async () => {
  for (const status of ['unsubscribed', 'notSubscribed']) {
    const f = await releasing();
    try {
      const request = unsubscribes(f)[0];
      f.reply(request, { status });
      await until(() => !f.local.client.pending.has(request.id), 'unsubscribe ACK consumed');
      await retainedAndGated(f);
      f.notify(closed(otherThreadId));
      await retainedAndGated(f);
      f.notify(closed(threadId));
      await until(() => f.local.releasedThreads.has(threadId), 'matching thread closes');
      assertReleased(f);
    } finally { await f.close(); }
  }
});

test('matching closed arriving before unsubscribe ACK is remembered but cannot release by itself', async () => {
  const f = await releasing();
  try {
    f.notify(closed(threadId));
    await retainedAndGated(f);
    f.reply(unsubscribes(f)[0], { status: 'unsubscribed' });
    await until(() => f.local.releasedThreads.has(threadId), 'ACK confirms prior closed event');
    assertReleased(f);
  } finally { await f.close(); }
});

test('notLoaded ACK confirms no writer remains without requiring a closed notification', async () => {
  const f = await releasing();
  try {
    f.reply(unsubscribes(f)[0], { status: 'notLoaded' });
    await until(() => f.local.releasedThreads.has(threadId), 'already unloaded thread released');
    assertReleased(f);
  } finally { await f.close(); }
});

test('ACK followed by missing closed notification times out into an uncertain gate and never force unlocks', async () => {
  const f = await releasing({ timeout: 100 });
  try {
    const failures = [];
    f.local.on('idleReleaseFailed', failure => failures.push(failure));
    f.reply(unsubscribes(f)[0], { status: 'unsubscribed' });
    await until(() => f.local.uncertainWrites, 'unconfirmed writer release times out');
    await retainedAndGated(f);
    assert.equal(failures.length, 1);
    assert.equal(failures[0].threadId, threadId);
    assert.equal(failures[0].error.code, 'outcome-unknown');
    assert.equal(f.local.pendingWrites, 0, 'timed out confirmation has no leaked pending operation');
    assert.equal(f.local.client.listenerCount('unavailable'), 1, 'temporary release listener is removed');
    await assert.rejects(f.local.close(), { code: 'tasks-active' });
    f.notify(closed(threadId));
    await retainedAndGated(f);
    assert.equal(unsubscribes(f).length, 1, 'late notification cannot silently clear an uncertain operation');
  } finally { await f.close(); }
});
