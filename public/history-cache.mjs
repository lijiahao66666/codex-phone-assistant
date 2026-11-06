// Isolated prototype; the caller supplies authenticated, versioned page responses.
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const digest = /^[a-f0-9]{64}$/i;
import { canonicalJson, readonlyPage } from './history-projection.mjs';
export { canonicalJson, readonlyPage, pageHash } from './history-projection.mjs';
const scopeKey = ({ hostId, deviceId, threadId, cursor }) => JSON.stringify([hostId, deviceId, threadId, cursor]);
const ownerKey = ({ hostId, deviceId }) => JSON.stringify([hostId, deviceId]);
const validScope = scope => scope && [scope.hostId, scope.deviceId, scope.threadId].every(id => typeof id === 'string' && uuid.test(id)) && typeof scope.cursor === 'string' && scope.cursor.length <= 1024;
const containsMedia = page => page?.turns?.some(turn => turn.items?.some(item => item?.type === 'imageView' || item?.type === 'imageGeneration' || item?.imageCount > 0 || item?.images?.length || item?.videos?.length));
async function checksum(text) {
  const bytes = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}
export class HistoryPageCache {
  constructor(store, { now = Date.now, maxBytes = 32 * 1024 * 1024, maxEntries = 60, ttl = 7 * 86400000, channel = null } = {}) {
    this.store = store; this.now = now; this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.ttl = ttl; this.generation = 0;
    this.channel = channel; this.onInvalidate = event => { if (event.data?.type === 'invalidate') this.generation++; };
    channel?.addEventListener('message', this.onInvalidate);
  }
  invalidate() { this.generation++; this.channel?.postMessage({ type: 'invalidate' }); }
  close() { this.channel?.removeEventListener('message', this.onInvalidate); this.channel?.close(); }
  async put(scope, historicalHash, expectedPageHash, page) {
    const generation = this.generation;
    if (!validScope(scope) || !digest.test(historicalHash) || !digest.test(expectedPageHash)) throw new Error('invalid identity or version');
    if (containsMedia(page)) { await this.store.delete(scopeKey(scope)); return false; }
    const epoch = await this.store.epoch(ownerKey(scope));
    const data = readonlyPage(page), text = canonicalJson(data), bytes = new TextEncoder().encode(text).length;
    if (await checksum(text) !== expectedPageHash) throw new Error('page hash mismatch');
    if (generation !== this.generation) return false;
    if (bytes > this.maxBytes) return false;
    const timestamp = this.now(), key = scopeKey(scope);
    const entry = { key, scope: { ...scope }, historicalHash, pageHash: expectedPageHash, text, bytes, created: timestamp, used: timestamp };
    try {
      if (!await this.store.putIfEpoch(entry, ownerKey(scope), epoch)) return false;
    } catch (error) {
      if (error?.name !== 'QuotaExceededError') throw error;
      await this.prune(true);
      if (generation !== this.generation || !await this.store.putIfEpoch(entry, ownerKey(scope), epoch)) return false;
    }
    await this.prune(); return true;
  }
  async get(scope, verify, { historicalHash } = {}) {
    if (!validScope(scope) || typeof verify !== 'function') return null;
    const generation = this.generation, key = scopeKey(scope), epoch = await this.store.epoch(ownerKey(scope)), entry = await this.store.get(key);
    if (!entry) return null;
    if (this.now() - entry.created >= this.ttl) { await this.store.delete(key); return null; }
    let checked;
    try { checked = await verify({ ...scope, historicalHash: entry.historicalHash, pageHash: entry.pageHash }); } catch { return null; }
    if (generation !== this.generation || await this.store.epoch(ownerKey(scope)) !== epoch) return null;
    const expectedHistory = historicalHash ?? entry.historicalHash;
    if (!checked?.authorized || checked.historicalHash !== expectedHistory || checked.pageHash !== entry.pageHash) { if (checked?.authorized === false || (checked?.authorized === true && (checked.historicalHash !== expectedHistory || checked.pageHash !== entry.pageHash))) await this.store.delete(key); return null; }
    const latest = await this.store.get(key);
    if (generation !== this.generation || !latest || latest.historicalHash !== entry.historicalHash || latest.pageHash !== entry.pageHash || latest.text !== entry.text) return null;
    try {
      if (await checksum(latest.text) !== latest.pageHash) { await this.store.delete(key); return null; }
      if (generation !== this.generation) return null;
      const page = readonlyPage(JSON.parse(latest.text));
      if (containsMedia(page)) { await this.store.delete(key); return null; }
      latest.used = this.now(); if (!await this.store.putIfEpoch(latest, ownerKey(scope), epoch)) return null;
      if (generation !== this.generation || await this.store.epoch(ownerKey(scope)) !== epoch) return null;
      return { page, historicalHash: checked.historicalHash, pageHash: latest.pageHash, metadata: checked.metadata, readonly: true };
    } catch { await this.store.delete(key); return null; }
  }
  async clearDevice(hostId, deviceId) {
    this.invalidate();
    await this.store.clearOwner(ownerKey({ hostId, deviceId }), hostId, deviceId);
  }
  async prune(emergency = false) {
    const entries = (await this.store.list()).sort((a, b) => (a.used || 0) - (b.used || 0));
    let total = entries.reduce((sum, e) => sum + e.bytes, 0), count = entries.length, remove = emergency ? Math.max(1, Math.ceil(entries.length / 2)) : 0;
    for (const entry of entries) if (this.now() - entry.created >= this.ttl || total > this.maxBytes || count > this.maxEntries || remove > 0) {
      await this.store.delete(entry.key); total -= entry.bytes; count--;
      if (remove > 0) remove--;
    }
  }
}

export function openIndexedHistoryCache(indexedDB) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('codex-phone-history', 2);
    request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('pages')) request.result.createObjectStore('pages', { keyPath: 'key' }); if (!request.result.objectStoreNames.contains('epochs')) request.result.createObjectStore('epochs'); };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => db.close();
      const run = (mode, operation) => new Promise((done, fail) => {
        const tx = db.transaction('pages', mode), result = operation(tx.objectStore('pages'));
        tx.oncomplete = () => done(result.result); tx.onerror = tx.onabort = () => fail(tx.error || result.error);
      });
      const epoch = key => new Promise((done, fail) => {
        const tx = db.transaction('epochs', 'readonly'), req = tx.objectStore('epochs').get(key);
        tx.oncomplete = () => done(req.result || 0); tx.onerror = tx.onabort = () => fail(tx.error);
      });
      const putIfEpoch = (value, owner, expected) => new Promise((done, fail) => {
        const tx = db.transaction(['pages', 'epochs'], 'readwrite'), req = tx.objectStore('epochs').get(owner); let written = false;
        req.onsuccess = () => { if ((req.result || 0) === expected) { tx.objectStore('pages').put(value); written = true; } };
        tx.oncomplete = () => done(written); tx.onerror = tx.onabort = () => fail(tx.error);
      });
      const clearOwner = (owner, host, device) => new Promise((done, fail) => {
        const tx = db.transaction(['pages', 'epochs'], 'readwrite'), epochs = tx.objectStore('epochs'), req = epochs.get(owner), cursor = tx.objectStore('pages').openCursor();
        req.onsuccess = () => epochs.put((req.result || 0) + 1, owner);
        cursor.onsuccess = () => { const row = cursor.result; if (!row) return; if (row.value.scope?.hostId === host && row.value.scope?.deviceId === device) row.delete(); row.continue(); };
        tx.oncomplete = () => done(); tx.onerror = tx.onabort = () => fail(tx.error);
      });
      resolve({ get: key => run('readonly', s => s.get(key)), put: value => run('readwrite', s => s.put(value)), delete: key => run('readwrite', s => s.delete(key)), list: () => run('readonly', s => s.getAll()), epoch, putIfEpoch, clearOwner, close: () => db.close() });
    };
  });
}
