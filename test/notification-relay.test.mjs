import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer } from 'node:net';
import { once, EventEmitter } from 'node:events';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';
import { relayConfig } from '../src/relay/cli.mjs';
import { generateVapidKeys } from '../src/notifications/push-service.mjs';

function subscription(endpoint = 'https://web.push.apple.com/' + randomUUID()) {
  const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
  return { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}

async function fixture({ enabled = true, sender, maxInFlight, maxNotificationStreams, foregroundAckMs = 500, now } = {}) {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const publicKeys = await generateVapidKeys();
  const deliveries = [], peers = [];
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const relay = createPairRelay({ origin, foregroundAckMs, ...(now ? { now } : {}), ...(maxNotificationStreams === undefined ? {} : { maxNotificationStreams }), ...(enabled ? { notifications: {
    database: ':memory:', vapidDetails: { subject: 'mailto:push@example.test', ...publicKeys },
    ...(maxInFlight === undefined ? {} : { maxInFlight }),
    sendNotification: sender ?? (async (sub, data) => { deliveries.push({ subscription: sub, data: JSON.parse(data) }); }),
  } } : {}) });
  await relay.listen(port);
  const request = (path, { method = 'GET', data, cookie, extra = {} } = {}) => fetch(base + path, {
    method, headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const pair = async host => {
    const issued = await request('/api/host/pair-code', { method: 'POST', data: {}, extra: { authorization: 'Bearer ' + host.secret } });
    const code = await issued.json(); assert.equal(issued.status, 200);
    const paired = await request('/api/pair', { method: 'POST', data: { qrToken: code.qrToken } });
    assert.equal(paired.status, 200);
    return { ...(await paired.json()), cookie: paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  };
  const enroll = async () => {
    const response = await request('/api/enroll', { method: 'POST', data: { name: 'Notification test host' } });
    assert.equal(response.status, 201);
    const host = await response.json(); return { ...host, phone: await pair(host) };
  };
  const connector = async (host, { capable = true } = {}) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: 'Bearer ' + host.secret } });
    peers.push(ws);
    const messages = [], changed = new EventEmitter();
    ws.on('message', raw => { messages.push(JSON.parse(raw)); changed.emit('change'); });
    const wait = (predicate, start = 0) => {
      const found = () => messages.slice(start).find(predicate);
      if (found()) return Promise.resolve(found());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { changed.off('change', check); reject(new Error('Expected connector message not received')); }, 1500);
        const check = () => { const value = found(); if (value) { clearTimeout(timer); changed.off('change', check); resolve(value); } };
        changed.on('change', check); check();
      });
    };
    await once(ws, 'open');
    await wait(message => message.type === 'flow-probe');
    ws.send(JSON.stringify({ type: 'capabilities', streamFlow: 2, ...(capable ? { taskNotifications: 1 } : {}) }));
    if (enabled && capable) await wait(message => message.type === 'notification-settings');
    const barrier = async () => { const pong = once(ws, 'pong'); ws.ping(); await pong; };
    await barrier();
    return { ws, messages, wait,
      async health(reason, extra = {}) { ws.send(JSON.stringify({ type: 'notification-health', health: { reason, ...extra } })); await barrier(); },
      async clear(event) { ws.send(JSON.stringify({ type: 'task-notification-clear', event })); await barrier(); },
      async event(event, extra = {}) {
        const cursor = messages.length;
        ws.send(JSON.stringify({ type: 'task-notification', event, ...extra }));
        return wait(message => message.type === 'notification-settings' && message.eventId === event.eventId, cursor);
      },
    };
  };
  const streams = [];
  const foreground = async (phone, { sessionId = randomUUID(), threadId = null, autoAck = true } = {}) => {
    const frames = [], changed = new EventEmitter(); let buffer = '', resolveEnd;
    const ended = new Promise(resolve => resolveEnd = resolve);
    const stream = http.get(base + '/api/notifications/events?sessionId=' + sessionId + '&threadId=' + (threadId ?? ''), { headers: { ...headers, cookie: phone.cookie, 'x-codex-expected-device': phone.deviceId } });
    streams.push(stream);
    stream.on('error', () => resolveEnd());
    stream.on('response', response => {
      response.on('data', bytes => {
        buffer += bytes.toString();
        let split;
        while ((split = buffer.indexOf('\n\n')) >= 0) {
          const block = buffer.slice(0, split); buffer = buffer.slice(split + 2);
          const name = /^event: (.+)$/m.exec(block)?.[1], data = /^data: (.+)$/m.exec(block)?.[1];
          if (name && data) {
            const value = JSON.parse(data); frames.push({ event: name, data: value }); changed.emit('change');
            if (autoAck && name === 'task-notification') void request('/api/notifications/ack', { method: 'POST', data: { sessionId, ackId: value.ackId, threadId: value.threadId, eventId: value.eventId }, cookie: phone.cookie, extra: { 'x-codex-expected-device': phone.deviceId } }).catch(() => {});
          }
        }
      });
      response.once('end', resolveEnd); response.once('close', resolveEnd);
    });
    const wait = (predicate, start = 0) => {
      const found = () => frames.slice(start).find(predicate);
      if (found()) return Promise.resolve(found());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { changed.off('change', check); reject(new Error('Expected foreground frame not received')); }, 1500);
        const check = () => { const frame = found(); if (frame) { clearTimeout(timer); changed.off('change', check); resolve(frame); } };
        changed.on('change', check); check();
      });
    };
    await wait(frame => frame.event === 'connected');
    return { sessionId, frames, wait, ended, close: () => stream.destroy(),
      ack: (frame, overrides = {}) => request('/api/notifications/ack', { method: 'POST', data: { sessionId, ackId: frame.data.ackId, threadId: frame.data.threadId, eventId: frame.data.eventId, ...overrides }, cookie: phone.cookie, extra: { 'x-codex-expected-device': phone.deviceId } }),
      presence: (visible = true, selected = threadId) => request('/api/notifications/presence', { method: 'POST', data: { sessionId, threadId: selected, visible }, cookie: phone.cookie, extra: { 'x-codex-expected-device': phone.deviceId } }),
    };
  };
  return { relay, origin, base, headers, request, pair, enroll, connector, foreground, deliveries, publicKeys,
    async close() { for (const stream of streams) stream.destroy(); for (const peer of peers) peer.terminate(); await relay.close(); },
  };
}
const event = (overrides = {}) => ({ eventId: randomUUID(), threadId: randomUUID(), kind: 'completed', createdAt: Date.now(), ...overrides });

test('desktop exact-event clears sync to foreground and authenticated catch-up without another system notification', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll(), peerA = await f.connector(a), peerB = await f.connector(b);
    for (const host of [a, b]) await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const sa = await f.foreground(a.phone), sb = await f.foreground(b.phone); await sa.presence(true); await sb.presence(true);
    const live = event();
    const identity = { 'x-codex-expected-device': a.phone.deviceId };
    const catchup = () => f.request('/api/notifications/cleared', { cookie: a.phone.cookie, extra: identity });
    assert.equal((await f.request('/api/notifications/cleared')).status, 401);
    assert.equal((await f.request('/api/notifications/cleared', { cookie: a.phone.cookie })).status, 409);
    assert.equal((await f.request('/api/notifications/cleared', { cookie: a.phone.cookie, extra: { ...identity, origin: 'https://other.test', 'sec-fetch-site': 'cross-site' } })).status, 403);
    await peerA.clear({ ...live, reason: 'invalid' }); assert.deepEqual(await (await catchup()).json(), { cleared: [] });
    await peerA.clear({ ...live, reason: 'desktop-read', title: 'PRIVATE CHAT' });
    const cleared = { threadId: live.threadId, eventId: live.eventId };
    await sa.wait(frame => frame.event === 'task-notification-clear' && frame.data.eventId === live.eventId);
    assert.deepEqual(sa.frames.at(-1).data, cleared); assert.equal(sb.frames.some(frame => frame.event === 'task-notification-clear'), false);
    assert.deepEqual(await (await catchup()).json(), { cleared: [cleared] });
    const other = await f.request('/api/notifications/cleared', { cookie: b.phone.cookie, extra: { 'x-codex-expected-device': b.phone.deviceId } });
    assert.deepEqual(await other.json(), { cleared: [] }); assert.equal(f.deliveries.length, 0);
    await sa.presence(false); await peerA.event(live);
    assert.equal(f.deliveries.length, 0, 'late exact-event notification cannot re-light a resolved reminder');
    const next = event({ threadId: live.threadId }); await peerA.event(next);
    assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].data.eventId, next.eventId);
    await peerB.clear({ ...live, reason: 'resolved' });
    assert.equal(f.deliveries.length, 1, 'clear metadata never emits a system notification');
    const replacement = await f.pair(a);
    assert.equal((await catchup()).status, 401);
    const restored = await f.request('/api/notifications/cleared', { cookie: replacement.cookie, extra: { 'x-codex-expected-device': replacement.deviceId } });
    assert.deepEqual(await restored.json(), { cleared: [cleared] });
  } finally { await f.close(); }
});

test('notification relay defaults disabled and rejects enabling push without VAPID configuration', { timeout: 10000 }, async () => {
  assert.equal(relayConfig({ HUB_ORIGIN: 'https://relay.example.test' }).notifications, undefined);
  assert.throws(() => relayConfig({ HUB_ORIGIN: 'https://relay.example.test', HUB_NOTIFICATIONS: '1' }), /VAPID/);
  assert.throws(() => createPairRelay({ origin: 'https://relay.example.test', notifications: {} }), /VAPID/);
  for (const maxNotificationStreams of [0, -1, 1.5, NaN, 10001, '2']) {
    assert.throws(() => createPairRelay({ origin: 'https://relay.example.test', maxNotificationStreams }), /notification stream limit/);
  }
  const f = await fixture({ enabled: false });
  try {
    const host = await f.enroll();
    assert.deepEqual(await (await f.request('/api/notifications', { cookie: host.phone.cookie })).json(), { enabled: false });
    assert.deepEqual(await (await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie })).json(), { enabled: false });
  } finally { await f.close(); }
});

test('notifications work from desktop host events without any phone SSE and cannot cross host boundaries', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll();
    const ca = await f.connector(a), cb = await f.connector(b);
    const sa = subscription(), sb = subscription();
    const cursorA = ca.messages.length, cursorB = cb.messages.length;
    assert.equal((await f.request('/api/notifications', { method: 'POST', data: { subscription: sa }, cookie: a.phone.cookie })).status, 200);
    assert.equal((await ca.wait(message => message.type === 'notification-settings', cursorA)).enabled, true);
    assert.equal((await f.request('/api/notifications', { method: 'POST', data: { subscription: sb }, cookie: b.phone.cookie })).status, 200);
    assert.equal((await cb.wait(message => message.type === 'notification-settings', cursorB)).enabled, true);
    const live = event();
    await ca.event(live, { hostId: b.hostId, deviceId: b.phone.deviceId });
    assert.equal(f.deliveries.length, 1);
    assert.equal(f.deliveries[0].subscription.endpoint, sa.endpoint);
    assert.equal(f.deliveries[0].data.hostId, a.hostId);
    assert.equal(f.deliveries[0].data.deviceId, a.phone.deviceId);
    await ca.event(live); assert.equal(f.deliveries.length, 1);
    await cb.event({ ...live, kind: 'question' }); assert.equal(f.deliveries.length, 2);
    assert.equal(f.deliveries[1].subscription.endpoint, sb.endpoint);
    assert.equal(f.deliveries[1].data.hostId, b.hostId);
    const scoped = await f.request('/api/notifications/status', { method: 'POST', data: { endpoint: sa.endpoint }, cookie: b.phone.cookie });
    assert.deepEqual(await scoped.json(), { enabled: true, subscribed: false, publicKey: f.publicKeys.publicKey, desktopReady: true, monitorStatus: 'starting' });
    assert.equal(ca.messages.some(message => message.type === 'request'), false);
    assert.equal(cb.messages.some(message => message.type === 'request'), false);
  } finally { await f.close(); }
});

test('notification readiness distinguishes offline and legacy desktops and permits removing a stored subscription after downgrade', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.enroll(), sub = subscription();
    const status = async () => (await f.request('/api/notifications', { cookie: host.phone.cookie })).json();
    assert.deepEqual({ ...await status(), publicKey: undefined }, { enabled: true, subscribed: false, publicKey: undefined, desktopReady: false, monitorStatus: 'offline' });
    assert.equal((await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie })).status, 409);
    const legacy = await f.connector(host, { capable: false });
    assert.equal((await status()).monitorStatus, 'unsupported');
    assert.equal((await status()).desktopReady, false);
    assert.equal((await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie })).status, 409);
    assert.equal(legacy.messages.some(message => message.type === 'notification-settings'), false);
    await legacy.health('ready'); assert.equal((await status()).monitorStatus, 'unsupported');
    legacy.ws.close(); await once(legacy.ws, 'close');
    const modern = await f.connector(host);
    assert.equal((await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie })).status, 200);
    modern.ws.close(); await once(modern.ws, 'close');
    await f.connector(host, { capable: false });
    const stored = await status(); assert.equal(stored.subscribed, true); assert.equal(stored.desktopReady, false);
    assert.equal((await f.request('/api/notifications', { method: 'DELETE', data: { endpoint: sub.endpoint }, cookie: host.phone.cookie })).status, 200);
    assert.equal((await status()).subscribed, false);
  } finally { await f.close(); }
});

test('a saved subscription is starting until the exact desktop monitor confirms ready, and health errors stay visible', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll(), ca = await f.connector(a), cb = await f.connector(b), sub = subscription();
    const status = async (host = a, endpoint = sub.endpoint) => (await f.request('/api/notifications/status', { method: 'POST', data: { endpoint }, cookie: host.phone.cookie })).json();
    await ca.health('ready'); assert.equal((await status()).monitorStatus, 'idle', 'health outside an active monitoring session is ignored');
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: a.phone.cookie });
    let state = await status(); assert.equal(state.subscribed, true); assert.equal(state.desktopReady, true); assert.equal(state.monitorStatus, 'starting');
    await cb.health('ready'); assert.equal((await status()).monitorStatus, 'starting', 'another host cannot declare this monitor ready');
    await ca.health('ready'); assert.equal((await status()).monitorStatus, 'healthy');
    await ca.health('observe-unavailable', { message: 'PRIVATE CHAT', threadId: sub.endpoint });
    state = await status(); assert.equal(state.monitorStatus, 'degraded'); assert.equal(state.monitorReason, 'observe-unavailable');
    assert.doesNotMatch(JSON.stringify(state), /PRIVATE CHAT|threadId/);
    await ca.health('invented-error'); assert.equal((await status()).monitorReason, 'observe-unavailable');
    await ca.health('ready'); assert.equal((await status()).monitorStatus, 'healthy');
    await f.request('/api/notifications', { method: 'DELETE', data: { endpoint: sub.endpoint }, cookie: a.phone.cookie });
    await ca.health('ready'); assert.equal((await status()).monitorStatus, 'idle');
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: a.phone.cookie });
    assert.equal((await status()).monitorStatus, 'starting', 'resubscription requires a new monitor health confirmation');
  } finally { await f.close(); }
});

test('push routes require a paired current device, same-origin requests and the expected device', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll(), sub = subscription();
    await f.connector(a);
    const routes = [
      ['/api/notifications', 'GET', undefined],
      ['/api/notifications', 'POST', { subscription: sub }],
      ['/api/notifications/status', 'POST', { endpoint: sub.endpoint }],
      ['/api/notifications', 'DELETE', { endpoint: sub.endpoint }],
    ];
    for (const [path, method, data] of routes) {
      assert.equal((await f.request(path, { method, data })).status, 401);
      assert.equal((await f.request(path, { method, data, cookie: a.phone.cookie, extra: { origin: 'https://attacker.example', 'sec-fetch-site': 'cross-site' } })).status, 403);
      assert.equal((await f.request(path, { method, data, cookie: a.phone.cookie, extra: { 'x-codex-expected-device': b.phone.deviceId } })).status, 409);
    }
    // The browser switched to host B while an old host A write was prepared.
    const both = [a.phone.cookie, b.phone.cookie].flatMap(cookie => cookie.split('; ').filter(value => !value.startsWith('__Host-codex-current='))).join('; ') + '; __Host-codex-current=' + b.phone.deviceId;
    const stale = await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: both, extra: { 'x-codex-expected-device': a.phone.deviceId } });
    assert.equal(stale.status, 409);
    assert.equal((await (await f.request('/api/notifications', { cookie: b.phone.cookie })).json()).subscribed, false);
    assert.equal((await f.request('/api/notifications', { method: 'POST', cookie: a.phone.cookie, data: { subscription: sub, hostId: b.hostId } })).status, 400);
    assert.equal((await f.request('/api/notifications', { method: 'POST', cookie: a.phone.cookie, data: { subscription: subscription('https://127.0.0.1/private') } })).status, 400);
  } finally { await f.close(); }
});

test('unsubscribe, device replacement and explicit revocation stop background notifications', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.enroll(), peer = await f.connector(host), sub = subscription();
    const subscribe = async phone => {
      const cursor = peer.messages.length;
      const response = await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: phone.cookie });
      assert.equal(response.status, 200);
      await peer.wait(message => message.type === 'notification-settings' && message.enabled, cursor);
    };
    await subscribe(host.phone);
    const cursor = peer.messages.length;
    assert.equal((await f.request('/api/notifications', { method: 'DELETE', data: { endpoint: sub.endpoint }, cookie: host.phone.cookie })).status, 200);
    assert.equal((await peer.wait(message => message.type === 'notification-settings', cursor)).enabled, false);
    await peer.event(event()); assert.equal(f.deliveries.length, 0);
    await subscribe(host.phone);
    const replacement = await f.pair(host);
    assert.equal((await f.request('/api/notifications', { cookie: host.phone.cookie })).status, 401);
    assert.equal((await (await f.request('/api/notifications', { cookie: replacement.cookie })).json()).subscribed, false);
    await peer.event(event()); assert.equal(f.deliveries.length, 0);
    await subscribe(replacement);
    const revoked = await f.request(`/api/host/devices/${replacement.deviceId}/revoke`, { method: 'POST', data: {}, extra: { authorization: 'Bearer ' + host.secret } });
    assert.equal(revoked.status, 200);
    assert.equal((await f.request('/api/notifications', { cookie: replacement.cookie })).status, 401);
    await peer.event(event()); assert.equal(f.deliveries.length, 0);
  } finally { await f.close(); }
});

test('a subscription body arriving after pairing replacement is rejected before registration', { timeout: 10000 }, async () => {
  const f = await fixture();
  let request;
  try {
    const host = await f.enroll();
    const payload = JSON.stringify({ subscription: subscription() });
    const response = new Promise((resolve, reject) => {
      request = http.request(f.base + '/api/notifications', { method: 'POST', headers: { ...f.headers, cookie: host.phone.cookie, 'content-length': Buffer.byteLength(payload) } }, res => {
        const chunks = []; res.on('data', data => chunks.push(data)); res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(Buffer.concat(chunks).toString()) }));
      });
      request.on('error', reject); request.write(payload.slice(0, 20));
    });
    // The incomplete request and the replacement use ordered writes on distinct
    // loopback connections. Either admission order must reject the old device.
    const replacement = await f.pair(host);
    if (!request.destroyed) request.end(payload.slice(20));
    const result = await response; assert.equal(result.status, 401);
    assert.equal((await (await f.request('/api/notifications', { cookie: replacement.cookie })).json()).subscribed, false);
  } finally { request?.destroy(); await f.close(); }
});

test('expired upstream subscription disables connector monitoring and malformed or stale events never push', { timeout: 10000 }, async () => {
  let attempts = 0;
  const f = await fixture({ sender: async () => { attempts++; throw Object.assign(new Error('expired'), { statusCode: 410 }); } });
  try {
    const host = await f.enroll(), peer = await f.connector(host);
    const cursor = peer.messages.length;
    await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    await peer.wait(message => message.type === 'notification-settings' && message.enabled, cursor);
    await peer.event(event({ createdAt: Date.now() - 300000 }));
    await peer.event(event({ threadId: 'not-a-thread' }));
    assert.equal(attempts, 0);
    const live = event();
    assert.equal((await peer.event(live)).enabled, false);
    assert.equal(attempts, 1);
    assert.equal((await (await f.request('/api/notifications', { cookie: host.phone.cookie })).json()).subscribed, false);
    await peer.event(live); assert.equal(attempts, 1);
  } finally { await f.close(); }
});

test('push delivery failure remains degraded through monitor ready and only real success clears it', { timeout: 10000 }, async () => {
  let fail = true, attempts = 0;
  const f = await fixture({ sender: async () => { attempts++; if (fail) throw Object.assign(new Error('upstream unavailable'), { statusCode: 503 }); } });
  try {
    const host = await f.enroll(), peer = await f.connector(host), sub = subscription();
    const status = async () => (await f.request('/api/notifications', { cookie: host.phone.cookie })).json();
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie });
    await peer.health('ready'); assert.equal((await status()).monitorStatus, 'healthy');
    const failure = event(); await peer.event(failure);
    assert.equal((await status()).monitorReason, 'delivery-unavailable');
    await peer.health('ready'); assert.equal((await status()).monitorStatus, 'degraded');
    fail = false;
    await peer.event(failure); assert.equal(attempts, 1);
    assert.equal((await status()).monitorReason, 'delivery-unavailable', 'deduplicated events cannot prove recovery');
    await peer.event(event()); assert.equal((await status()).monitorStatus, 'healthy');
    await peer.health('observe-unavailable');
    await peer.event(event());
    assert.equal((await status()).monitorStatus, 'degraded');
    assert.equal((await status()).monitorReason, 'observe-unavailable', 'successful delivery cannot hide a broken observer');
    await peer.health('ready'); assert.equal((await status()).monitorStatus, 'healthy');
  } finally { await f.close(); }
});

test('capacity-skipped delivery is degraded and a completed real delivery restores only sending health', { timeout: 10000 }, async () => {
  let release, started;
  const began = new Promise(resolve => started = resolve), blocked = new Promise(resolve => release = resolve);
  const f = await fixture({ maxInFlight: 1, sender: async () => { started(); await blocked; } });
  try {
    const host = await f.enroll(), peer = await f.connector(host), sub = subscription();
    const status = async () => (await f.request('/api/notifications', { cookie: host.phone.cookie })).json();
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie });
    await peer.health('ready');
    const first = peer.event(event()); await began;
    await peer.event(event());
    assert.equal((await status()).monitorReason, 'delivery-unavailable');
    await peer.health('ready'); assert.equal((await status()).monitorStatus, 'degraded');
    release(); await first;
    assert.equal((await status()).monitorStatus, 'healthy');
  } finally { release?.(); await f.close(); }
});

test('a rejected push event marks delivery unavailable without exposing errors and requires real successful sending to recover', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.enroll(), peer = await f.connector(host), sub = subscription();
    const status = async () => (await f.request('/api/notifications', { cookie: host.phone.cookie })).json();
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie });
    await peer.health('ready'); assert.equal((await status()).monitorStatus, 'healthy');
    // Validation rejects the notify promise rather than returning {failed}, so
    // this exercises the relay's exceptional path without mocking its internals.
    await peer.event(event({ threadId: 'private-invalid-thread' }));
    const failed = await status();
    assert.equal(failed.monitorStatus, 'degraded'); assert.equal(failed.monitorReason, 'delivery-unavailable');
    assert.doesNotMatch(JSON.stringify(failed), /private-invalid-thread|Invalid push event/);
    assert.equal(f.deliveries.length, 0);
    await peer.health('ready'); assert.equal((await status()).monitorStatus, 'degraded');
    await peer.event(event()); assert.equal(f.deliveries.length, 1);
    assert.equal((await status()).monitorStatus, 'healthy');
  } finally { await f.close(); }
});

test('a live visible foreground stream receives task events instead of system push, and background immediately restores push', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.enroll(), peer = await f.connector(host), sub = subscription();
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie });
    const currentThread = randomUUID(), stream = await f.foreground(host.phone, { threadId: currentThread });
    await peer.event(event()); assert.equal(f.deliveries.length, 1, 'an idle SSE alone does not assert foreground');
    assert.equal((await stream.presence(true)).status, 200);
    const live = event({ threadId: currentThread });
    await peer.event(live);
    const frame = await stream.wait(value => value.event === 'task-notification' && value.data.eventId === live.eventId);
    assert.deepEqual(frame.data, { eventId: live.eventId, threadId: currentThread, kind: 'completed', createdAt: live.createdAt, ackId: frame.data.ackId });
    assert.match(frame.data.ackId, /^[0-9a-f-]{36}$/);
    assert.equal(f.deliveries.length, 1, 'current task is routed to UI for suppression without a system notification');
    await peer.event(live); assert.equal(stream.frames.filter(value => value.event === 'task-notification').length, 1);
    assert.equal((await stream.presence(false)).status, 200);
    assert.equal((await stream.presence(true)).status, 409, 'a delayed foreground heartbeat cannot reactivate a background session');
    await peer.event(event()); assert.equal(f.deliveries.length, 2);
    stream.close(); await stream.ended;
    let closedStatus;
    for (let attempt = 0; attempt < 10; attempt++) {
      closedStatus = (await stream.presence(true)).status;
      if (closedStatus === 409) break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal(closedStatus, 409, 'server must observe the independent SSE socket close');
    await peer.event(event()); assert.equal(f.deliveries.length, 3);
  } finally { await f.close(); }
});

test('any visible tab suppresses system push while hidden tabs and other pairs cannot claim that presence', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll(), peerA = await f.connector(a), peerB = await f.connector(b);
    for (const host of [a, b]) await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const visible = await f.foreground(a.phone), hidden = await f.foreground(a.phone), other = await f.foreground(b.phone);
    await visible.presence(true); await hidden.presence(false); await other.presence(true);
    const first = event(); await peerA.event(first);
    await visible.wait(value => value.event === 'task-notification' && value.data.eventId === first.eventId);
    assert.equal(hidden.frames.filter(value => value.event === 'task-notification').length, 0);
    assert.equal(other.frames.filter(value => value.event === 'task-notification').length, 0);
    assert.equal(f.deliveries.length, 0);
    const forged = await f.request('/api/notifications/presence', { method: 'POST', data: { sessionId: visible.sessionId, threadId: null, visible: true }, cookie: b.phone.cookie, extra: { 'x-codex-expected-device': b.phone.deviceId } });
    assert.equal(forged.status, 409);
    await visible.presence(false);
    await peerA.event(event()); assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].data.hostId, a.hostId);
    const second = event(); await peerB.event(second);
    await other.wait(value => value.event === 'task-notification' && value.data.eventId === second.eventId);
    assert.equal(f.deliveries.length, 1);
  } finally { await f.close(); }
});

test('foreground presence expires after 15 seconds and cannot suppress background delivery without a fresh stream', { timeout: 10000 }, async () => {
  let clock = Date.now(); const f = await fixture({ now: () => clock });
  try {
    const host = await f.enroll(), peer = await f.connector(host);
    await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const stream = await f.foreground(host.phone); await stream.presence(true);
    clock += 15001;
    await peer.event(event({ createdAt: clock }));
    await stream.ended;
    assert.equal(f.deliveries.length, 1);
    assert.equal((await stream.presence(true)).status, 409);
  } finally { await f.close(); }
});

test('pair replacement and revocation close foreground streams without affecting another pair', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll(), peerA = await f.connector(a), peerB = await f.connector(b);
    for (const host of [a, b]) await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const sa = await f.foreground(a.phone), sb = await f.foreground(b.phone);
    await sa.presence(true); await sb.presence(true);
    const replacement = await f.pair(a); await sa.ended;
    assert.equal((await sa.presence(true)).status, 401);
    await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: replacement.cookie });
    await peerA.event(event()); assert.equal(f.deliveries.length, 1);
    const live = event(); await peerB.event(live);
    await sb.wait(value => value.event === 'task-notification' && value.data.eventId === live.eventId);
    const revoked = await f.request(`/api/host/devices/${b.phone.deviceId}/revoke`, { method: 'POST', data: {}, extra: { authorization: 'Bearer ' + b.secret } });
    assert.equal(revoked.status, 200); await sb.ended;
    assert.equal((await sb.presence(true)).status, 401);
  } finally { await f.close(); }
});

test('foreground endpoints enforce authentication, origin, session shape, expected device, and stream limits', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const host = await f.enroll(), sessionId = randomUUID();
    const path = '/api/notifications/events?sessionId=' + sessionId + '&threadId=';
    assert.equal((await f.request(path)).status, 401);
    assert.equal((await f.request(path, { cookie: host.phone.cookie })).status, 409);
    const identity = { 'x-codex-expected-device': host.phone.deviceId };
    assert.equal((await f.request(path, { cookie: host.phone.cookie, extra: { ...identity, origin: 'https://other.test', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await f.request(path + '&sessionId=' + randomUUID(), { cookie: host.phone.cookie, extra: identity })).status, 400);
    const presence = { sessionId, threadId: null, visible: true };
    assert.equal((await f.request('/api/notifications/presence', { method: 'POST', data: presence, cookie: host.phone.cookie })).status, 409);
    assert.equal((await f.request('/api/notifications/presence', { method: 'POST', data: { ...presence, threadId: 'invalid' }, cookie: host.phone.cookie, extra: identity })).status, 400);
    for (let index = 0; index < 8; index++) await f.foreground(host.phone);
    assert.equal((await f.request(path, { cookie: host.phone.cookie, extra: identity })).status, 429);
  } finally { await f.close(); }
});

test('global foreground stream capacity permits replacement, releases closed slots and preserves push fallback', { timeout: 10000 }, async () => {
  const f = await fixture({ maxNotificationStreams: 2 });
  try {
    const a = await f.enroll(), b = await f.enroll(), c = await f.enroll();
    const peerA = await f.connector(a), peerC = await f.connector(c);
    for (const host of [a, b, c]) await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const firstA = await f.foreground(a.phone), streamB = await f.foreground(b.phone);
    await firstA.presence(true); await streamB.presence(true);
    const refused = await f.request('/api/notifications/events?sessionId=' + randomUUID(), { cookie: c.phone.cookie, extra: { 'x-codex-expected-device': c.phone.deviceId } });
    assert.equal(refused.status, 429); assert.deepEqual(await refused.json(), { error: 'capacity' });
    await peerC.event(event());
    assert.equal(f.deliveries.length, 1, 'capacity refusal leaves background system delivery available');
    assert.equal(f.deliveries[0].data.hostId, c.hostId);
    const streamA = await f.foreground(a.phone, { sessionId: firstA.sessionId });
    await firstA.ended; await streamA.presence(true);
    const liveA = event(); await peerA.event(liveA);
    await streamA.wait(frame => frame.event === 'task-notification' && frame.data.eventId === liveA.eventId);
    assert.equal(f.deliveries.length, 1, 'an admitted pair keeps foreground delivery at capacity');
    assert.equal((await streamB.presence(false)).status, 200); await streamB.ended;
    const streamC = await f.foreground(c.phone); await streamC.presence(true);
    const liveC = event(); await peerC.event(liveC);
    await streamC.wait(frame => frame.event === 'task-notification' && frame.data.eventId === liveC.eventId);
    assert.equal(f.deliveries.length, 1, 'closed stream releases its global slot');
  } finally { await f.close(); }
});

test('backpressure only closes the affected foreground stream while another visible tab still prevents system push', { timeout: 10000 }, async t => {
  const f = await fixture();
  try {
    const host = await f.enroll(), peer = await f.connector(host);
    await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const slow = await f.foreground(host.phone), fast = await f.foreground(host.phone);
    await slow.presence(true); await fast.presence(true);
    const write = http.ServerResponse.prototype.write;
    let slowed = false;
    t.mock.method(http.ServerResponse.prototype, 'write', function (chunk, ...args) {
      if (!slowed && typeof chunk === 'string' && chunk.startsWith('event: task-notification\n')) { slowed = true; return false; }
      return write.call(this, chunk, ...args);
    });
    const live = event(); await peer.event(live); await slow.ended;
    await fast.wait(value => value.event === 'task-notification' && value.data.eventId === live.eventId);
    assert.equal(f.deliveries.length, 0);
    assert.equal((await slow.presence(true)).status, 409);
    assert.equal((await fast.presence(false)).status, 200);
    await peer.event(event()); assert.equal(f.deliveries.length, 1);
  } finally { await f.close(); }
});


test('a writable live foreground TCP stream without page processing falls back to one system push before its lease expires', { timeout: 10000 }, async () => {
  const f = await fixture({ foregroundAckMs: 30 });
  try {
    const host = await f.enroll(), peer = await f.connector(host);
    await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: host.phone.cookie });
    const stream = await f.foreground(host.phone, { autoAck: false }); await stream.presence(true);
    const live = event(), pending = peer.event(live);
    const frame = await stream.wait(frame => frame.event === 'task-notification' && frame.data.eventId === live.eventId);
    assert.equal(frame.data.createdAt, live.createdAt); assert.equal(f.deliveries.length, 0);
    await pending;
    assert.equal(f.deliveries.length, 1); assert.equal(f.deliveries[0].data.eventId, live.eventId);
    assert.equal((await stream.presence(true)).status, 200, 'TCP and 15s foreground lease remain live; missing processing ACK is enough to restore push');
    assert.deepEqual(await (await stream.ack(frame)).json(), { accepted: false }, 'late ACK cannot revive a settled delivery');
    await peer.event(live); assert.equal(f.deliveries.length, 1);
  } finally { await f.close(); }
});

test('only an ACK from a targeted current session and exact pairing/event suppresses fallback', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    const a = await f.enroll(), b = await f.enroll(), peer = await f.connector(a);
    await f.request('/api/notifications', { method: 'POST', data: { subscription: subscription() }, cookie: a.phone.cookie });
    const stream = await f.foreground(a.phone, { autoAck: false }), idle = await f.foreground(a.phone, { autoAck: false }); await stream.presence(true);
    const live = event(), pending = peer.event(live), frame = await stream.wait(frame => frame.event === 'task-notification');
    const data = { sessionId: stream.sessionId, ackId: frame.data.ackId, threadId: live.threadId, eventId: live.eventId };
    assert.equal((await f.request('/api/notifications/ack', { method: 'POST', data })).status, 401);
    assert.equal((await f.request('/api/notifications/ack', { method: 'POST', data, cookie: a.phone.cookie })).status, 409);
    assert.equal((await f.request('/api/notifications/ack', { method: 'POST', data, cookie: a.phone.cookie, extra: { 'x-codex-expected-device': a.phone.deviceId, origin: 'https://other.test', 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await f.request('/api/notifications/ack', { method: 'POST', data: { ...data, ackId: 'bad' }, cookie: a.phone.cookie, extra: { 'x-codex-expected-device': a.phone.deviceId } })).status, 400);
    const foreign = await f.request('/api/notifications/ack', { method: 'POST', data, cookie: b.phone.cookie, extra: { 'x-codex-expected-device': b.phone.deviceId } });
    assert.deepEqual(await foreign.json(), { accepted: false });
    for (const overrides of [{ eventId: 'other-event' }, { threadId: randomUUID() }, { sessionId: idle.sessionId }]) assert.deepEqual(await (await stream.ack(frame, overrides)).json(), { accepted: false });
    assert.deepEqual(await (await stream.ack(frame)).json(), { accepted: true }); await pending;
    assert.equal(f.deliveries.length, 0);
    assert.deepEqual(await (await stream.ack(frame)).json(), { accepted: false }, 'duplicate ACK is harmless');
  } finally { await f.close(); }
});

for (const change of ['close', 'unsubscribe', 'revoke', 'clear']) test(`pending foreground ACK settles safely on ${change}`, { timeout: 10000 }, async () => {
  const f = await fixture({ foregroundAckMs: 10000 });
  try {
    const host = await f.enroll(), peer = await f.connector(host), sub = subscription();
    await f.request('/api/notifications', { method: 'POST', data: { subscription: sub }, cookie: host.phone.cookie });
    const stream = await f.foreground(host.phone, { autoAck: false }); await stream.presence(true);
    const live = event(), pending = peer.event(live); await stream.wait(frame => frame.event === 'task-notification');
    if (change === 'close') { stream.close(); await stream.ended; }
    if (change === 'unsubscribe') await f.request('/api/notifications', { method: 'DELETE', data: { endpoint: sub.endpoint }, cookie: host.phone.cookie });
    if (change === 'revoke') await f.request(`/api/host/devices/${host.phone.deviceId}/revoke`, { method: 'POST', data: {}, extra: { authorization: 'Bearer ' + host.secret } });
    if (change === 'clear') await peer.clear({ ...live, reason: 'resolved' });
    await pending;
    assert.equal(f.deliveries.length, change === 'close' ? 1 : 0, 'close falls back; withdrawn pair/subscription/event cannot send after the await');
  } finally { await f.close(); }
});
