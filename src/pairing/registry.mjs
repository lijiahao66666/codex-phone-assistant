import { DatabaseSync } from 'node:sqlite';
import { createHash, createHmac, randomBytes, randomInt, randomUUID } from 'node:crypto';
import { chmodSync } from 'node:fs';

const digest = value => createHash('sha256').update(value).digest('hex');
const credential = () => randomBytes(32).toString('base64url');
const codePattern = /^\d{6}$/;

// Authentication and rate limiting for transport endpoints are the caller's responsibility.
export class PairingRegistry {
  constructor(path, { now = Date.now, pairTtlMs = 120000, maxDevices = 16, maxHosts = 10000, unpairedTtlMs = 604800000 } = {}) {
    if (typeof path !== 'string' || !path || !Number.isSafeInteger(pairTtlMs) || pairTtlMs < 1000 || pairTtlMs > 120000 || !Number.isSafeInteger(maxDevices) || maxDevices < 1 || maxDevices > 100) throw new TypeError('Invalid registry configuration');
    this.now = now;
    this.pairTtlMs = pairTtlMs;
    this.maxDevices = maxDevices;
    if (!Number.isSafeInteger(maxHosts) || maxHosts < 1 || !Number.isSafeInteger(unpairedTtlMs) || unpairedTtlMs < 1000) throw new TypeError('Invalid host limits');
    this.maxHosts = maxHosts;
    this.codeKey = randomBytes(32);
    this.unpairedTtlMs = unpairedTtlMs;
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS hosts (id TEXT PRIMARY KEY, secret_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS pairs (code_hash TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE, expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS devices (id TEXT PRIMARY KEY, host_id TEXT NOT NULL REFERENCES hosts(id) ON DELETE CASCADE, token_hash TEXT NOT NULL UNIQUE, name TEXT NOT NULL, created INTEGER NOT NULL);`);
    if (!this.db.prepare('PRAGMA table_info(pairs)').all().some(column => column.name === 'qr_hash')) this.db.exec('ALTER TABLE pairs ADD COLUMN qr_hash TEXT');
    this.db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS pairs_qr_hash ON pairs(qr_hash);
      CREATE TABLE IF NOT EXISTS pair_requests (id TEXT PRIMARY KEY, claim_hash TEXT NOT NULL UNIQUE, code_hash TEXT NOT NULL REFERENCES pairs(code_hash) ON DELETE CASCADE, approved INTEGER NOT NULL DEFAULT 0);`);
    if (!this.db.prepare('PRAGMA table_info(hosts)').all().some(column => column.name === 'created')) this.db.exec('ALTER TABLE hosts ADD COLUMN created INTEGER');
    if (!this.db.prepare('PRAGMA table_info(hosts)').all().some(column => column.name === 'active_device_id')) {
      this.db.exec('ALTER TABLE hosts ADD COLUMN active_device_id TEXT');
    }
  }

  createHost(name) {
    if (typeof name !== 'string' || !name.trim() || name.length > 120) throw new TypeError('Invalid host name');
    const hostId = randomUUID(), secret = credential();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM hosts WHERE created IS NOT NULL AND created <= ? AND NOT EXISTS (SELECT 1 FROM devices WHERE devices.host_id = hosts.id)').run(this.now() - this.unpairedTtlMs);
      if (this.db.prepare('SELECT COUNT(*) AS n FROM hosts').get().n >= this.maxHosts) throw Object.assign(new Error('Host capacity reached'), { code: 'capacity' });
      this.db.prepare('INSERT INTO hosts (id, secret_hash, name, created) VALUES (?, ?, ?, ?)').run(hostId, digest(secret), name.trim(), this.now());
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { hostId, secret };
  }

  authenticateHost(secret) {
    if (typeof secret !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(secret)) return null;
    return this.db.prepare('SELECT id, name FROM hosts WHERE secret_hash = ?').get(digest(secret)) ?? null;
  }

  issueCode(hostSecret) {
    const host = this.authenticateHost(hostSecret);
    if (!host) throw new Error('Unauthorized');
    let code;
    const qrToken = credential();
    const expiresAt = this.now() + this.pairTtlMs;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM pairs WHERE host_id = ? OR expires <= ?').run(host.id, this.now());
      for (let i = 0; i < 100; i++) {
        const candidate = String(randomInt(1000000)).padStart(6, '0');
        if (!this.db.prepare('SELECT 1 FROM pairs WHERE code_hash = ?').get(this.#codeHash(candidate))) { code = candidate; break; }
      }
      if (!code) throw new Error('Pairing capacity reached');
      this.db.prepare('INSERT INTO pairs (code_hash, host_id, expires, qr_hash) VALUES (?, ?, ?, ?)').run(this.#codeHash(code), host.id, expiresAt, digest(qrToken));
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return { code, qrToken, expiresAt };
  }

  #codeHash(code) { return createHmac('sha256', this.codeKey).update(code).digest('hex'); }

  requestCode(code) {
    if (typeof code !== 'string' || !codePattern.test(code)) return null;
    const pair = this.db.prepare('SELECT code_hash, expires FROM pairs WHERE code_hash = ?').get(this.#codeHash(code));
    return this.#requestPair(pair);
  }

  redeemQr(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const pair = this.db.prepare('SELECT code_hash, host_id, expires FROM pairs WHERE qr_hash = ?').get(digest(token));
    if (!pair || pair.expires <= this.now()) return null;
    return this.#redeemPair(pair, '手机');
  }

  #requestPair(pair) {
    if (!pair || pair.expires <= this.now()) return null;
    if (this.db.prepare('SELECT COUNT(*) AS n FROM pair_requests WHERE code_hash = ?').get(pair.code_hash).n >= 3) return null;
    const requestId = randomUUID(), claimToken = credential();
    this.db.prepare('INSERT INTO pair_requests (id, claim_hash, code_hash) VALUES (?, ?, ?)').run(requestId, digest(claimToken), pair.code_hash);
    return { requestId, claimToken };
  }

  pendingRequests(hostSecret) {
    const host = this.authenticateHost(hostSecret);
    if (!host) throw new Error('Unauthorized');
    return this.db.prepare('SELECT r.id AS requestId FROM pair_requests r JOIN pairs p ON p.code_hash = r.code_hash WHERE p.host_id = ? AND p.expires > ? AND r.approved = 0').all(host.id, this.now());
  }

  approveRequest(hostSecret, requestId) {
    const host = this.authenticateHost(hostSecret);
    if (!host || typeof requestId !== 'string') return false;
    return this.db.prepare('UPDATE pair_requests SET approved = 1 WHERE id = ? AND approved = 0 AND code_hash IN (SELECT code_hash FROM pairs WHERE host_id = ? AND expires > ?)').run(requestId, host.id, this.now()).changes === 1;
  }

  rejectRequest(hostSecret, requestId) {
    const host = this.authenticateHost(hostSecret);
    if (!host || typeof requestId !== 'string') return false;
    return this.db.prepare('UPDATE pair_requests SET approved = -1 WHERE id = ? AND approved = 0 AND code_hash IN (SELECT code_hash FROM pairs WHERE host_id = ? AND expires > ?)').run(requestId, host.id, this.now()).changes === 1;
  }

  claimRequest(claimToken) {
    if (typeof claimToken !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(claimToken)) return null;
    const request = this.db.prepare('SELECT r.approved, p.code_hash, p.host_id, p.expires FROM pair_requests r JOIN pairs p ON p.code_hash = r.code_hash WHERE r.claim_hash = ?').get(digest(claimToken));
    if (!request || request.expires <= this.now()) return null;
    if (request.approved === 0) return { pending: true };
    if (request.approved !== 1) return { rejected: true };
    return this.#redeemPair(request, '手机');
  }

  #redeemPair(pair, name) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const current = this.db.prepare('SELECT host_id, expires FROM pairs WHERE code_hash = ?').get(pair.code_hash);
      if (!current || current.expires <= this.now() || current.host_id !== pair.host_id || this.db.prepare('SELECT COUNT(*) AS n FROM devices WHERE host_id = ?').get(pair.host_id).n >= this.maxDevices) { this.db.exec('COMMIT'); return null; }
      const deviceId = randomUUID(), token = credential();
      const previousDeviceId = this.db.prepare('SELECT active_device_id AS id FROM hosts WHERE id = ?').get(pair.host_id)?.id ?? null;
      this.db.prepare('DELETE FROM pairs WHERE code_hash = ?').run(pair.code_hash);
      this.db.prepare('INSERT INTO devices VALUES (?, ?, ?, ?, ?)').run(deviceId, pair.host_id, digest(token), name, this.now());
      this.db.prepare('UPDATE hosts SET active_device_id = ? WHERE id = ?').run(deviceId, pair.host_id);
      this.db.exec('COMMIT');
      return { deviceId, hostId: pair.host_id, token, previousDeviceId };
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }

  authenticateDevice(token) {
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    return this.db.prepare('SELECT devices.id AS deviceId, devices.host_id AS hostId, devices.name AS name, hosts.name AS hostName FROM devices JOIN hosts ON hosts.id = devices.host_id WHERE devices.token_hash = ?').get(digest(token)) ?? null;
  }

  isActiveDevice(hostId, deviceId) {
    return Boolean(this.db.prepare('SELECT 1 FROM hosts JOIN devices ON devices.host_id = hosts.id WHERE hosts.id = ? AND devices.id = ? AND devices.id = hosts.active_device_id').get(hostId, deviceId));
  }

  revokeDeviceId(deviceId) {
    this.db.prepare('UPDATE hosts SET active_device_id = NULL WHERE active_device_id = ?').run(deviceId);
    return this.db.prepare('DELETE FROM devices WHERE id = ?').run(deviceId).changes === 1;
  }

  listDevices(hostSecret) {
    const host = this.authenticateHost(hostSecret);
    if (!host) throw new Error('Unauthorized');
    return this.db.prepare('SELECT id AS deviceId, name, created FROM devices WHERE host_id = ? ORDER BY created, id').all(host.id);
  }

  revokeDevice(hostSecret, deviceId) {
    const host = this.authenticateHost(hostSecret);
    if (!host) throw new Error('Unauthorized');
    const found = this.db.prepare('SELECT 1 FROM devices WHERE host_id = ? AND id = ?').get(host.id, deviceId);
    return found ? this.revokeDeviceId(deviceId) : false;
  }

  revokeHost(hostSecret) {
    const host = this.authenticateHost(hostSecret);
    if (!host) return false;
    return this.db.prepare('DELETE FROM hosts WHERE id = ?').run(host.id).changes === 1;
  }

  close() { this.db.close(); }
}

export function pairingLink(origin, token) {
  const url = new URL(origin);
  if (url.protocol !== 'https:' || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw new TypeError('HTTPS origin required');
  const normalized = typeof token === 'string' ? token : '';
  if (!/^[A-Za-z0-9_-]{43}$/.test(normalized)) throw new TypeError('Invalid pairing token');
  url.pathname = '/pair';
  url.hash = new URLSearchParams({ token: normalized }).toString();
  return url.toString();
}
