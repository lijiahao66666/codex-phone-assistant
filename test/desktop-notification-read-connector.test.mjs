import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const hostId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const threadId = '33333333-3333-4333-8333-333333333333';
const listed = () => ({ projects: [], recent: [{ id: threadId, title: 'Fixture', recency: 1 }] });
const flush = () => new Promise(resolve => setImmediate(resolve));
async function until(check) {
  const until = Date.now() + 2000;
  while (!check()) { if (Date.now() >= until) throw new Error('Expected connector result not received'); await new Promise(resolve => setTimeout(resolve, 5)); }
}
async function fixture({ listThreads = async () => listed(), readOnDesktop = async () => ({ read: true }), threadListChangesForTests } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  const pending = once(server, 'connection'), calls = [], monitors = [], messages = [];
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    allowInsecureForTests: true, listThreads, threadListChangesForTests,
    createNotificationMonitorForTests: options => {
      const monitor = { options, start() { return this; }, async close() { this.closed = true; },
        async refreshReadReceipts() { this.refreshes = (this.refreshes || 0) + 1; },
        async readOnDesktop(event, context) { calls.push({ event, context, cancelledAtStart: context.isCancelled() }); return readOnDesktop(event, context); },
      }; monitors.push(monitor); return monitor;
    },
  });
  connector.start(); const [socket] = await pending;
  socket.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  const send = message => socket.send(JSON.stringify(message));
  return { calls, monitors, messages, connector, send,
    async barrier() { const count = messages.filter(message => message.type === 'capabilities').length; send({ type: 'flow-probe' }); await until(() => messages.filter(message => message.type === 'capabilities').length > count); },
    request(id = 'read', changes = {}) { send({ type: 'notification-read', id, conversationId: threadId, eventId: 'completed-event', deviceId, ...changes }); },
    async response(id = 'read') { await until(() => messages.some(message => message.type === 'response' && message.id === id)); return messages.find(message => message.type === 'response' && message.id === id); },
    async enable() { send({ type: 'notification-settings', enabled: true }); await until(() => monitors.length > 0); },
    async close() { await connector.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('connector advertises desktop-read and authorizes the listed thread before delegating exact-event confirmation', async () => {
  let lists = 0;
  const f = await fixture({ listThreads: async options => { lists++; return options.before ? listed() : { projects: [], recent: [], nextCursor: { id: threadId, recency: 2 } }; } });
  try {
    f.send({ type: 'flow-probe' }); await until(() => f.messages.some(message => message.type === 'capabilities'));
    assert.equal(f.messages.find(message => message.type === 'capabilities').desktopNotificationRead, 1);
    assert.equal(f.messages.find(message => message.type === 'capabilities').uiProtocol, 1);
    await f.enable(); f.request();
    assert.equal((await f.response()).status, 'accepted'); assert.equal(lists, 2);
    assert.deepEqual(f.calls[0].event, { threadId, eventId: 'completed-event' });
    assert.equal(f.calls[0].cancelledAtStart, false);
    assert.equal(f.messages.some(message => message.type === 'task-notification-clear'), false, 'the HTTP response must not synthesize an unread clear');
  } finally { await f.close(); }
});

test('notification monitoring keeps the shared watcher alive without a phone sidebar and detaches it on disable or disconnect', async () => {
  const watcher = Object.assign(new EventEmitter(), { running: false, starts: 0, stops: 0,
    start() { if (!this.running) { this.running = true; this.starts++; } },
    stop() { if (this.running) { this.running = false; this.stops++; } },
  });
  let lists = 0;
  const f = await fixture({ threadListChangesForTests: watcher, listThreads: async () => { lists++; return listed(); } });
  try {
    await f.enable(); assert.equal(watcher.running, true); assert.equal(watcher.listenerCount('change'), 1);
    watcher.emit('change', { version: 1 }); await flush();
    assert.equal(f.monitors[0].refreshes, 1); assert.equal(lists, 0, 'watcher signals do not request a full list');
    f.send({ type: 'notification-settings', enabled: false }); await f.barrier();
    assert.equal(watcher.running, false); assert.equal(watcher.listenerCount('change'), 0);
    watcher.emit('change', { version: 2 }); await flush(); assert.equal(f.monitors[0].refreshes, 1);
    f.send({ type: 'notification-settings', enabled: true }); await until(() => f.monitors.length === 2);
    assert.equal(watcher.running, true); assert.equal(watcher.listenerCount('change'), 1);
  } finally { await f.close(); }
  assert.equal(watcher.running, false); assert.equal(watcher.listenerCount('change'), 0);
});

test('connector refuses desktop-read without a running monitor or a freshly authorized listed thread', async () => {
  for (const mode of ['disabled', 'unlisted', 'malformed']) {
    const f = await fixture({ ...(mode === 'unlisted' ? { listThreads: async () => ({ projects: [], recent: [] }) } : {}) });
    try {
      if (mode !== 'disabled') await f.enable();
      f.request('read', mode === 'malformed' ? { eventId: '' } : {});
      assert.equal((await f.response()).status, 'unavailable'); assert.equal(f.calls.length, 0);
    } finally { await f.close(); }
  }
});

test('cancel, device replacement and disabled monitoring during authorization prevent desktop navigation', async () => {
  for (const action of [f => f.send({ type: 'cancel-reply', id: 'read' }), f => f.send({ type: 'device-revoked', deviceId }), f => f.send({ type: 'notification-settings', enabled: false })]) {
    let release, entered = false;
    const paused = new Promise(resolve => release = resolve);
    const f = await fixture({ listThreads: async () => { entered = true; await paused; return listed(); } });
    try {
      await f.enable(); f.request(); await until(() => entered);
      action(f); await f.barrier(); release(); await flush(); await flush();
      assert.equal(f.calls.length, 0);
    } finally { release(); await f.close(); }
  }
});

test('in-flight navigation receives revocation cancellation and prevents graceful shutdown until settled', async () => {
  let release, invoked = false;
  const paused = new Promise(resolve => release = resolve);
  const f = await fixture({ readOnDesktop: async (event, context) => { invoked = true; await paused; assert.equal(context.isCancelled(), true); throw new Error('cancelled'); } });
  try {
    await f.enable(); f.request(); await until(() => invoked);
    await assert.rejects(f.connector.beginShutdown(), error => error.code === 'tasks-active');
    f.send({ type: 'device-revoked', deviceId }); await until(() => f.calls[0].context.isCancelled()); release(); await flush(); await flush();
    assert.equal(f.messages.some(message => message.type === 'response' && message.id === 'read'), false);
  } finally { release(); await f.close(); }
});

test('test monitor injection is refused outside test mode', () => {
  assert.throws(() => createPreviewConnector({ url: 'wss://example.test/connector', secret: 's'.repeat(43), createNotificationMonitorForTests() {} }), /Test overrides are unavailable/);
});
