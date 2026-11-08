import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

const page = () => ({ data: [turn('latest')], nextCursor: 'older' });
const unsubscribe = f => f.requests.filter(r => r.method === 'thread/unsubscribe');
async function departed(f) {
  const count = f.snapshots().length;
  f.follower(true);
  await until(() => f.snapshots().length > count, 'follower baseline');
  f.follower(false);
}

test('an empty follower map without an observed departure never releases ownership', async () => {
  const f = await fixture(page(), { graceMs: 40 });
  try {
    await f.resume(); await delay(90);
    assert.equal(unsubscribe(f).length, 0);
    assert.equal(f.local.owner.isThreadOwned(threadId), true);
  } finally { await f.close(); }
});

test('idle release gates new writes and follower controls, retaining ownership until a real unsubscribe ACK', async () => {
  for (const status of ['unsubscribed', 'notSubscribed', 'notLoaded']) {
    const f = await fixture(page(), { graceMs: 30 });
    try {
      await f.resume(); await departed(f);
      await until(() => unsubscribe(f).length === 1, 'unsubscribe dispatch');
      assert.equal(f.local.owner.isThreadOwned(threadId), true);
      assert.ok(f.state());
      assert.equal(f.local.threads.has(threadId), true);
      const requestCount = f.requests.length;
      await assert.rejects(f.local.startTurn(threadId, 'late'), { code: 'unavailable' });
      await assert.rejects(f.local.request('thread/settings/update', { threadId, model: 'late' }), { code: 'unavailable' });
      assert.equal(f.requests.length, requestCount);
      const control = f.native('thread-follower-compact-thread');
      await until(() => f.replyFor(control), 'gated follower reply');
      assert.equal(f.replyFor(control).resultType, 'error');
      assert.equal(f.requests.some(r => r.method === 'thread/compact/start'), false);
      const discovery = f.native('thread-owner-discovery', { hostId: 'local' });
      await until(() => f.replyFor(discovery), 'writer discovery during release');
      assert.equal(f.replyFor(discovery).resultType, 'success');
      f.reply(unsubscribe(f)[0], { status });
      await until(() => !f.local.owner.isThreadOwned(threadId), 'acknowledged release');
      assert.equal(f.local.threads.has(threadId), false);
      assert.equal(f.state(), null);
      assert.equal(f.local.uncertainWrites, false);
      await assert.rejects(f.local.startTurn(threadId, 'stale local caller'), { code: 'unavailable' });
      await f.local.resume(threadId);
      assert.equal(f.local.releasedThreads.has(threadId), false);
      assert.equal(f.local.owner.isThreadOwned(threadId), true);
    } finally { await f.close(); }
  }
});

test('all physical followers must leave and a late follow cancels the grace period', async () => {
  const f = await fixture(page(), { graceMs: 50 });
  try {
    await f.resume();
    f.follower(true, 'one'); f.follower(true, 'two');
    await delay(15); f.follower(false, 'one'); await delay(80);
    assert.equal(unsubscribe(f).length, 0);
    f.follower(false, 'two'); await delay(20); f.follower(true, 'late'); await delay(80);
    assert.equal(unsubscribe(f).length, 0);
    f.follower(false, 'late'); await until(() => unsubscribe(f).length === 1, 'last follower release');
    f.reply(unsubscribe(f)[0], { status: 'unsubscribed' });
  } finally { await f.close(); }
});

test('a write arriving during grace defers release until its acknowledgement and another grace period', async () => {
  const f = await fixture(page(), { graceMs: 40, holdMethods: ['thread/settings/update'] });
  try {
    await f.resume(); await departed(f); await delay(10);
    const pending = f.local.write('thread/settings/update', { threadId, model: 'same-owner' });
    await until(() => f.requests.some(r => r.method === 'thread/settings/update'), 'pending write');
    await delay(80); assert.equal(unsubscribe(f).length, 0);
    f.reply(f.requests.find(r => r.method === 'thread/settings/update'), {}); await pending;
    await delay(15); assert.equal(unsubscribe(f).length, 0);
    await until(() => unsubscribe(f).length === 1, 'release after acknowledged write');
    f.reply(unsubscribe(f)[0], { status: 'unsubscribed' });
  } finally { await f.close(); }
});

test('unknown runtime, active turns, active goals, unresolved requests and uncertain writes each block release', async () => {
  for (const state of ['unknown', 'active-turn', 'active-goal', 'approval', 'uncertain-write']) {
    const f = await fixture(page(), { graceMs: 30 });
    try {
      await f.resume();
      if (state === 'unknown') f.notify({ method: 'thread/status/changed', params: { threadId, status: { type: 'notLoaded' } } });
      if (state === 'active-turn') f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', status: 'inProgress', items: [] } } });
      if (state === 'active-goal') f.notify({ method: 'thread/goal/updated', params: { threadId, goal: { threadId, status: 'active', objective: 'ongoing' } } });
      if (state === 'approval') f.notify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'latest', command: 'true' } });
      if (state === 'uncertain-write') f.local.uncertainWrites = true;
      await departed(f); await delay(80);
      assert.equal(unsubscribe(f).length, 0, state);
      assert.equal(f.local.owner.isThreadOwned(threadId), true);
    } finally { await f.close(); }
  }
});

test('an active turn left by its viewer can release only after actual idle completion', async () => {
  const f = await fixture(page(), { graceMs: 35 });
  try {
    await f.resume();
    f.notify({ method: 'turn/started', params: { threadId, turn: { id: 'active', status: 'inProgress', items: [] } } });
    await departed(f); await delay(80); assert.equal(unsubscribe(f).length, 0);
    f.notify({ method: 'turn/completed', params: { threadId, turn: { id: 'active', status: 'completed', items: [] } } });
    await until(() => unsubscribe(f).length === 1, 'idle completion release');
    f.reply(unsubscribe(f)[0], { status: 'unsubscribed' });
  } finally { await f.close(); }
});

test('paused queued drafts and approvals with no response never expire into a safe release', async () => {
  for (const blocker of ['queue', 'approval']) {
    const f = await fixture(page(), { graceMs: 25 });
    try {
      await f.resume();
      if (blocker === 'queue') {
        const request = f.native('thread-follower-set-queued-follow-ups-state', { state: { [threadId]: [{ id: 'draft', text: 'keep', pausedReason: 'user-paused' }] } });
        await until(() => f.replyFor(request), 'queue ack');
      } else f.notify({ id: 'approval', method: 'item/commandExecution/requestApproval', params: { threadId, turnId: 'latest', command: 'true' } });
      await departed(f); await delay(120);
      assert.equal(unsubscribe(f).length, 0, blocker);
      assert.ok(f.state());
    } finally { await f.close(); }
  }
});

test('in-flight native full-history reads block release even when the last viewer leaves', async () => {
  const f = await fixture(page(), { graceMs: 30 });
  try {
    await f.resume();
    const request = f.native('thread-follower-load-complete-history');
    await until(() => f.reads.length === 1, 'pending complete read');
    await departed(f); await delay(80); assert.equal(unsubscribe(f).length, 0);
    f.fullRead({ thread: { ...f.metadata, turns: [turn('latest', 1, 'full')] } });
    await until(() => f.replyFor(request), 'complete read ack');
    await until(() => unsubscribe(f).length === 1, 'release after read');
    f.reply(unsubscribe(f)[0], { status: 'unsubscribed' });
  } finally { await f.close(); }
});

test('definite unsubscribe rejection preserves the writer without pretending to have released it', async () => {
  const f = await fixture(page(), { graceMs: 25 });
  try {
    await f.resume(); await departed(f);
    await until(() => unsubscribe(f).length === 1, 'unsubscribe');
    f.reject(unsubscribe(f)[0]);
    await until(() => !f.local.owner.isThreadReleasing(threadId), 'definite failure');
    assert.equal(f.local.owner.isThreadOwned(threadId), true);
    assert.equal(f.local.threads.has(threadId), true);
    assert.equal(f.local.uncertainWrites, false);
    await delay(70); assert.equal(unsubscribe(f).length, 1);
  } finally { await f.close(); }
});

test('unsubscribe timeout or malformed ACK keeps an uncertain gate closed instead of force-unlocking', async () => {
  for (const failure of ['timeout', 'malformed']) {
    const f = await fixture(page(), { graceMs: 20, timeout: 100 });
    try {
      await f.resume(); await departed(f);
      await until(() => unsubscribe(f).length === 1, 'unsubscribe');
      if (failure === 'malformed') f.reply(unsubscribe(f)[0], { status: 'unknown' });
      await until(() => f.local.uncertainWrites, 'unknown release result');
      assert.equal(f.local.owner.isThreadOwned(threadId), true);
      assert.equal(f.local.owner.isThreadReleasing(threadId), true);
      await assert.rejects(f.local.startTurn(threadId, 'must not send'), { code: 'unavailable' });
      await assert.rejects(f.local.close(), { code: 'tasks-active' });
      assert.equal(unsubscribe(f).length, 1);
    } finally { await f.close(); }
  }
});

test('owner transport loss invalidates the departure generation before grace can release the writer', async () => {
  const f = await fixture(page(), { graceMs: 80 });
  try {
    await f.resume(); await departed(f); await delay(10);
    f.disconnectOwner(); await delay(150);
    assert.equal(unsubscribe(f).length, 0);
    assert.equal(f.local.owner.isThreadOwned(threadId), true);
    await until(() => f.frames.filter(m => m.type === 'request' && m.method === 'initialize').length === 2, 'owner reconnect');
    // A stale false from the preceding connection is not a known departure in
    // this generation. Only a newly observed true -> false pair can release.
    f.follower(false); await delay(120); assert.equal(unsubscribe(f).length, 0);
    await departed(f);
    await until(() => unsubscribe(f).length === 1, 'new-generation departure');
    f.reply(unsubscribe(f)[0], { status: 'unsubscribed' });
  } finally { await f.close(); }
});
