import test from 'node:test';
import assert from 'node:assert/strict';
import { createCreatedThreadOwner } from '../src/desktop/created-thread-owner.mjs';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';
import { OwnerRouter } from '../src/desktop/owner-router.mjs';
import { fixture as ownerFixture, threadId as fixtureThreadId, turn, until } from './helpers/owner-history-fixture.mjs';

const threadId = '11111111-1111-4111-8111-111111111111';
function fixture(options = {}) {
  let owned = true, ownerId = 'bridge', opens = 0, sends = 0, closed = 0, discovery = 0, releaseAttempts = 0;
  const writes = [], controls = [];
  const releasedThreads = new Set();
  const localOwner = { ownerId: () => 'bridge', releasedThreads,
    owner: { isThreadOwned: () => owned, isThreadReleasing: () => options.releasing === true,
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
  return { adapter, localOwner, writes, controls, counts: () => ({ opens, sends, closed, discovery, releaseAttempts }), owned: () => owned };
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
