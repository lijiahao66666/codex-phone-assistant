import test from 'node:test';
import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { PushService, validatePushSubscription, createWebPushSender, generateVapidKeys } from '../src/notifications/push-service.mjs';

function subscription(endpoint = 'https://web.push.apple.com/QTest') {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
const host = randomUUID(), device = randomUUID(), otherHost = randomUUID(), otherDevice = randomUUID();
const now = 1794382000000;
const event = (overrides = {}) => ({ eventId: randomUUID(), threadId: randomUUID(), kind: 'completed', createdAt: now, ...overrides });
const options = (extra = {}) => ({ isActiveDevice: () => true, now: () => now, sendNotification: async () => {}, ...extra });

test('exact reminder clears persist, isolate hosts and do not send or suppress a newer event', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-clear-')), database = join(directory, 'push.sqlite');
  let attempts = 0, active = true, service;
  const config = options({ database, isActiveDevice: () => active, sendNotification: async () => attempts++ });
  const live = event(), cleared = { threadId: live.threadId, eventId: live.eventId };
  try {
    service = new PushService(config);
    service.subscribe(host, device, subscription()); service.subscribe(otherHost, otherDevice, subscription());
    assert.deepEqual(service.clearReminder(host, { ...live, reason: 'desktop-read', title: 'PRIVATE CHAT' }), cleared);
    assert.equal(attempts, 0);
    service.close(); service = new PushService(config);
    assert.deepEqual(service.clearedReminders(host, device).map(row => ({ ...row })), [cleared]);
    assert.deepEqual(service.clearedReminders(otherHost, otherDevice), []);
    assert.deepEqual(await service.notify(host, live), { sent: 0, skipped: 'cleared' });
    assert.deepEqual(await service.notify(otherHost, live), { sent: 1, failed: 0 });
    assert.deepEqual(await service.notify(host, event({ threadId: live.threadId })), { sent: 1, failed: 0 });
    assert.deepEqual(await service.notify(host, event({ eventId: live.eventId })), { sent: 1, failed: 0 }, 'clearing requires the exact thread too');
    assert.equal(attempts, 3);
    active = false; assert.throws(() => service.clearedReminders(host, device), /Inactive push device/);
  } finally { service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('reminder clears are bounded to the newest 1024 per host and expire after seven days', () => {
  let clock = now;
  const service = new PushService(options({ now: () => clock }));
  try {
    for (const invalid of [{}, { ...event(), reason: 'read-everything' }, { ...event(), reason: 'resolved', eventId: 'x'.repeat(513) }]) assert.throws(() => service.clearReminder(host, invalid), /Invalid reminder clear/);
    assert.equal(service.clearReminder(host, { ...event({ createdAt: now - 7 * 86400000 }), reason: 'resolved' }), null);
    assert.equal(service.clearReminder(host, { ...event({ createdAt: now + 5001 }), reason: 'resolved' }), null);
    const other = event(); service.clearReminder(otherHost, { ...other, reason: 'resolved' });
    for (let index = 0; index < 1030; index++) service.clearReminder(host, { ...event({ eventId: 'event-' + index }), reason: 'resolved' });
    const rows = service.clearedReminders(host, device);
    assert.equal(rows.length, 1024); assert.equal(rows[0].eventId, 'event-1029'); assert.equal(rows.at(-1).eventId, 'event-6');
    assert.equal(service.clearedReminders(otherHost, otherDevice).length, 1);
    clock += 7 * 86400000;
    assert.deepEqual(service.clearedReminders(host, device), []);
    assert.deepEqual(service.clearedReminders(otherHost, otherDevice), []);
  } finally { service.close(); }
});

test('a clear during an in-flight system send suppresses later endpoints without trying to recall the started request', async () => {
  let release, started, attempts = 0;
  const began = new Promise(resolve => started = resolve), blocked = new Promise(resolve => release = resolve);
  const service = new PushService(options({ sendNotification: async () => { attempts++; started(); await blocked; } }));
  try {
    service.subscribe(host, device, subscription('https://web.push.apple.com/one'));
    service.subscribe(host, device, subscription('https://web.push.apple.com/two'));
    const live = event(), pending = service.notify(host, live); await began;
    service.clearReminder(host, { ...live, reason: 'resolved' }); release();
    assert.deepEqual(await pending, { sent: 1, failed: 0 }); assert.equal(attempts, 1);
  } finally { release?.(); service.close(); }
});

test('push registration only permits official HTTPS push destinations and valid encryption keys', () => {
  for (const endpoint of ['https://fcm.googleapis.com/fcm/send/token', 'https://updates.push.services.mozilla.com/wpush/v2/token', 'https://web.push.apple.com/token']) assert.equal(validatePushSubscription(subscription(endpoint), now).endpoint, endpoint);
  for (const endpoint of ['http://web.push.apple.com/token', 'https://127.0.0.1/token', 'https://localhost/token', 'https://web.push.apple.com.attacker.test/token', 'https://web.push.apple.com@attacker.test/token', 'https://user@web.push.apple.com/token', 'https://web.push.apple.com:8443/token', 'https://web.push.apple.com/token#fragment', 'https://web.push.apple.com/']) assert.throws(() => validatePushSubscription(subscription(endpoint), now), /Invalid push subscription/);
  const invalidPoint = subscription(); invalidPoint.keys.p256dh = Buffer.alloc(65, 1).toString('base64url');
  assert.throws(() => validatePushSubscription(invalidPoint, now), /Invalid push subscription/);
  const invalidAuth = subscription(); invalidAuth.keys.auth += '=';
  assert.throws(() => validatePushSubscription(invalidAuth, now), /Invalid push subscription/);
  assert.throws(() => validatePushSubscription({ ...subscription(), expirationTime: now }, now), /Invalid push subscription/);
});

test('notifications and unsubscribe are scoped to the exact host and device', async () => {
  const deliveries = [];
  const service = new PushService(options({ sendNotification: async (sub, data, settings) => deliveries.push({ sub, data: JSON.parse(data), settings }) }));
  try {
    const a = subscription(), b = subscription('https://fcm.googleapis.com/fcm/send/other');
    service.subscribe(host, device, a); service.subscribe(otherHost, otherDevice, b);
    const notification = event();
    assert.deepEqual(await service.notify(host, notification), { sent: 1, failed: 0 });
    assert.equal(deliveries[0].sub.endpoint, a.endpoint);
    assert.equal(deliveries[0].data.hostId, host);
    assert.equal(deliveries[0].data.deviceId, device);
    assert.equal(deliveries[0].data.threadId, notification.threadId);
    assert.equal(deliveries[0].data.eventId, notification.eventId);
    assert.equal(deliveries[0].data.createdAt, notification.createdAt);
    assert.equal(deliveries[0].data.title, '任务已完成');
    assert.equal(deliveries[0].settings.timeout, 10000);
    service.unsubscribe(otherHost, otherDevice, a.endpoint);
    assert.equal(service.status(host, device).subscribed, true);
    service.unsubscribe(host, device, a.endpoint);
    assert.equal(service.status(host, device).subscribed, false);
    assert.equal(service.status(otherHost, otherDevice).subscribed, true);
  } finally { service.close(); }
});

test('subscription and claimed event persist across restart without replaying failures', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-push-'));
  const database = join(directory, 'push.sqlite');
  const failure = event();
  let attempts = 0, service;
  const config = options({ database, sendNotification: async () => { attempts++; throw Object.assign(new Error('upstream failed'), { statusCode: 503 }); } });
  try {
    service = new PushService(config);
    service.subscribe(host, device, subscription());
    assert.deepEqual(await service.notify(host, failure), { sent: 0, failed: 1 });
    service.close(); service = new PushService(config);
    assert.equal(service.status(host, device).subscribed, true);
    assert.deepEqual(await service.notify(host, failure), { sent: 0, skipped: 'duplicate' });
    assert.equal(attempts, 1);
    if (process.platform !== 'win32') assert.equal((await stat(database)).mode & 0o077, 0);
  } finally { service?.close(); await rm(directory, { recursive: true, force: true }); }
});

test('revoked devices cannot register, view status, or receive queued pushes', async () => {
  let active = true, attempts = 0;
  const service = new PushService(options({ isActiveDevice: (h, d) => active && h === host && d === device, sendNotification: async () => attempts++ }));
  try {
    assert.throws(() => service.subscribe(otherHost, device, subscription()), /Inactive push device/);
    service.subscribe(host, device, subscription()); active = false;
    assert.throws(() => service.status(host, device), /Inactive push device/);
    assert.deepEqual(await service.notify(host, event()), { sent: 0, failed: 0 });
    assert.equal(attempts, 0);
    active = true;
    assert.equal(service.status(host, device).subscribed, false);
  } finally { service.close(); }
});

test('an in-flight delivery does not prevent revocation from suppressing later endpoints', async () => {
  let release, started, active = true, count = 0;
  const began = new Promise(resolve => started = resolve);
  const blocked = new Promise(resolve => release = resolve);
  const service = new PushService(options({ isActiveDevice: () => active, sendNotification: async () => { count++; started(); await blocked; } }));
  try {
    service.subscribe(host, device, subscription('https://web.push.apple.com/one'));
    service.subscribe(host, device, subscription('https://web.push.apple.com/two'));
    const pending = service.notify(host, event()); await began;
    active = false; service.revokeDevice(host, device); release();
    await pending; assert.equal(count, 1);
  } finally { release?.(); service.close(); }
});

for (const change of ['unsubscribe', 'refresh']) test(`a queued endpoint ${change} during another delivery cannot send its stale snapshot`, async () => {
  let release, started;
  const began = new Promise(resolve => started = resolve), blocked = new Promise(resolve => release = resolve), attempts = [];
  const service = new PushService(options({ sendNotification: async sub => {
    attempts.push(sub);
    if (attempts.length === 1) { started(); await blocked; }
  } }));
  try {
    const subscriptions = [subscription('https://web.push.apple.com/one'), subscription('https://web.push.apple.com/two')];
    for (const sub of subscriptions) service.subscribe(host, device, sub);
    const live = event(), pending = service.notify(host, live); await began;
    // SQL scan order is unspecified: change the endpoint not yet dispatched.
    const queued = subscriptions.find(sub => sub.endpoint !== attempts[0].endpoint);
    const replacement = subscription(queued.endpoint);
    if (change === 'unsubscribe') service.unsubscribe(host, device, queued.endpoint);
    else service.subscribe(host, device, replacement);
    assert.equal(service.status(host, device, queued.endpoint).subscribed, change === 'refresh');
    release();
    assert.deepEqual(await pending, { sent: 1, failed: 0 });
    assert.equal(attempts.some(sub => sub.endpoint === queued.endpoint), false, 'the old endpoint revision was withdrawn before dispatch');
    assert.deepEqual(await service.notify(host, live), { sent: 0, skipped: 'duplicate' });
    const later = await service.notify(host, event());
    assert.equal(later.sent, change === 'refresh' ? 2 : 1);
    const targetAttempts = attempts.filter(sub => sub.endpoint === queued.endpoint);
    assert.equal(targetAttempts.length, change === 'refresh' ? 1 : 0);
    if (change === 'refresh') {
      assert.deepEqual(targetAttempts[0].keys, replacement.keys);
      assert.equal(service.status(host, device, queued.endpoint).subscribed, true, 'skipping the old snapshot must retain its replacement');
    }
  } finally { release?.(); service.close(); }
});

test('concurrent copies of one live event send exactly once; stale events never send', async () => {
  let count = 0;
  const service = new PushService(options({ sendNotification: async () => { count++; } }));
  try {
    service.subscribe(host, device, subscription());
    const copy = event();
    const results = await Promise.all([service.notify(host, copy), service.notify(host, copy), service.notify(host, copy)]);
    assert.equal(count, 1); assert.equal(results.filter(x => x.skipped === 'duplicate').length, 2);
    assert.deepEqual(await service.notify(host, event({ createdAt: now - 120001 })), { sent: 0, skipped: 'stale' });
    assert.deepEqual(await service.notify(host, event({ createdAt: now + 5001 })), { sent: 0, skipped: 'stale' });
    assert.equal(count, 1);
  } finally { service.close(); }
});

test('expired upstream subscriptions are removed while transient and redirect failures are not retried', async () => {
  for (const statusCode of [404, 410, 302, 429, 503]) {
    let count = 0;
    const service = new PushService(options({ sendNotification: async () => { count++; throw Object.assign(new Error('upstream'), { statusCode }); } }));
    try {
      service.subscribe(host, device, subscription());
      const failure = event();
      await service.notify(host, failure); await service.notify(host, failure);
      assert.equal(count, 1);
      assert.equal(service.status(host, device).subscribed, ![404, 410].includes(statusCode));
    } finally { service.close(); }
  }
});

test('a delayed 410 cannot erase a newly refreshed subscription', async () => {
  let release, started;
  const began = new Promise(resolve => started = resolve), blocked = new Promise(resolve => release = resolve);
  const service = new PushService(options({ sendNotification: async () => { started(); await blocked; throw Object.assign(new Error('expired'), { statusCode: 410 }); } }));
  try {
    const old = subscription(); service.subscribe(host, device, old);
    const pending = service.notify(host, event()); await began;
    service.subscribe(host, device, subscription(old.endpoint)); release(); await pending;
    assert.equal(service.status(host, device).subscribed, true);
  } finally { release?.(); service.close(); }
});

test('registration is bounded and refreshing an existing endpoint does not consume another slot', () => {
  const service = new PushService(options({ maxSubscriptions: 1 }));
  try {
    const sub = subscription(); service.subscribe(host, device, sub);
    service.subscribe(host, device, subscription(sub.endpoint));
    assert.throws(() => service.subscribe(host, device, subscription('https://web.push.apple.com/other')), /limit reached/);
    assert.equal(service.status(host, device, sub.endpoint).subscribed, true);
    service.close(); assert.throws(() => service.subscribe(host, device, sub), /Inactive push device/);
  } finally { service.close(); }
});

test('background monitor eligibility follows host scope, pairing status, expiration and unsubscribe', () => {
  let active = true, clock = now;
  const service = new PushService(options({ now: () => clock, isActiveDevice: () => active }));
  try {
    assert.equal(service.hasActiveSubscriptions(host), false);
    const sub = { ...subscription(), expirationTime: now + 1000 };
    service.subscribe(host, device, sub);
    assert.equal(service.hasActiveSubscriptions(host), true);
    assert.equal(service.hasActiveSubscriptions(otherHost), false);
    active = false; assert.equal(service.hasActiveSubscriptions(host), false);
    active = true; clock = now + 1000; assert.equal(service.hasActiveSubscriptions(host), false);
    clock = now; service.unsubscribe(host, device, sub.endpoint);
    assert.equal(service.hasActiveSubscriptions(host), false);
    service.close(); assert.equal(service.hasActiveSubscriptions(host), false);
  } finally { service.close(); }
});

test('all three notification kinds use generic content without leaking task text', async () => {
  const payloads = [];
  const service = new PushService(options({ sendNotification: async (_, payload) => payloads.push(JSON.parse(payload)) }));
  try {
    service.subscribe(host, device, subscription());
    for (const kind of ['completed', 'question', 'approval']) await service.notify(host, event({ kind, title: 'private project', text: 'private prompt' }));
    assert.deepEqual(payloads.map(x => x.title), ['任务已完成', '任务需要回答', '任务等待审批']);
    assert.ok(!JSON.stringify(payloads).includes('private'));
    await assert.rejects(service.notify(host, event({ kind: 'other' })), /Invalid push event/);
  } finally { service.close(); }
});

test('production sender encrypts and VAPID signs the payload and refuses redirects without making another request', async t => {
  const keys = await generateVapidKeys();
  const sender = createWebPushSender({ subject: 'mailto:push@example.test', ...keys });
  const requests = [];
  let statusCode = 201;
  t.mock.method(https, 'request', (settings, callback) => {
    const request = new EventEmitter();
    requests.push({ settings, chunks: [] });
    request.write = chunk => requests.at(-1).chunks.push(chunk);
    request.end = () => queueMicrotask(() => {
      const response = new EventEmitter(); response.statusCode = statusCode;
      response.headers = statusCode === 302 ? { location: 'https://127.0.0.1/private' } : {};
      callback(response); response.emit('end');
    });
    return request;
  });
  await sender(subscription(), 'private plaintext');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].settings.hostname, 'web.push.apple.com');
  assert.match(requests[0].settings.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.equal(requests[0].settings.headers['Content-Encoding'], 'aes128gcm');
  assert.equal(requests[0].settings.timeout, 10000);
  const encrypted = Buffer.concat(requests[0].chunks);
  assert.ok(encrypted.length > 50); assert.equal(encrypted.includes(Buffer.from('private plaintext')), false);
  statusCode = 302;
  await assert.rejects(sender(subscription(), 'test'), error => error.statusCode === 302);
  assert.equal(requests.length, 2);
  await assert.rejects(sender(subscription('https://localhost/private'), 'test'), /Invalid push subscription/);
  assert.equal(requests.length, 2);
});

test('foreground delivery is scoped, deduplicated per device and bypasses all system endpoints for that device', async () => {
  const foreground = [], system = [];
  const service = new PushService(options({
    deliverForeground: (hostId, deviceId, event) => { foreground.push({ hostId, deviceId, event }); return deviceId === device; },
    sendNotification: async sub => system.push(sub.endpoint),
  }));
  try {
    service.subscribe(host, device, subscription('https://web.push.apple.com/one'));
    service.subscribe(host, device, subscription('https://web.push.apple.com/two'));
    service.subscribe(otherHost, otherDevice, subscription('https://web.push.apple.com/other'));
    const live = event();
    assert.deepEqual(await service.notify(host, live), { sent: 0, failed: 0, foreground: 1 });
    assert.equal(foreground.length, 1); assert.equal(system.length, 0);
    assert.deepEqual(foreground[0], { hostId: host, deviceId: device, event: { eventId: live.eventId, threadId: live.threadId, kind: live.kind, createdAt: live.createdAt } });
    await service.notify(host, live); assert.equal(foreground.length, 1);
    await service.notify(otherHost, event()); assert.equal(system.length, 1);
  } finally { service.close(); }
});

test('failed foreground transport falls back to system push while revoked devices receive neither', async () => {
  let active = true, attempts = 0, foreground = 0;
  const service = new PushService(options({ isActiveDevice: () => active,
    deliverForeground: () => { foreground++; throw new Error('stream closed'); },
    sendNotification: async () => attempts++,
  }));
  try {
    service.subscribe(host, device, subscription());
    assert.deepEqual(await service.notify(host, event()), { sent: 1, failed: 0 });
    assert.equal(attempts, 1); assert.equal(foreground, 1);
    active = false; await service.notify(host, event());
    assert.equal(attempts, 1); assert.equal(foreground, 1);
  } finally { service.close(); }
});


test('asynchronous foreground acknowledgement waits for handling and false or rejection falls back', async () => {
  for (const result of [true, false, 'reject']) {
    let release, started, sends = 0;
    const began = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
    const service = new PushService(options({ deliverForeground: async () => { started(); await gate; if (result === 'reject') throw new Error('No ACK'); return result; }, sendNotification: async () => { sends++; } }));
    try {
      service.subscribe(host, device, subscription()); const pending = service.notify(host, event()); await began;
      assert.equal(sends, 0); release(); const delivered = await pending;
      assert.equal(sends, result === true ? 0 : 1); assert.equal(delivered.foreground ?? 0, result === true ? 1 : 0);
    } finally { release?.(); service.close(); }
  }
});

for (const change of ['unsubscribe', 'refresh', 'revoke', 'clear', 'close']) test(`foreground fallback rechecks ${change} after waiting for an ACK`, async () => {
  let release, started, sends = 0, active = true;
  const began = new Promise(resolve => started = resolve), gate = new Promise(resolve => release = resolve);
  const service = new PushService(options({ isActiveDevice: () => active, deliverForeground: async () => { started(); await gate; return false; }, sendNotification: async () => { sends++; } }));
  try {
    const sub = subscription(), live = event(); service.subscribe(host, device, sub);
    const pending = service.notify(host, live); await began;
    if (change === 'unsubscribe') service.unsubscribe(host, device, sub.endpoint);
    if (change === 'refresh') service.subscribe(host, device, subscription(sub.endpoint));
    if (change === 'revoke') { active = false; service.revokeDevice(host, device); }
    if (change === 'clear') service.clearReminder(host, { ...live, reason: 'resolved' });
    if (change === 'close') service.close();
    release(); await pending; assert.equal(sends, 0);
    if (change === 'refresh') assert.equal(service.status(host, device, sub.endpoint).subscribed, true);
  } finally { release?.(); service.close(); }
});
