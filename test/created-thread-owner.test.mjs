import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatedThreadOwner } from '../src/desktop/created-thread-owner.mjs';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';
import { ModelJournal } from '../src/desktop/model-journal.mjs';
import { createModelService } from '../src/desktop/model-service.mjs';
import { OwnerRouter } from '../src/desktop/owner-router.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fixture as ownerFixture, threadId as fixtureThreadId, turn, until } from './helpers/owner-history-fixture.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
function fixture(options = {}) {
  let owned = options.owned ?? true, ownerId = options.ownerId ?? 'bridge', opens = 0, sends = 0, closed = 0, discovery = 0, releaseAttempts = 0, probes = 0;
  const writes = [], controls = [];
  const releasedThreads = new Set(options.released ? [threadId] : []);
  const localOwner = { ownerId: () => 'bridge', releasedThreads,
    owner: { isThreadOwned: () => owned, isThreadReleasing: () => options.releasing === true, canPerformThreadAction: () => options.idle !== false,
      async releaseThreadForHandoff(id) {
        releaseAttempts++;
        await options.release?.(releaseAttempts, localOwner);
        owned = false; releasedThreads.add(id);
      } },
    async write(method, params) { writes.push({ method, params }); },
    async startTurn() { assert.fail('never execute a created prompt on the bridge'); },
  };
  const adapter = createCreatedThreadOwner({ localOwner,
    async openThread(id) { opens++; assert.equal(id, threadId); await options.onOpen?.(); ownerId = options.openOwner ?? 'desktop'; },
    timeoutMs: options.timeoutMs ?? 20, pollMs: 1, discoveryProbeMs: options.discoveryProbeMs ?? 750,
    createClient: () => ({
      async connect() {}, async close() { closed++; },
      async discover(id, hostId, requestOptions) {
        discovery++;
        if (options.discover) return options.discover({ id, hostId, ...requestOptions, attempt: discovery });
        return { ownerId, result: { supportsUntrustedAppInput: options.capability ?? ownerId === 'desktop' } };
      },
      async probeOwner(id, expectedOwnerId, { timeout }) {
        probes++;
        assert.equal(id, threadId); assert.ok(timeout > 0 && timeout <= 2000);
        return options.probe ? options.probe({ id, ownerId: expectedOwnerId, timeout, attempt: probes }) : { revision: 0 };
      },
      async startTurn(id, params, { expectedOwnerId, beforeWrite }) {
        options.beforeControl?.();
        if (options.controlOwner && options.controlOwner !== expectedOwnerId) throw Object.assign(new Error('Owner changed'), { code: 'unavailable' });
        if (!await beforeWrite()) throw Object.assign(new Error('Cancelled before write'), { code: 'unavailable' });
        sends++; controls.push({ id, params, expectedOwnerId });
        await options.afterSend?.();
        if (options.controlError) throw options.controlError;
        return { turnId: 'first' };
      },
    }),
  });
  return { adapter, localOwner, writes, controls, counts: () => ({ opens, sends, closed, discovery, releaseAttempts, probes }), owned: () => owned };
}

test('prepare releases an empty phone owner once and the first send reuses the received desktop without opening again', async () => {
  const f = fixture();
  const [a, b] = await Promise.all([f.adapter.prepare(threadId), f.adapter.prepare(threadId)]);
  assert.deepEqual(a, { ownerId: 'desktop' }); assert.deepEqual(b, a);
  assert.deepEqual(f.writes, [{ method: 'thread/name/set', params: { threadId, name: '新会话' } }]);
  assert.equal(f.owned(), false); assert.equal(f.localOwner.releasedThreads.has(threadId), true);
  assert.equal(f.counts().opens, 1);
  await f.adapter.startTurn(threadId, 'first', { model: 'selected-model', effort: 'high', attachments: [
    { kind: 'file', name: 'notes.md', path: '/isolated/notes.md' },
    { kind: 'image', name: 'photo.png', path: '/isolated/photo.png' },
  ] });
  assert.equal(f.counts().opens, 1, 'sending after preparation must not reopen or refocus the desktop');
  assert.equal(f.counts().sends, 1);
  assert.equal(f.counts().probes, 0, 'creation never invokes complete-history liveness probes on a valid empty thread');
  const { request, context } = f.controls[0].params;
  assert.equal(f.controls[0].expectedOwnerId, 'desktop');
  assert.equal(request.model, 'selected-model'); assert.equal(request.effort, 'high');
  assert.match(request.clientUserMessageId, /^[\da-f-]{36}$/);
  assert.match(request.input[0].text, /first\n\n# Files mentioned by the user:/);
  assert.match(request.input[0].text, /"notes.md": \/isolated\/notes.md/);
  assert.deepEqual(request.input[1], { type: 'localImage', path: '/isolated/photo.png' });
  assert.deepEqual(context, { inheritThreadSettings: false });
  assert.equal(f.counts().closed, 3, 'all preparation and sending clients close');
});

test('history recovery hands an idle bridge writer to native Desktop without renaming or sending', async () => {
  const f = fixture();
  assert.deepEqual(await f.adapter.recover(threadId), { ownerId: 'desktop' });
  assert.equal(f.owned(), false);
  assert.equal(f.counts().releaseAttempts, 1); assert.equal(f.counts().opens, 1);
  assert.deepEqual(f.writes, []); assert.equal(f.counts().sends, 0);
  assert.deepEqual(await f.adapter.recover(threadId), { ownerId: 'desktop' });
  assert.equal(f.counts().releaseAttempts, 1); assert.equal(f.counts().opens, 1, 'returning to a native-owned history thread does not restore it again');
});

test('history recovery activates an unloaded native thread after one short unanswered probe without bridge resume', async () => {
  const signals = [];
  const f = fixture({ owned: false, timeoutMs: 500, discoveryProbeMs: 15,
    discover: async ({ signal, attempt }) => {
      signals.push(signal);
      if (attempt === 1) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('absent peer')), { once: true }));
      return { ownerId: 'desktop', result: { supportsUntrustedAppInput: true } };
    },
  });
  assert.deepEqual(await f.adapter.recover(threadId), { ownerId: 'desktop' });
  assert.equal(signals[0].aborted, true);
  assert.equal(f.counts().opens, 1); assert.equal(f.counts().releaseAttempts, 0);
  assert.deepEqual(f.writes, []); assert.equal(f.counts().sends, 0);
});

test('history recovery follows active bridge work without release and rejects an uncertain release', async () => {
  const active = fixture({ idle: false });
  assert.deepEqual(await active.adapter.recover(threadId), { ownerId: 'bridge' });
  assert.equal(active.counts().releaseAttempts, 0); assert.equal(active.counts().opens, 0);
  assert.deepEqual(active.writes, []);
  const uncertain = fixture({ releasing: true });
  await assert.rejects(uncertain.adapter.recover(threadId), { code: 'unavailable' });
  assert.equal(uncertain.counts().releaseAttempts, 0); assert.equal(uncertain.counts().opens, 0);
});

test('history recovery never reopens after an unconfirmed unsubscribe or renames the old chat', async () => {
  const f = fixture({ release: async () => { throw Object.assign(new Error('lost unsubscribe ACK'), { code: 'outcome-unknown' }); } });
  await assert.rejects(f.adapter.recover(threadId), { code: 'outcome-unknown' });
  assert.equal(f.counts().releaseAttempts, 1); assert.equal(f.counts().opens, 0);
  assert.deepEqual(f.writes, []); assert.equal(f.counts().sends, 0);
});

test('unresolved historical recovery permits following native but never opens or releases another writer', async () => {
  const absent = fixture({ owned: false });
  await assert.rejects(absent.adapter.recover(threadId, { canHandoff: false }), { code: 'resume-unknown' });
  assert.equal(absent.counts().opens, 0); assert.equal(absent.counts().releaseAttempts, 0);
  const native = fixture({ owned: false, ownerId: 'desktop' });
  assert.deepEqual(await native.adapter.recover(threadId, { canHandoff: false }), { ownerId: 'desktop' });
  assert.equal(native.counts().opens, 0);
  const bridge = fixture();
  assert.deepEqual(await bridge.adapter.recover(threadId, { canHandoff: false }), { ownerId: 'bridge' });
  assert.equal(bridge.counts().releaseAttempts, 0); assert.deepEqual(bridge.writes, []);
});

test('history recovery cancellation does not open or mutate a thread', async () => {
  const f = fixture();
  await assert.rejects(f.adapter.recover(threadId, { isCancelled: () => true }), { code: 'unavailable' });
  assert.equal(f.counts().releaseAttempts, 0); assert.equal(f.counts().opens, 0); assert.deepEqual(f.writes, []);
});

test('a previously released history thread follows its native owner without opening the desktop again', async () => {
  const f = fixture({ owned: false, released: true, ownerId: 'desktop' });
  assert.deepEqual(await f.adapter.recover(threadId), { ownerId: 'desktop' });
  assert.equal(f.counts().discovery, 1); assert.equal(f.counts().opens, 0);
  assert.equal(f.counts().releaseAttempts, 0); assert.deepEqual(f.writes, []);
});

test('historical discovery rejects a stale cached native owner and opens the original thread before accepting a live owner', async () => {
  const f = fixture({ owned: false, ownerId: 'dead-native-owner', capability: true,
    probe: async ({ ownerId }) => {
      if (ownerId === 'dead-native-owner') throw new Error('Owner stopped answering');
      return { revision: 0 };
    },
  });
  assert.deepEqual(await f.adapter.recover(threadId), { ownerId: 'desktop' });
  assert.equal(f.counts().probes, 2); assert.equal(f.counts().opens, 1);
  assert.deepEqual(f.writes, []); assert.equal(f.counts().sends, 0);
});

test('native capability without a current snapshot never completes historical recovery', async () => {
  for (const probe of [async () => { throw new Error('Native owner is gone'); }, async () => null, async () => ({ revision: -1 })]) {
    const f = fixture({ owned: false, ownerId: 'dead-native-owner', capability: true, probe });
    await assert.rejects(f.adapter.recover(threadId), { code: 'unavailable' });
    assert.ok(f.counts().probes >= 2); assert.equal(f.counts().opens, 1);
    assert.deepEqual(f.writes, []); assert.equal(f.counts().releaseAttempts, 0); assert.equal(f.counts().sends, 0);
  }
});

test('a live empty historical thread is confirmed by snapshot revision zero without reopening', async () => {
  const f = fixture({ owned: false, ownerId: 'desktop', probe: async () => ({ revision: 0 }) });
  assert.deepEqual(await f.adapter.recover(threadId), { ownerId: 'desktop' });
  assert.equal(f.counts().probes, 1); assert.equal(f.counts().opens, 0);
  assert.deepEqual(f.writes, []);
});

test('historical liveness uses only the remaining overall preparation budget', async t => {
  let now = 1000, probeTimeout;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ owned: false, ownerId: 'desktop', timeoutMs: 20000,
    discover: async () => { now += 19250; return { ownerId: 'desktop', result: { supportsUntrustedAppInput: true } }; },
    probe: async ({ timeout }) => { probeTimeout = timeout; now += timeout; return { revision: 1 }; },
  });
  await assert.rejects(f.adapter.recover(threadId), { code: 'unavailable' });
  assert.equal(probeTimeout, 750); assert.equal(f.counts().probes, 1); assert.equal(f.counts().opens, 0);
});

test('cancellation during native snapshot verification prevents reopening or accepting historical recovery', async () => {
  let cancelled = false;
  const f = fixture({ owned: false, ownerId: 'desktop', probe: async () => { cancelled = true; return { revision: 0 }; } });
  await assert.rejects(f.adapter.recover(threadId, { isCancelled: () => cancelled }), { code: 'unavailable' });
  assert.equal(f.counts().probes, 1); assert.equal(f.counts().opens, 0);
});

test('cancelling historical recovery during discovery prevents opening the native route', async () => {
  let cancelled = false;
  const f = fixture({ owned: false, discover: async () => {
    cancelled = true;
    return { ownerId: 'stale-owner', result: { supportsUntrustedAppInput: false } };
  } });
  await assert.rejects(f.adapter.recover(threadId, { isCancelled: () => cancelled }), { code: 'unavailable' });
  assert.equal(f.counts().opens, 0); assert.deepEqual(f.writes, []);
});

test('creation and historical recovery of the same thread cannot join one another', async () => {
  for (const firstKind of ['prepare', 'recover']) {
    let entered, release;
    const gate = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const f = fixture({ timeoutMs: 500, release: async () => { entered(); await gate; } });
    const first = f.adapter[firstKind](threadId);
    await started;
    const otherKind = firstKind === 'prepare' ? 'recover' : 'prepare';
    await assert.rejects(f.adapter[otherKind](threadId), { code: 'unavailable' });
    release();
    assert.deepEqual(await first, { ownerId: 'desktop' });
    assert.equal(f.writes.length, firstKind === 'prepare' ? 1 : 0);
    assert.equal(f.counts().releaseAttempts, 1); assert.equal(f.counts().opens, 1);
  }
});

test('native history routing skips legacy discovery and bridge resume on first restore and subsequent switches', async () => {
  const f = fixture({ owned: false });
  f.localOwner.resume = async () => assert.fail('history must not resume on the phone app-server');
  const journal = new CreationJournal(':memory:');
  const router = new OwnerRouter({ discover: async () => assert.fail('must use the bounded native probe'),
    localOwner: f.localOwner, historicalThreadOwner: f.adapter, projects: async () => [], journal, hostId: 'host' });
  try {
    for (let i = 0; i < 3; i++) {
      assert.deepEqual(await router.route(threadId), { kind: 'owner', ownerId: 'desktop' });
      assert.equal(router.isRecoveryLocked(threadId), false);
    }
    assert.equal(f.counts().opens, 1); assert.equal(f.counts().releaseAttempts, 0);
    assert.deepEqual(f.writes, []); assert.equal(f.counts().sends, 0);
  } finally { router.close(); journal.close(); }
});

test('an unavailable native historical owner never falls back to bridge resume', async () => {
  const f = fixture({ owned: false, capability: false });
  f.localOwner.resume = async () => assert.fail('native timeout cannot dispatch another writer');
  const journal = new CreationJournal(':memory:');
  const router = new OwnerRouter({ discover: async () => ({ kind: 'unknown' }), localOwner: f.localOwner,
    historicalThreadOwner: f.adapter, projects: async () => [], journal, hostId: 'host', competeUnknown: true });
  try {
    await assert.rejects(router.route(threadId), { code: 'unavailable' });
    assert.equal(f.counts().opens, 1); assert.equal(f.counts().releaseAttempts, 0);
    assert.equal(router.isRecoveryLocked(threadId), false, 'read probes and native routing do not create app-server write reservations');
    assert.deepEqual(f.writes, []);
  } finally { router.close(); journal.close(); }
});

test('native routing preserves an earlier unknown app-server recovery while allowing a discovered native owner', async () => {
  let native = false;
  const f = fixture({ owned: false, discover: async () => ({ ownerId: native ? 'desktop' : 'stale', result: { supportsUntrustedAppInput: native } }) });
  const journal = new CreationJournal(':memory:');
  journal.beginRecovery('host', threadId, 'older-unknown-write');
  const router = new OwnerRouter({ discover: async () => assert.fail('no legacy discovery'), localOwner: f.localOwner,
    historicalThreadOwner: f.adapter, projects: async () => [], journal, hostId: 'host' });
  try {
    await assert.rejects(router.route(threadId), { code: 'resume-unknown' });
    assert.equal(f.counts().opens, 0);
    native = true;
    assert.deepEqual(await router.route(threadId), { kind: 'owner', ownerId: 'desktop' });
    assert.equal(router.isRecoveryLocked(threadId), true, 'following cannot erase an unresolved write reservation');
    assert.equal(f.counts().opens, 0); assert.deepEqual(f.writes, []);
  } finally { router.close(); journal.close(); }
});

test('native history handoff preserves a real model journal until its awaiting-state snapshot is confirmed', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-model-admission-'));
  const path = join(directory, 'writes.sqlite');
  const journal = new CreationJournal(path), models = new ModelJournal(path), f = fixture();
  const session = { status: 'ready', conversationId: threadId, revision: 1, conversation: { ownerId: 'bridge' },
    value: { id: threadId, threadRuntimeStatus: { type: 'idle' }, latestCollaborationMode: { mode: 'default', settings: { model: 'a', reasoning_effort: 'low', developer_instructions: null } } },
    client: { async setCollaborationMode(_id, _mode, _settings, options) { assert.equal(options.beforeWrite(), true); return { applied: true }; } },
  };
  const service = createModelService({ journal: models, hostId: 'host', sessionFor: () => session,
    request: async () => ({ data: [{ model: 'b', displayName: 'B', hidden: false, supportedReasoningEfforts: [{ reasoningEffort: 'high' }], defaultReasoningEffort: 'high' }], nextCursor: null }),
  });
  const router = new OwnerRouter({ discover: async () => assert.fail('no legacy discovery'), localOwner: f.localOwner,
    historicalThreadOwner: f.adapter, projects: async () => [], journal, hostId: 'host' });
  let nativeRouter;
  try {
    assert.equal((await service.change({ deviceId: 'device', threadId, model: 'b', effort: 'high' })).status, 'accepted');
    assert.equal(service.status(threadId), 'awaiting-state');
    const record = models.get('host', threadId);
    assert.equal(record.phase, 'dispatching');
    assert.equal(journal.threadWritePending('host', threadId), true);
    assert.deepEqual(await router.route(threadId), { kind: 'owner', ownerId: 'bridge' });
    assert.equal(f.counts().releaseAttempts, 0); assert.equal(f.counts().opens, 0);
    assert.deepEqual(models.get('host', threadId), record);
    const native = fixture({ owned: false, ownerId: 'desktop' });
    nativeRouter = new OwnerRouter({ discover: async () => assert.fail('no legacy discovery'), localOwner: native.localOwner,
      historicalThreadOwner: native.adapter, projects: async () => [], journal, hostId: 'host' });
    assert.deepEqual(await nativeRouter.route(threadId), { kind: 'owner', ownerId: 'desktop' });
    assert.equal(native.counts().opens, 0); assert.deepEqual(models.get('host', threadId), record);
    session.revision++;
    session.value.latestCollaborationMode.settings = { model: 'b', reasoning_effort: 'high', developer_instructions: null };
    assert.equal(service.observe({ deviceId: 'device', threadId, session }), true);
    assert.equal(journal.threadWritePending('host', threadId), false);
    assert.deepEqual(await router.route(threadId), { kind: 'owner', ownerId: 'desktop' });
    assert.equal(f.counts().releaseAttempts, 1); assert.equal(f.counts().opens, 1);
  } finally { await service.close(); router.close(); nativeRouter?.close(); models.close(); journal.close(); await rm(directory, { recursive: true, force: true }); }
});

test('native history admission respects real message journals, unresolved raw wildcards, and host/thread isolation', async () => {
  const scenarios = [
    { table: 'message', host: 'host', thread: threadId, phase: 'prepared', blocks: true },
    { table: 'message', host: 'host', thread: threadId, phase: 'dispatching', blocks: true },
    { table: 'model', host: 'host', thread: threadId, phase: 'prepared', blocks: true },
    { table: 'model', host: 'host', thread: threadId, phase: 'unknown', blocks: true },
    { table: 'raw', host: 'host', thread: threadId, phase: 'unknown', blocks: true },
    { table: 'raw', host: '', thread: threadId, phase: 'dispatching', blocks: true },
    { table: 'raw', host: 'host', thread: '', phase: 'unknown', blocks: true },
    { table: 'raw', host: '', thread: '', phase: 'unknown', blocks: true },
    { table: 'raw', host: '', thread: '', phase: 'resolved', blocks: false },
    ...['message', 'model', 'raw'].flatMap(table => [
      { table, host: 'other-host', thread: threadId, phase: 'dispatching', blocks: false },
      { table, host: 'host', thread: 'other-thread', phase: 'dispatching', blocks: false },
    ]),
  ];
  for (const scenario of scenarios) {
    const journal = new CreationJournal(':memory:'), f = fixture({ owned: false });
    const { table, host, thread, phase, blocks } = scenario;
    if (table === 'message') journal.db.prepare('INSERT INTO message_writes VALUES (?,?,?,?)').run(host, thread, 'message', phase);
    else if (table === 'model') journal.db.prepare('INSERT INTO model_writes VALUES (?,?,?,?,?)').run(host, thread, 'device', 'model', phase);
    else journal.db.prepare('INSERT INTO raw_request_experiment (instance,request_key,host_id,thread,turn,item,method,digest,phase) VALUES (?,?,?,?,?,?,?,?,?)').run('instance', 'raw', host, thread, 'turn', 'item', 'method', 'digest', phase);
    const router = new OwnerRouter({ discover: async () => assert.fail('no legacy discovery'), localOwner: f.localOwner,
      historicalThreadOwner: f.adapter, projects: async () => [], journal, hostId: 'host' });
    try {
      assert.equal(journal.threadWritePending('host', threadId), blocks, JSON.stringify(scenario));
      if (blocks) await assert.rejects(router.route(threadId), { code: 'resume-unknown' });
      else assert.deepEqual(await router.route(threadId), { kind: 'owner', ownerId: 'desktop' });
      assert.equal(f.counts().opens, blocks ? 0 : 1, JSON.stringify(scenario));
      assert.equal(journal.threadWritePending('host', threadId), blocks, 'routing never clears another write journal');
    } finally { router.close(); journal.close(); }
  }
});

test('a write journal read failure cannot release a known bridge owner', async () => {
  const journal = new CreationJournal(':memory:'), f = fixture();
  const router = new OwnerRouter({ discover: async () => assert.fail('no legacy discovery'), localOwner: f.localOwner,
    historicalThreadOwner: f.adapter, projects: async () => [], journal, hostId: 'host' });
  journal.db.exec('DROP TABLE model_writes');
  try {
    assert.equal(journal.recoveryPending('host', threadId), false);
    assert.throws(() => journal.threadWritePending('host', threadId));
    assert.deepEqual(await router.route(threadId), { kind: 'owner', ownerId: 'bridge' });
    assert.equal(f.counts().releaseAttempts, 0); assert.equal(f.counts().opens, 0);
  } finally { router.close(); journal.close(); }
});

test('real historical LocalOwner release waits for closure without naming or reading the entire history', async () => {
  const f = await ownerFixture({ data: [turn('existing-answer')], nextCursor: null }, { disableAutoClosed: true });
  try {
    await f.resume();
    let native = false, opens = 0;
    const adapter = createCreatedThreadOwner({ localOwner: f.local, timeoutMs: 500, pollMs: 1,
      openThread: async () => { opens++; native = true; },
      createClient: () => ({ async connect() {}, async close() {}, async discover() {
        return { ownerId: native ? 'desktop' : f.local.ownerId(), result: { supportsUntrustedAppInput: native } };
      }, async probeOwner() { return { revision: 0 }; } }),
    });
    const recovering = adapter.recover(fixtureThreadId);
    await until(() => f.requests.some(request => request.method === 'thread/unsubscribe'), 'history unsubscribe');
    const unsubscribe = f.requests.find(request => request.method === 'thread/unsubscribe');
    f.reply(unsubscribe, { status: 'unsubscribed' });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(opens, 0, 'an ACK without thread/closed cannot hand the writer to native');
    f.notify({ method: 'thread/closed', params: { threadId: fixtureThreadId } });
    assert.deepEqual(await recovering, { ownerId: 'desktop' });
    assert.deepEqual(await adapter.recover(fixtureThreadId), { ownerId: 'desktop' });
    assert.equal(opens, 1);
    assert.equal(f.requests.filter(request => request.method === 'thread/resume').length, 1, 'only the fixture setup resumed, return visits do not');
    assert.equal(f.requests.filter(request => request.method === 'thread/unsubscribe').length, 1);
    assert.equal(f.requests.filter(request => request.method === 'thread/name/set' || request.method === 'turn/start' || request.method === 'thread/read').length, 0);
  } finally { await f.close(); }
});

test('a first send without an explicit model inherits native Desktop settings', async () => {
  const f = fixture();
  await f.adapter.startTurn(threadId, 'use desktop defaults');
  const { request, context } = f.controls[0].params;
  assert.equal(Object.hasOwn(request, 'model'), false);
  assert.equal(Object.hasOwn(request, 'effort'), false);
  assert.deepEqual(context, { inheritThreadSettings: true });
});

test('missing native capability times out without sending or falling back to the phone', async () => {
  for (const options of [{ openOwner: 'bridge', capability: true }, { openOwner: 'other-client', capability: false }]) {
    const f = fixture(options);
    await assert.rejects(f.adapter.startTurn(threadId, 'never sent'), { code: 'unavailable' });
    assert.equal(f.counts().opens, 1); assert.equal(f.counts().sends, 0); assert.equal(f.owned(), false);
  }
});

test('an early discovery is aborted and a fresh probe confirms native ownership before exactly one first send', async () => {
  const signals = [];
  const f = fixture({ timeoutMs: 500, discoveryProbeMs: 15,
    discover: async ({ id, hostId, signal, attempt }) => {
      assert.equal(id, threadId); assert.equal(hostId, 'local');
      assert.ok(signal instanceof AbortSignal); signals.push(signal);
      if (attempt === 1) return new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(Object.assign(new Error('Discovery cancelled'), { code: 'unavailable' })), { once: true });
      });
      return { ownerId: 'desktop', result: { supportsUntrustedAppInput: true } };
    },
  });
  await f.adapter.startTurn(threadId, 'send once after native route mounts');
  assert.equal(signals.length, 2, 'the unavailable early request does not consume the full preparation budget');
  assert.equal(signals[0].aborted, true);
  assert.equal(signals[1].aborted, false);
  assert.equal(f.counts().opens, 1); assert.equal(f.counts().sends, 1);
  assert.equal(f.controls[0].expectedOwnerId, 'desktop');
  assert.equal(f.writes.length, 1, 'discovery retries never repeat persistence or the first turn');
});

test('hung discovery probes share the total preparation deadline and never dispatch the first turn', async () => {
  const signals = [];
  const f = fixture({ timeoutMs: 40, discoveryProbeMs: 15,
    discover: async ({ signal }) => {
      signals.push(signal);
      return new Promise((_resolve, reject) => signal.addEventListener('abort', () => {
        reject(Object.assign(new Error('Discovery cancelled'), { code: 'unavailable' }));
      }, { once: true }));
    },
  });
  await assert.rejects(f.adapter.startTurn(threadId, 'never sent'), { code: 'unavailable' });
  assert.ok(signals.length >= 2 && signals.length <= 4, 'short read probes remain bounded by one total deadline');
  assert.ok(signals.every(signal => signal.aborted));
  assert.equal(f.counts().opens, 1); assert.equal(f.counts().sends, 0); assert.equal(f.counts().closed, 1);
});

test('cancel before or immediately before control dispatch never sends the first prompt', async () => {
  for (const late of [false, true]) {
    let cancelled = !late;
    const f = fixture({ beforeControl: () => { if (late) cancelled = true; } });
    await assert.rejects(f.adapter.startTurn(threadId, 'cancelled', { isCancelled: () => cancelled }), { code: 'unavailable' });
    assert.equal(f.counts().sends, 0); assert.equal(f.counts().opens, 1);
  }
});

test('owner changing at control dispatch refuses the send without local fallback', async () => {
  const f = fixture({ controlOwner: 'different-desktop' });
  await assert.rejects(f.adapter.startTurn(threadId, 'must not race'), { code: 'unavailable' });
  assert.equal(f.counts().sends, 0); assert.equal(f.counts().opens, 1);
});

test('a timeout after dispatch propagates once without another send or opening the window again', async () => {
  const failure = new Error('thread-follower-start-turn timed out');
  const f = fixture({ controlError: failure });
  await assert.rejects(f.adapter.startTurn(threadId, 'possibly accepted'), error => error === failure);
  assert.equal(f.counts().sends, 1); assert.equal(f.counts().opens, 1);
});

test('a first-turn title is readable, bounded and set before release without later renaming', async () => {
  const f = fixture();
  await f.adapter.startTurn(threadId, `  first\n\t sentence ${'x'.repeat(100)} `);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].params.name, `first sentence ${'x'.repeat(100)}`.slice(0, 80));
  assert.equal(f.writes[0].params.name.length, 80);
  await f.adapter.prepare(threadId, { title: 'never overwrite a received native title' });
  assert.equal(f.writes.length, 1, 'released threads never receive cross-writer title updates');
});

test('retry after initial naming preserves a later manual title and attachment-only starts retain a fallback', async () => {
  const named = fixture({ release: async attempt => {
    if (attempt === 1) throw Object.assign(new Error('Release did not complete'), { code: 'outcome-unknown' });
  } });
  await assert.rejects(named.adapter.prepare(threadId, { title: 'Initial task title' }), { code: 'outcome-unknown' });
  // The user can rename the conversation after the acknowledged initial name.
  // A fresh prepare attempt must not write over that later choice.
  await named.adapter.prepare(threadId, { title: 'Never replace a manual title on retry' });
  assert.deepEqual(named.writes, [{ method: 'thread/name/set', params: { threadId, name: 'Initial task title' } }]);
  const files = fixture();
  await files.adapter.startTurn(threadId, '', { attachments: [{ kind: 'file', name: 'notes.txt', path: '/isolated/notes.txt' }] });
  assert.equal(files.writes[0].params.name, '新会话');
});

test('release, open and discovery share one bounded preparation deadline', async t => {
  let now = 1000;
  t.mock.method(Date, 'now', () => now);
  const f = fixture({ release: async () => { now += 15; }, onOpen: async () => { now += 6; } });
  await assert.rejects(f.adapter.prepare(threadId), { code: 'unavailable' });
  assert.equal(f.counts().releaseAttempts, 1);
  assert.equal(f.counts().opens, 1);
  assert.equal(f.counts().discovery, 0, 'a slow release and opener cannot start a fresh full discovery window');
  assert.equal(f.counts().sends, 0);
});

test('a short shared admission hold is retried before dispatch and only one unsubscribe can succeed', async () => {
  const unavailable = () => Object.assign(new Error('Admission busy'), { code: 'unavailable' });
  const f = fixture({ release: async attempt => { if (attempt < 3) throw unavailable(); } });
  await f.adapter.prepare(threadId);
  assert.equal(f.counts().releaseAttempts, 3);
  assert.equal(f.counts().opens, 1);
  assert.equal(f.writes.length, 1, 'waiting for admission does not repeat thread persistence');
});

test('uncertain or already dispatched release failures are never retried', async () => {
  for (const state of ['uncertain', 'releasing', 'outcome-unknown']) {
    const options = { releasing: state === 'releasing', release: async (_attempt, owner) => {
      if (state === 'uncertain') owner.uncertainWrites = true;
      throw Object.assign(new Error(state), { code: state === 'outcome-unknown' ? 'outcome-unknown' : 'unavailable' });
    } };
    const f = fixture(options);
    await assert.rejects(f.adapter.prepare(threadId), { code: state === 'outcome-unknown' ? 'outcome-unknown' : 'unavailable' });
    assert.equal(f.counts().releaseAttempts, 1, state);
    assert.equal(f.counts().opens, 0, state);
    assert.equal(f.counts().sends, 0, state);
  }
});

test('an admission timeout never dispatches unsubscribe or opens the unconfirmed thread', async () => {
  const f = fixture({ release: async () => {
    // This error represents a synchronous rejected admission, before the owner
    // can dispatch unsubscribe. The bounded wait may retry only this case.
    throw Object.assign(new Error('Still reading another thread'), { code: 'unavailable' });
  } });
  await assert.rejects(f.adapter.prepare(threadId), { code: 'unavailable' });
  assert.ok(f.counts().releaseAttempts > 1);
  assert.equal(f.counts().opens, 0); assert.equal(f.counts().sends, 0);
});

test('a different creation in flight can finish before the one confirmed handoff unsubscribe', async () => {
  const f = await ownerFixture({ data: [turn('latest')], nextCursor: null }, { holdMethods: ['thread/start'] });
  try {
    await f.resume();
    const creation = f.local.write('thread/start', { cwd: f.metadata.cwd });
    await until(() => f.requests.some(request => request.method === 'thread/start'), 'another creation in flight');
    let native = false, opens = 0;
    const adapter = createCreatedThreadOwner({ localOwner: f.local, timeoutMs: 500, pollMs: 1,
      openThread: async () => { opens++; native = true; },
      createClient: () => ({ async connect() {}, async close() {},
        async discover() { return { ownerId: native ? 'native-desktop' : f.local.ownerId(), result: { supportsUntrustedAppInput: native } }; } }),
    });
    const preparing = adapter.prepare(fixtureThreadId);
    await until(() => f.requests.some(request => request.method === 'thread/name/set'), 'target empty thread named');
    assert.equal(f.requests.filter(request => request.method === 'thread/unsubscribe').length, 0);
    f.reply(f.requests.find(request => request.method === 'thread/start'), {
      thread: { ...f.metadata, id: '22222222-2222-4222-8222-222222222222', turns: [] }, model: 'actual-model', reasoningEffort: 'high',
    });
    await creation;
    await until(() => f.requests.some(request => request.method === 'thread/unsubscribe'), 'creation admission clears');
    f.reply(f.requests.find(request => request.method === 'thread/unsubscribe'), { status: 'unsubscribed' });
    assert.deepEqual(await preparing, { ownerId: 'native-desktop' });
    assert.equal(f.requests.filter(request => request.method === 'thread/unsubscribe').length, 1);
    assert.equal(opens, 1);
  } finally { await f.close(); }
});

test('a real LocalOwner pending read can clear before the one confirmed handoff unsubscribe', async () => {
  const f = await ownerFixture({ data: [turn('latest')], nextCursor: null });
  try {
    await f.resume();
    const read = f.local.request('thread/read', { threadId: fixtureThreadId, includeTurns: true });
    await until(() => f.reads.length === 1, 'shared pending read');
    let native = false, opens = 0;
    const adapter = createCreatedThreadOwner({ localOwner: f.local, timeoutMs: 500, pollMs: 1,
      openThread: async () => { opens++; native = true; },
      createClient: () => ({ async connect() {}, async close() {},
        async discover() { return { ownerId: native ? 'native-desktop' : f.local.ownerId(), result: { supportsUntrustedAppInput: native } }; } }),
    });
    const preparing = adapter.prepare(fixtureThreadId);
    await until(() => f.requests.some(request => request.method === 'thread/name/set'), 'empty thread named');
    assert.equal(f.requests.filter(request => request.method === 'thread/unsubscribe').length, 0);
    assert.equal(opens, 0);
    f.fullRead({ thread: { ...f.metadata, turns: [turn('latest')] } }); await read;
    await until(() => f.requests.some(request => request.method === 'thread/unsubscribe'), 'admission clears');
    const unsubscribe = f.requests.find(request => request.method === 'thread/unsubscribe');
    f.reply(unsubscribe, { status: 'unsubscribed' });
    assert.deepEqual(await preparing, { ownerId: 'native-desktop' });
    assert.equal(f.requests.filter(request => request.method === 'thread/unsubscribe').length, 1);
    assert.equal(opens, 1);
  } finally { await f.close(); }
});

function routerFixture(options = {}) {
  const f = fixture(options), journal = new CreationJournal(':memory:');
  let creates = 0;
  f.localOwner.create = async () => { creates++; return { id: threadId }; };
  const router = new OwnerRouter({ discover: async () => ({ kind: 'unknown' }), localOwner: f.localOwner,
    createdThreadOwner: f.adapter, projects: async () => [{ id: 'project', cwd: '/isolated' }], journal, hostId: 'host' });
  const request = { projectId: 'project', deviceId: 'device', requestId: 'creation', digest: 'a'.repeat(64) };
  return { ...f, router, journal, request, creates: () => creates,
    close() { router.close(); journal.close(); } };
}

test('two-phase Router prepares native ownership before attachment submit and sends exactly once', async () => {
  let finishSend, sent;
  const sentPromise = new Promise(resolve => { sent = resolve; });
  const f = routerFixture({ afterSend: async () => { sent(); await new Promise(resolve => { finishSend = resolve; }); } });
  try {
    assert.deepEqual(await f.router.prepare(f.request), { threadId });
    assert.equal(f.counts().opens, 1); assert.equal(f.counts().sends, 0);
    assert.equal(f.journal.get('host', 'device', 'creation').phase, 'prepared');
    assert.deepEqual(await f.router.prepare(f.request), { threadId });
    assert.equal(f.creates(), 1); assert.equal(f.counts().opens, 1);
    const dispatches = [];
    const request = { ...f.request, text: 'first after upload', attachments: [{ kind: 'file', name: 'notes.txt', path: '/isolated/notes.txt' }],
      onDispatch: () => dispatches.push('dispatch') };
    const sending = f.router.submitPrepared(request);
    await sentPromise;
    assert.equal(f.journal.get('host', 'device', 'creation').phase, 'submitting');
    await assert.rejects(f.router.submitPrepared(request), { code: 'unavailable' });
    finishSend(); assert.deepEqual(await sending, { threadId });
    assert.equal(f.counts().sends, 1); assert.equal(f.counts().opens, 1);
    assert.equal(f.creates(), 1); assert.deepEqual(dispatches, ['dispatch']);
    assert.match(f.controls[0].params.request.input[0].text, /notes.txt/);
    assert.equal(f.journal.get('host', 'device', 'creation').phase, 'submitted');
  } finally { finishSend?.(); f.close(); }
});

test('two-phase title is fixed by the creation journal and cannot change or disappear on retry or submit', async () => {
  const f = routerFixture();
  try {
    const request = { ...f.request, title: 'First file task' };
    await f.router.prepare(request);
    assert.equal(f.writes[0].params.name, request.title);
    await assert.rejects(f.router.prepare({ ...request, title: 'Changed title' }), /another payload/);
    await assert.rejects(f.router.prepare(f.request), /another payload/);
    await assert.rejects(f.router.submitPrepared({ ...request, text: 'first file', title: 'Changed title' }), { code: 'unavailable' });
    await assert.rejects(f.router.submitPrepared({ ...f.request, text: 'first file' }), { code: 'unavailable' });
    assert.deepEqual(await f.router.submitPrepared({ ...request, text: 'first file' }), { threadId });
    assert.equal(f.counts().sends, 1); assert.equal(f.writes.length, 1);
  } finally { f.close(); }
});

test('Router rejects invalid optional titles before creating a thread', async () => {
  const f = routerFixture();
  try {
    for (const title of ['', 'x'.repeat(81), 'two\nlines', 'tab\there', ' padded ', null, 5]) {
      await assert.rejects(f.router.prepare({ ...f.request, title }), { code: 'invalid-input' });
    }
    assert.equal(f.creates(), 0);
  } finally { f.close(); }
});

test('two-phase cancellation preserves the prepared thread and never emits a prompt', async () => {
  const f = routerFixture();
  try {
    await f.router.prepare(f.request);
    await assert.rejects(f.router.submitPrepared({ ...f.request, text: 'cancelled', isCancelled: () => true }), { code: 'unavailable' });
    assert.equal(f.journal.get('host', 'device', 'creation').phase, 'prepared');
    assert.equal(f.counts().sends, 0); assert.equal(f.counts().opens, 1);
  } finally { f.close(); }
});

test('cancellation between Router reservation and adapter control dispatch never sends', async () => {
  const f = routerFixture();
  let cancelled = false;
  try {
    await f.router.prepare(f.request);
    await assert.rejects(f.router.submitPrepared({ ...f.request, text: 'cancelled before IPC',
      isCancelled: () => cancelled, onDispatch: () => { cancelled = true; } }), { code: 'start-unknown' });
    assert.equal(f.counts().sends, 0);
    assert.equal(f.counts().opens, 1);
    assert.equal(f.journal.get('host', 'device', 'creation').phase, 'submitting', 'reservation remains fail-closed after dispatch admission');
  } finally { f.close(); }
});

test('a two-phase dispatched timeout stays submitting and retry never duplicates the first prompt', async () => {
  const f = routerFixture({ controlError: new Error('lost IPC ACK') });
  try {
    await f.router.prepare(f.request);
    const request = { ...f.request, text: 'possibly accepted' };
    await assert.rejects(f.router.submitPrepared(request), { code: 'start-unknown' });
    assert.equal(f.journal.get('host', 'device', 'creation').phase, 'submitting');
    await assert.rejects(f.router.submitPrepared(request), { code: 'unavailable' });
    assert.equal(f.counts().sends, 1); assert.equal(f.counts().opens, 1); assert.equal(f.creates(), 1);
  } finally { f.close(); }
});
