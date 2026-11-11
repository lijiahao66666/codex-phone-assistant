import { DatabaseSync } from 'node:sqlite';
import { createHash, ECDH, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const pushHosts = new Set(['fcm.googleapis.com', 'updates.push.services.mozilla.com', 'web.push.apple.com']);
const kinds = new Set(['completed', 'question', 'approval']);
const titles = { completed: '任务已完成', question: '任务需要回答', approval: '任务等待审批' };
const clearRetentionMs = 7 * 86400000;
const maxClearedReminders = 1024;
const hash = value => createHash('sha256').update(value).digest('hex');
const validPair = (hostId, deviceId) => uuid.test(hostId ?? '') && uuid.test(deviceId ?? '');
const invalid = () => { throw new TypeError('Invalid push subscription'); };

function key(value, size) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]+$/.test(value)) invalid();
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.length !== size || bytes.toString('base64url') !== value) invalid();
  return bytes;
}

// A phone may only select the official browser push services. No user supplied
// hostname, port or redirect can turn subscription registration into an SSRF.
export function validatePushSubscription(value, now = Date.now()) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.endpoint !== 'string' || value.endpoint.length > 4096) invalid();
  let endpoint;
  try { endpoint = new URL(value.endpoint); } catch { invalid(); }
  if (endpoint.protocol !== 'https:' || !pushHosts.has(endpoint.hostname) || endpoint.port || endpoint.username || endpoint.password || endpoint.hash || endpoint.pathname === '/' || endpoint.href !== value.endpoint) invalid();
  if (!value.keys || typeof value.keys !== 'object') invalid();
  const publicKey = key(value.keys.p256dh, 65);
  key(value.keys.auth, 16);
  try { ECDH.convertKey(publicKey, 'prime256v1', undefined, undefined, 'uncompressed'); } catch { invalid(); }
  if (value.expirationTime != null && (!Number.isSafeInteger(value.expirationTime) || value.expirationTime <= now)) invalid();
  return { endpoint: endpoint.href, expirationTime: value.expirationTime ?? null, keys: { p256dh: value.keys.p256dh, auth: value.keys.auth } };
}

// web-push uses https.request and does not follow HTTP redirects. Keep the
// maintained package responsible for RFC 8291 encryption and VAPID signing.
export function createWebPushSender(vapidDetails) {
  if (!vapidDetails || typeof vapidDetails.subject !== 'string' || !/^(mailto:|https:\/\/)/.test(vapidDetails.subject)) throw new TypeError('VAPID subject required');
  key(vapidDetails.publicKey, 65);
  key(vapidDetails.privateKey, 32);
  const vapid = { subject: vapidDetails.subject, publicKey: vapidDetails.publicKey, privateKey: vapidDetails.privateKey };
  return async (subscription, payload, options) => {
    const normalized = validatePushSubscription(subscription);
    const { default: webPush } = await import('web-push');
    return webPush.sendNotification(normalized, payload, { TTL: options?.TTL ?? 120, urgency: options?.urgency ?? 'normal', timeout: options?.timeout ?? 10000, vapidDetails: vapid });
  };
}

export async function generateVapidKeys() {
  const { default: webPush } = await import('web-push');
  return webPush.generateVAPIDKeys();
}

export class PushService {
  constructor({ database = ':memory:', isActiveDevice, vapidDetails, sendNotification, deliverForeground = () => false, now = Date.now, maxAgeMs = 120000, maxSubscriptions = 4, maxInFlight = 32 } = {}) {
    if (typeof isActiveDevice !== 'function' || typeof database !== 'string' || !database || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1000 || maxAgeMs > 300000 || !Number.isSafeInteger(maxSubscriptions) || maxSubscriptions < 1 || maxSubscriptions > 8 || !Number.isSafeInteger(maxInFlight) || maxInFlight < 1 || maxInFlight > 128) throw new TypeError('Invalid push service configuration');
    this.now = now;
    this.isActiveDevice = isActiveDevice;
    this.sendNotification = sendNotification ?? createWebPushSender(vapidDetails);
    if (typeof deliverForeground !== 'function') throw new TypeError('Invalid foreground delivery');
    this.deliverForeground = deliverForeground;
    this.publicKey = vapidDetails?.publicKey ?? null;
    this.maxAgeMs = maxAgeMs;
    this.maxSubscriptions = maxSubscriptions;
    this.maxInFlight = maxInFlight;
    this.inFlight = 0;
    this.closed = false;
    this.db = new DatabaseSync(database);
    if (database !== ':memory:') chmodSync(database, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        host_id TEXT NOT NULL, device_id TEXT NOT NULL, endpoint_hash TEXT NOT NULL,
        subscription TEXT NOT NULL, revision TEXT NOT NULL,
        PRIMARY KEY (host_id, device_id, endpoint_hash)
      );
      CREATE TABLE IF NOT EXISTS push_events (
        host_id TEXT NOT NULL, event_hash TEXT NOT NULL, seen_at INTEGER NOT NULL,
        PRIMARY KEY (host_id, event_hash)
      );
      CREATE INDEX IF NOT EXISTS push_events_seen ON push_events(seen_at);
      CREATE TABLE IF NOT EXISTS push_reminder_clears (
        host_id TEXT NOT NULL, thread_id TEXT NOT NULL, event_id TEXT NOT NULL, cleared_at INTEGER NOT NULL,
        PRIMARY KEY (host_id, thread_id, event_id)
      );
      CREATE INDEX IF NOT EXISTS push_reminder_clears_age ON push_reminder_clears(cleared_at);
    `);
  }

  subscribe(hostId, deviceId, value) {
    this.#assertPair(hostId, deviceId);
    const subscription = validatePushSubscription(value, this.now()), endpointHash = hash(subscription.endpoint);
    const existing = this.db.prepare('SELECT 1 FROM push_subscriptions WHERE host_id = ? AND device_id = ? AND endpoint_hash = ?').get(hostId, deviceId, endpointHash);
    if (!existing && this.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE host_id = ? AND device_id = ?').get(hostId, deviceId).count >= this.maxSubscriptions) throw Object.assign(new Error('Push subscription limit reached'), { code: 'capacity' });
    this.db.prepare(`INSERT INTO push_subscriptions (host_id, device_id, endpoint_hash, subscription, revision) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(host_id, device_id, endpoint_hash) DO UPDATE SET subscription=excluded.subscription, revision=excluded.revision`).run(hostId, deviceId, endpointHash, JSON.stringify(subscription), randomUUID());
    return { subscribed: true };
  }

  status(hostId, deviceId, endpoint) {
    this.#assertPair(hostId, deviceId);
    const subscribed = typeof endpoint === 'string'
      ? Boolean(this.db.prepare('SELECT 1 FROM push_subscriptions WHERE host_id = ? AND device_id = ? AND endpoint_hash = ?').get(hostId, deviceId, hash(endpoint)))
      : this.db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE host_id = ? AND device_id = ?').get(hostId, deviceId).count > 0;
    return { subscribed, publicKey: this.publicKey };
  }

  hasActiveSubscriptions(hostId) {
    if (this.closed || !uuid.test(hostId ?? '')) return false;
    const now = this.now();
    return this.db.prepare('SELECT device_id, subscription FROM push_subscriptions WHERE host_id = ?').all(hostId).some(row => {
      if (!this.isActiveDevice(hostId, row.device_id)) return false;
      const { expirationTime } = JSON.parse(row.subscription);
      return expirationTime == null || expirationTime > now;
    });
  }

  unsubscribe(hostId, deviceId, endpoint) {
    this.#assertPair(hostId, deviceId);
    if (typeof endpoint !== 'string' || endpoint.length > 4096) throw new TypeError('Push endpoint required');
    this.db.prepare('DELETE FROM push_subscriptions WHERE host_id = ? AND device_id = ? AND endpoint_hash = ?').run(hostId, deviceId, hash(endpoint));
    return { subscribed: false };
  }

  revokeDevice(hostId, deviceId) {
    if (this.closed || !validPair(hostId, deviceId)) return;
    this.db.prepare('DELETE FROM push_subscriptions WHERE host_id = ? AND device_id = ?').run(hostId, deviceId);
  }

  clearReminder(hostId, event) {
    if (this.closed) return null;
    if (!uuid.test(hostId ?? '') || !event || !uuid.test(event.threadId ?? '') || typeof event.eventId !== 'string' || !event.eventId.length || event.eventId.length > 512 || !['resolved', 'desktop-read'].includes(event.reason) || !Number.isSafeInteger(event.createdAt)) throw new TypeError('Invalid reminder clear');
    const now = this.now();
    if (event.createdAt <= now - clearRetentionMs || event.createdAt > now + 5000) return null;
    this.#pruneClears(now);
    this.db.prepare(`INSERT INTO push_reminder_clears (host_id, thread_id, event_id, cleared_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(host_id, thread_id, event_id) DO UPDATE SET cleared_at=MAX(cleared_at, excluded.cleared_at)`).run(hostId, event.threadId, event.eventId, event.createdAt);
    this.db.prepare('DELETE FROM push_reminder_clears WHERE host_id = ? AND rowid NOT IN (SELECT rowid FROM push_reminder_clears WHERE host_id = ? ORDER BY cleared_at DESC, rowid DESC LIMIT ?)').run(hostId, hostId, maxClearedReminders);
    return { threadId: event.threadId, eventId: event.eventId };
  }

  clearedReminders(hostId, deviceId) {
    this.#assertPair(hostId, deviceId);
    this.#pruneClears(this.now());
    return this.db.prepare('SELECT thread_id AS threadId, event_id AS eventId FROM push_reminder_clears WHERE host_id = ? ORDER BY cleared_at DESC, rowid DESC LIMIT ?').all(hostId, maxClearedReminders);
  }

  // Caller authenticates the desktop and supplies events with stable IDs from
  // live transitions. Initial snapshots/reconnected history must not call this.
  // A delivery is claimed before I/O; a failure is intentionally not replayed.
  async notify(hostId, event) {
    if (this.closed) return { sent: 0, skipped: 'closed' };
    const now = this.now();
    if (!uuid.test(hostId ?? '') || !event || typeof event.eventId !== 'string' || !event.eventId.length || event.eventId.length > 512 || !uuid.test(event.threadId ?? '') || !kinds.has(event.kind) || !Number.isSafeInteger(event.createdAt)) throw new TypeError('Invalid push event');
    if (event.createdAt < now - this.maxAgeMs || event.createdAt > now + 5000) return { sent: 0, skipped: 'stale' };
    this.#pruneClears(now);
    if (this.#isCleared(hostId, event)) return { sent: 0, skipped: 'cleared' };
    this.db.prepare('DELETE FROM push_events WHERE seen_at < ?').run(now - 86400000);
    const claimed = this.db.prepare('INSERT OR IGNORE INTO push_events (host_id, event_hash, seen_at) VALUES (?, ?, ?)').run(hostId, hash(event.eventId), now);
    if (!claimed.changes) return { sent: 0, skipped: 'duplicate' };
    if (this.inFlight >= this.maxInFlight) return { sent: 0, skipped: 'busy' };
    this.inFlight++;
    let sent = 0, failed = 0, foreground = 0;
    const foregroundDevices = new Set(), checkedDevices = new Set();
    try {
      const subscriptions = this.db.prepare('SELECT * FROM push_subscriptions WHERE host_id = ?').all(hostId);
      for (const row of subscriptions) {
        if (this.closed) break;
        if (this.#isCleared(hostId, event)) break;
        if (!this.isActiveDevice(hostId, row.device_id)) { this.revokeDevice(hostId, row.device_id); continue; }
        const subscription = JSON.parse(row.subscription);
        if (subscription.expirationTime != null && subscription.expirationTime <= now) { this.#removeRevision(row); continue; }
        if (!checkedDevices.has(row.device_id)) {
          checkedDevices.add(row.device_id);
          try {
            if (this.deliverForeground(hostId, row.device_id, { eventId: event.eventId, threadId: event.threadId, kind: event.kind }) === true) {
              foregroundDevices.add(row.device_id); foreground++;
            }
          } catch { /* A failed foreground transport falls back to system push. */ }
        }
        if (foregroundDevices.has(row.device_id)) continue;
        const payload = JSON.stringify({ title: titles[event.kind], body: '打开手机助手查看任务。', eventId: event.eventId, createdAt: event.createdAt, kind: event.kind, hostId, deviceId: row.device_id, threadId: event.threadId, tag: 'codex-' + hash(hostId + ':' + event.eventId).slice(0, 32) });
        try {
          await this.sendNotification(subscription, payload, { TTL: 120, urgency: 'normal', timeout: 10000 });
          sent++;
        } catch (error) {
          failed++;
          if (!this.closed && [404, 410].includes(error?.statusCode)) this.#removeRevision(row);
        }
      }
      return { sent, failed, ...(foreground ? { foreground } : {}) };
    } finally { this.inFlight--; }
  }

  #removeRevision(row) {
    this.db.prepare('DELETE FROM push_subscriptions WHERE host_id = ? AND device_id = ? AND endpoint_hash = ? AND revision = ?').run(row.host_id, row.device_id, row.endpoint_hash, row.revision);
  }

  #pruneClears(now) {
    this.db.prepare('DELETE FROM push_reminder_clears WHERE cleared_at <= ?').run(now - clearRetentionMs);
  }

  #isCleared(hostId, event) {
    return Boolean(this.db.prepare('SELECT 1 FROM push_reminder_clears WHERE host_id = ? AND thread_id = ? AND event_id = ?').get(hostId, event.threadId, event.eventId));
  }

  #assertPair(hostId, deviceId) {
    if (this.closed || !validPair(hostId, deviceId) || !this.isActiveDevice(hostId, deviceId)) throw Object.assign(new Error('Inactive push device'), { code: 'unauthorized' });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.db.close();
  }
}
