import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { navigateDesktopUnread } from '../src/desktop/native-read-navigation.mjs';

const hostId = '11111111-1111-4111-8111-111111111111', deviceId = '22222222-2222-4222-8222-222222222222', threadId = '33333333-3333-4333-8333-333333333333';
const scope = 'a'.repeat(64);
const otherThread = '44444444-4444-4444-8444-444444444444', thirdThread = '55555555-5555-4555-8555-555555555555';
const listed = () => ({ projects: [], recent: [{ id: threadId, title: 'Fixture', recency: 1 }], nativeUnread: { status: 'available', scopeKey: scope, snapshotKey: 'b'.repeat(64) } });
async function until(check) { const deadline = Date.now() + 2000; while (!check()) { if (Date.now() > deadline) throw new Error('Expected message'); await new Promise(resolve => setTimeout(resolve, 5)); } }
async function fixture({ listThreads = async () => listed(), navigate = async () => ({ read: true }), notificationMonitor, authorize, ownerRouter } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const incoming = once(server, 'connection'), messages = [], calls = [];
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId, ownerRouter, allowInsecureForTests: true, listThreads,
    navigateDesktopUnreadForTests: async (...args) => { calls.push(args); return navigate(...args); },
    ...(authorize ? { searchAuthorizeForTests: authorize } : {}),
    ...(notificationMonitor ? { createNotificationMonitorForTests: () => notificationMonitor } : {}),
  });
  connector.start(); const [socket] = await incoming; socket.on('message', raw => messages.push(JSON.parse(raw)));
  const send = data => socket.send(JSON.stringify(data));
  return { calls, messages, send, connector,
    request(id, extra = {}) { send({ type: 'desktop-read', id, deviceId, conversationId: threadId, scopeKey: scope, ...extra }); },
    async response(id) { await until(() => messages.some(m => m.id === id && m.type === 'response')); return messages.find(m => m.id === id && m.type === 'response'); },
    async barrier() { const n = messages.filter(m => m.type === 'capabilities').length; send({ type: 'flow-probe' }); await until(() => messages.filter(m => m.type === 'capabilities').length > n); },
    async close() { await connector.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('a read waits for a concurrent recovery before navigating, and cancellation prevents a late open', async () => {
  for (const cancel of [false, true]) {
    let locked = true, observed = false;
    const f = await fixture({ ownerRouter: { isRecoveryLocked: () => { observed = true; return locked; } } });
    try {
      f.request('during-recovery');
      await until(() => observed);
      assert.equal(f.calls.length, 0);
      assert.equal(f.messages.some(m => m.id === 'during-recovery'), false);
      if (cancel) { f.send({ type: 'cancel-reply', id: 'during-recovery' }); await new Promise(resolve => setTimeout(resolve, 30)); }
      locked = false;
      if (cancel) {
        await new Promise(resolve => setTimeout(resolve, 100));
        assert.equal(f.calls.length, 0, 'cancelled selection cannot open Desktop later');
      } else {
        assert.equal((await f.response('during-recovery')).status, 'accepted');
        assert.equal(f.calls.length, 1);
      }
    } finally { await f.close(); }
  }
});

test('an immediate cancellation cannot overtake desktop-read registration', async () => {
  const f = await fixture({ ownerRouter: { isRecoveryLocked: () => false } });
  try {
    f.request('immediate');
    f.send({ type: 'cancel-reply', id: 'immediate' });
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.equal(f.calls.length, 0, 'cancelled request must never navigate');
    assert.equal(f.messages.some(m => m.id === 'immediate' && m.type === 'response'), false);
  } finally { await f.close(); }
});

test('fresh authorized desktop unread uses the requested scope without synthetic notification clears', async () => {
  let lists = 0; const f = await fixture({ listThreads: async () => { lists++; return listed(); } });
  try {
    await f.barrier(); assert.equal(f.messages.find(m => m.type === 'capabilities').desktopUnreadOpen, 1);
    f.request('ok'); assert.equal((await f.response('ok')).status, 'accepted');
    assert.equal(lists, 1); assert.equal(f.calls[0][0], threadId); assert.equal(f.calls[0][1], scope);
    assert.equal(f.messages.some(m => m.type === 'task-notification-clear'), false);
  } finally { await f.close(); }
});

test('truncated sidebar permits only a separately authorized search result to sync its unread state', async () => {
  for (const allow of [true, false]) {
    const f = await fixture({ listThreads: async ({ before } = {}) => ({ ...listed(), recent: [], nextCursor: { id: otherThread, recency: (before?.recency ?? 100) - 1 } }), authorize: async ids => new Map(allow ? ids.map(id => [id, 'Allowed']) : []) });
    try { f.request('older'); assert.equal((await f.response('older')).status, allow ? 'accepted' : 'unavailable'); assert.equal(f.calls.length, allow ? 1 : 0); }
    finally { await f.close(); }
  }
});

test('connector acknowledges only after the native state really changes from unread to read', async () => {
  let release, opened = false, unread = true;
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ navigate: (id, scopeKey, { isCancelled }) => navigateDesktopUnread(id, scopeKey, {
    isCancelled,
    readState: async () => ({ status: 'available', canReadUnread: true, scopeKey: scope, unreadThreadIds: new Set(unread ? [threadId] : []) }),
    openThread: async () => { opened = true; await gate; },
  }) });
  try {
    f.request('real-state'); await until(() => opened);
    assert.equal(f.messages.some(message => message.id === 'real-state'), false, 'opening is not proof of read');
    unread = false; release(); assert.equal((await f.response('real-state')).status, 'accepted');
    assert.equal(f.messages.some(message => message.type === 'task-notification-clear'), false);
  } finally { release(); await f.close(); }
});

test('unlisted, unsupported scope and malformed requests never navigate', async () => {
  for (const mode of ['unlisted', 'scope', 'malformed']) {
    const f = await fixture({ listThreads: async () => mode === 'unlisted' ? { ...listed(), recent: [] } : mode === 'scope' ? { ...listed(), nativeUnread: { ...listed().nativeUnread, scopeKey: 'c'.repeat(64) } } : listed() });
    try { f.request('bad', mode === 'malformed' ? { scopeKey: 'bad' } : {}); assert.equal((await f.response('bad')).status, 'unavailable'); assert.equal(f.calls.length, 0); }
    finally { await f.close(); }
  }
});

test('cancel and revocation during authorization prevent navigation', async () => {
  for (const type of ['cancel-reply', 'device-revoked']) {
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({ listThreads: async () => { entered = true; await gate; return listed(); } });
    try { f.request('wait'); await until(() => entered); f.send({ type, id: 'wait', deviceId }); await f.barrier(); release(); await new Promise(resolve => setTimeout(resolve, 20)); assert.equal(f.calls.length, 0); }
    finally { release(); await f.close(); }
  }
});

test('navigation is serialized with both general and notification read operations', async () => {
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const monitor = { start() { return this; }, async close() {}, async readOnDesktop() { assert.fail('conflicting navigation must not start'); } };
  const f = await fixture({ notificationMonitor: monitor, navigate: async () => { entered = true; await gate; return { read: true }; } });
  try {
    f.send({ type: 'notification-settings', enabled: true }); await f.barrier(); f.request('first'); await until(() => entered);
    f.request('second'); assert.equal((await f.response('second')).status, 'unavailable');
    f.send({ type: 'notification-read', id: 'notification', conversationId: threadId, eventId: 'event', deviceId });
    assert.equal((await f.response('notification')).status, 'unavailable');
    release(); assert.equal((await f.response('first')).status, 'accepted');
  } finally { release(); await f.close(); }
});

test('after cancelled A settles, latest B rechecks authorization and scope before navigation', async () => {
  for (const nextType of ['desktop-read', 'notification-read']) {
    let release, entered = false, allow = true, currentScope = scope;
    const gate = new Promise(resolve => { release = resolve; });
    const monitor = { start() { return this; }, async close() {}, async readOnDesktop() { return { read: true }; } };
    const f = await fixture({ notificationMonitor: monitor,
      listThreads: async () => ({ ...listed(), recent: allow ? [{ id: threadId, recency: 2 }, { id: otherThread, recency: 1 }] : [{ id: threadId, recency: 2 }], nativeUnread: { ...listed().nativeUnread, scopeKey: currentScope } }),
      navigate: async id => { if (id === threadId) { entered = true; await gate; } return { read: true }; },
    });
    try {
      f.send({ type: 'notification-settings', enabled: true }); await f.barrier();
      f.request('a'); await until(() => entered);
      f.send({ type: 'cancel-reply', id: 'a' }); await f.barrier();
      if (nextType === 'desktop-read') f.request('b', { conversationId: otherThread });
      else f.send({ type: nextType, id: 'b', conversationId: otherThread, eventId: 'event', deviceId });
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal(f.calls.length, 1, 'B cannot navigate before A settles');
      assert.equal(f.messages.some(message => message.id === 'b'), false);
      if (nextType === 'desktop-read') { allow = false; currentScope = 'c'.repeat(64); }
      release();
      assert.equal((await f.response('b')).status, nextType === 'desktop-read' ? 'unavailable' : 'accepted');
      assert.equal(f.calls.length, 1, 'a revoked B authorization cannot reach native navigation');
      assert.equal(f.messages.some(message => message.id === 'a'), false);
    } finally { release(); await f.close(); }
  }
});

test('newest general navigation executes only after cancelled predecessor has settled', async () => {
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ listThreads: async () => ({ ...listed(), recent: [{ id: threadId, recency: 2 }, { id: otherThread, recency: 1 }] }),
    navigate: async id => { if (id === threadId) { entered = true; await gate; } return { read: true }; } });
  try {
    f.request('a'); await until(() => entered); f.send({ type: 'cancel-reply', id: 'a' }); await f.barrier();
    f.request('b', { conversationId: otherThread }); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.calls.length, 1); release(); assert.equal((await f.response('b')).status, 'accepted');
    assert.deepEqual(f.calls.map(call => call[0]), [threadId, otherThread]);
  } finally { release(); await f.close(); }
});

test('a newer request arriving before the predecessor abort waits for explicit cancellation and settlement', async () => {
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ listThreads: async () => ({ ...listed(), recent: [{ id: threadId, recency: 2 }, { id: otherThread, recency: 1 }] }),
    navigate: async id => { if (id === threadId) { entered = true; await gate; } return { read: true }; } });
  try {
    f.request('a'); await until(() => entered);
    f.request('b', { conversationId: otherThread });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(f.calls.length, 1); assert.equal(f.messages.some(message => message.id === 'b'), false);
    f.send({ type: 'cancel-reply', id: 'a' }); await f.barrier(); release();
    assert.equal((await f.response('b')).status, 'accepted');
    assert.deepEqual(f.calls.map(call => call[0]), [threadId, otherThread]);
  } finally { release(); await f.close(); }
});

test('normal predecessor completion is never mistaken for explicit cancellation', async () => {
  for (const outcome of ['accepted', 'rejected']) {
    let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({ listThreads: async () => ({ ...listed(), recent: [{ id: threadId, recency: 2 }, { id: otherThread, recency: 1 }] }),
      navigate: async id => { if (id === threadId) { entered = true; await gate; return { read: outcome === 'accepted' }; } return { read: true }; } });
    try {
      f.request('a'); await until(() => entered); f.request('b', { conversationId: otherThread });
      await new Promise(resolve => setTimeout(resolve, 10)); release();
      assert.equal((await f.response('a')).status, outcome === 'accepted' ? 'accepted' : 'unavailable');
      assert.equal((await f.response('b')).status, 'unavailable');
      assert.deepEqual(f.calls.map(call => call[0]), [threadId]);
    } finally { release(); await f.close(); }
  }
});

test('queued navigation cancellation, revocation and scope changes prevent a later open', async () => {
  for (const condition of ['cancel', 'revoke', 'scope']) {
    let release, entered = false, currentScope = scope; const gate = new Promise(resolve => { release = resolve; });
    const f = await fixture({ listThreads: async () => ({ ...listed(), recent: [{ id: threadId, recency: 2 }, { id: otherThread, recency: 1 }], nativeUnread: { ...listed().nativeUnread, scopeKey: currentScope } }),
      navigate: async id => { if (id === threadId) { entered = true; await gate; } return { read: true }; } });
    try {
      f.request('a'); await until(() => entered); f.send({ type: 'cancel-reply', id: 'a' }); await f.barrier();
      f.request('b', { conversationId: otherThread }); await new Promise(resolve => setTimeout(resolve, 30));
      if (condition === 'cancel') f.send({ type: 'cancel-reply', id: 'b' });
      else if (condition === 'revoke') f.send({ type: 'device-revoked', deviceId });
      else currentScope = 'c'.repeat(64);
      await f.barrier(); release();
      if (condition === 'scope') assert.equal((await f.response('b')).status, 'unavailable');
      else await new Promise(resolve => setTimeout(resolve, 60));
      assert.equal(f.calls.length, 1);
    } finally { release(); await f.close(); }
  }
});

test('at most one cancelled-navigation successor waits; newest replaces it and wait time is bounded', { timeout: 5000 }, async () => {
  let release, entered = false; const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture({ listThreads: async () => ({ ...listed(), recent: [threadId, otherThread, thirdThread].map((id, recency) => ({ id, recency })) }),
    navigate: async id => { if (id === threadId) { entered = true; await gate; } return { read: true }; } });
  try {
    f.request('a'); await until(() => entered); f.send({ type: 'cancel-reply', id: 'a' }); await f.barrier();
    f.request('b', { conversationId: otherThread }); await new Promise(resolve => setTimeout(resolve, 30));
    f.request('c', { conversationId: thirdThread }); assert.equal((await f.response('b')).status, 'unavailable');
    assert.equal((await f.response('c')).status, 'unavailable', 'stalled predecessor cannot hold a successor indefinitely');
    assert.equal(f.calls.length, 1);
  } finally { release(); await f.close(); }
});
