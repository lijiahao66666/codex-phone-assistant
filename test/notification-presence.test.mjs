import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

const pairA = { hostId: randomUUID(), deviceId: randomUUID() };
const pairB = { hostId: randomUUID(), deviceId: randomUUID() };
const threadA = randomUUID(), threadB = randomUUID();
const flush = async () => { await new Promise(resolve => setImmediate(resolve)); await new Promise(resolve => setImmediate(resolve)); };
async function fixture(fixtureOptions = {}) {
  const calls = [], streams = [], reminders = [], clears = [], timers = new Map(), docListeners = {}, pageListeners = {};
  let selected = threadA, nextTimer = 0;
  const document = { visibilityState: 'visible', addEventListener(type, fn) { docListeners[type] = fn; } };
  const window = { getNotificationThreadId: () => selected, acceptTaskNotification: event => reminders.push(event), async clearTaskNotificationEvent(event) { clears.push(event); if (fixtureOptions.clear) await fixtureOptions.clear(event); }, addEventListener(type, fn) { pageListeners[type] = fn; } };
  const context = vm.createContext({ document, window, crypto: { randomUUID }, AbortController, URLSearchParams, TextDecoder,
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => {
      calls.push({ url, ...options });
      if (!url.startsWith('/api/notifications/events?')) {
        if (fixtureOptions.hangPresence && JSON.parse(options.body || '{}').visible) return new Promise((resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
        });
        return { ok: true };
      }
      const stream = {};
      const body = new ReadableStream({ start(controller) { stream.controller = controller; }, cancel() { stream.cancelled = true; } });
      options.signal.addEventListener('abort', () => { try { stream.controller.error(new Error('Aborted')); } catch {} });
      streams.push(stream); return { ok: true, body };
    },
  });
  vm.runInContext(await readFile(new URL('../public/notification-presence.js', import.meta.url), 'utf8'), context);
  return { window, calls, streams, reminders, clears, timers,
    async enable(pair = pairA) { window.setTaskNotificationSession(pair, true); await flush(); },
    async event(type, data = {}, index = streams.length - 1) { streams[index].controller.enqueue(new TextEncoder().encode(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)); await flush(); },
    async visibility(value) { document.visibilityState = value; docListeners.visibilitychange(); await flush(); },
    async select(id) { selected = id; window.refreshNotificationPresence(); await flush(); },
    async close() { window.setTaskNotificationSession(null, false); await flush(); },
    presences() { return calls.filter(call => call.url.endsWith('/presence')).map(call => ({ ...call, data: JSON.parse(call.body) })); },
  };
}

test('foreground starts only after an authenticated stream handshake; heartbeat and task changes retain pair scope', async () => {
  const f = await fixture(); await f.enable();
  assert.equal(f.streams.length, 1); assert.equal(f.presences().length, 0);
  assert.equal(f.calls[0].headers['x-codex-expected-device'], pairA.deviceId);
  await f.event('connected');
  assert.equal(f.presences()[0].data.visible, true); assert.equal(f.presences()[0].data.threadId, threadA);
  assert.equal([...f.timers.values()][0].ms, 5000);
  for (let i = 0; i < 30; i++) f.window.refreshNotificationPresence();
  await flush(); assert.equal(f.presences().length, 1, 'streaming renders do not cause presence request storms');
  await f.select(threadB); assert.equal(f.presences().length, 2); assert.equal(f.presences()[1].data.threadId, threadB);
  const [id, timer] = [...f.timers][0]; f.timers.delete(id); timer.fn(); await flush();
  assert.equal(f.presences().length, 3); await f.close();
});

test('clear events are validated and forwarded only with the authenticated current session pairing', async () => {
  const f = await fixture(); await f.enable(); await f.event('connected');
  for (const data of [{ threadId: 'invalid', eventId: 'clear' }, { threadId: threadA, eventId: '' }, { threadId: threadA, eventId: 'x'.repeat(513) }]) await f.event('task-notification-clear', data);
  assert.equal(f.clears.length, 0);
  await f.event('task-notification-clear', { threadId: threadB, eventId: 'old-control', ...pairB });
  assert.equal(f.clears.length, 1); assert.equal(f.clears[0].hostId, pairA.hostId); assert.equal(f.clears[0].deviceId, pairA.deviceId);
  assert.equal(f.reminders.length, 0);
  await f.enable(pairB); await f.event('connected');
  await f.event('task-notification-clear', { threadId: threadA, eventId: 'new-scope' });
  assert.equal(f.clears.at(-1).hostId, pairB.hostId); assert.equal(f.clears.at(-1).deviceId, pairB.deviceId);
  await f.close();
});

test('a clear awaiting persistence cannot continue processing the old SSE session after pairing changes', async () => {
  let release;
  const f = await fixture({ clear: () => new Promise(resolve => { release = resolve; }) }); await f.enable(); await f.event('connected');
  const text = `event: task-notification-clear\ndata: ${JSON.stringify({ threadId: threadB, eventId: 'stale-clear' })}\n\nevent: task-notification\ndata: ${JSON.stringify({ threadId: threadB, eventId: 'stale-next', kind: 'approval' })}\n\n`;
  f.streams[0].controller.enqueue(new TextEncoder().encode(text)); await flush();
  assert.equal(f.clears.length, 1); await f.enable(pairB); release(); await flush();
  assert.equal(f.reminders.length, 0);
  await f.event('task-notification', { threadId: threadA, eventId: 'current', kind: 'question' });
  assert.equal(f.reminders.length, 1); assert.equal(f.reminders[0].deviceId, pairB.deviceId);
  await f.close();
});

test('background and close revoke foreground immediately with keepalive, and returning opens a new session', async () => {
  const f = await fixture(); await f.enable(); await f.event('connected');
  const first = f.presences()[0].data.sessionId;
  await f.visibility('hidden');
  assert.equal(f.presences().at(-1).data.visible, false); assert.equal(f.presences().at(-1).keepalive, true);
  assert.equal(f.timers.size, 0); assert.equal(f.streams[0].cancelled, undefined);
  await f.visibility('visible'); await f.event('connected');
  assert.notEqual(f.presences().at(-1).data.sessionId, first);
  await f.close(); assert.equal(f.presences().at(-1).data.visible, false); assert.equal(f.timers.size, 0);
});

test('only validated task events are sent to the task bar with the active paired identity', async () => {
  const f = await fixture(); await f.enable(); await f.event('connected');
  await f.event('task-notification', { threadId: threadB, kind: 'completed', eventId: 'fresh', hostId: pairB.hostId });
  assert.equal(f.reminders.length, 1); assert.equal(f.reminders[0].hostId, pairA.hostId); assert.equal(f.reminders[0].deviceId, pairA.deviceId);
  await f.event('task-notification', { threadId: threadB, kind: 'unknown', eventId: 'bad' });
  await f.event('task-notification', { threadId: 'bad', kind: 'completed', eventId: 'bad' });
  assert.equal(f.reminders.length, 1);
  await f.enable(pairB); await f.event('connected');
  await f.event('task-notification', { threadId: threadA, kind: 'question', eventId: 'other' });
  assert.equal(f.reminders.at(-1).deviceId, pairB.deviceId);
  assert.equal(f.presences().find(call => call.data.visible === false).headers['x-codex-expected-device'], pairA.deviceId);
  await f.close();
});

test('a hidden app never opens a foreground channel, and disabling notifications stops reconnection', async () => {
  const f = await fixture(); await f.visibility('hidden'); await f.enable(); assert.equal(f.streams.length, 0);
  await f.visibility('visible'); assert.equal(f.streams.length, 1);
  f.streams[0].controller.close(); await flush(); assert.equal(f.timers.size, 1);
  await f.close(); assert.equal(f.timers.size, 0);
  await f.visibility('hidden'); await f.visibility('visible'); assert.equal(f.streams.length, 1);
});

test('slow foreground heartbeats stay single flight and are aborted when the app goes to the background', async () => {
  const f = await fixture({ hangPresence: true }); await f.enable(); await f.event('connected');
  for (let index = 0; index < 20; index++) await f.select(index % 2 ? threadA : threadB);
  assert.equal(f.presences().length, 1); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 4000);
  const request = f.presences()[0]; assert.equal(request.signal.aborted, false);
  await f.visibility('hidden');
  assert.equal(request.signal.aborted, true);
  assert.equal(f.presences().length, 2); assert.equal(f.presences()[1].data.visible, false);
  assert.equal(f.timers.size, 0); await f.close();
});

test('a timed out foreground request aborts before a bounded stream reconnection', async () => {
  const f = await fixture({ hangPresence: true }); await f.enable(); await f.event('connected');
  const request = f.presences()[0], [id, timer] = [...f.timers][0];
  f.timers.delete(id); timer.fn(); await flush();
  assert.equal(request.signal.aborted, true); assert.equal(f.timers.size, 1);
  assert.equal([...f.timers.values()][0].ms, 2000);
  await f.close(); assert.equal(f.timers.size, 0);
});
