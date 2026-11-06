import { randomUUID, createHash } from 'node:crypto';
import { PassThrough } from 'node:stream';
import { once } from 'node:events';
import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { validateImageFile } from './image-validator.mjs';

async function digestFile(file) {
  const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
  let offset = 0;
  for (;;) {
    const { bytesRead } = await file.read(buffer, 0, buffer.length, offset);
    if (!bytesRead) return hash.digest('hex');
    hash.update(buffer.subarray(0, bytesRead)); offset += bytesRead;
  }
}

// This transport-neutral receiver owns only staged uploads, never Codex writes.
export class ChunkUploads {
  #entries = new Map();
  #pending = new Set();
  constructor(store, { maxBytes = 20 * 1024 * 1024, maxChunk = 256 * 1024, maxUploads = 8, timeoutMs = 30000, maxDurationMs = 120000, helperPath, validator = file => validateImageFile(file, { helperPath }) } = {}) {
    if (!store || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(maxChunk) || maxChunk < 1 ||
        !Number.isSafeInteger(maxUploads) || maxUploads < 1 || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 ||
        !Number.isSafeInteger(maxDurationMs) || maxDurationMs < 1) throw new TypeError('Invalid upload limits');
    if (typeof validator !== 'function') throw new TypeError('Invalid image validator');
    Object.assign(this, { store, maxBytes, maxChunk, maxUploads, timeoutMs, maxDurationMs, validator });
  }
  start({ hostId, deviceId, threadId, name, size, kind = 'image' }) {
    if (![hostId, deviceId, threadId, name].every(v => typeof v === 'string' && v.length > 0) ||
        !['image', 'file'].includes(kind) || !Number.isSafeInteger(size) || size < 1 || size > this.maxBytes || this.#entries.size >= this.maxUploads) throw new Error('Invalid upload');
    const id = randomUUID(), stream = new PassThrough({ highWaterMark: this.maxChunk });
    stream.on('error', () => {});
    const entry = { id, hostId, deviceId, threadId, kind, size, bytes: 0, seq: 0, stream, busy: false };
    entry.done = this.store.put({ hostId, deviceId, threadId, name, kind, chunks: stream });
    this.#pending.add(entry.done);
    void entry.done.finally(() => this.#pending.delete(entry.done)).catch(() => {});
    entry.done.catch(() => {});
    this.#entries.set(id, entry);
    this.#progress(entry);
    // Progress renews the idle timer, but cannot keep a transfer alive indefinitely.
    entry.deadline = setTimeout(() => this.#cancel(entry), this.maxDurationMs);
    return id;
  }
  #progress(e) {
    if (e.cancelled || this.#entries.get(e.id) !== e) return;
    clearTimeout(e.timer);
    e.timer = setTimeout(() => this.#cancel(e), this.timeoutMs);
  }
  #clearTimers(e) { clearTimeout(e.timer); clearTimeout(e.deadline); }
  #get(id, scope) {
    const e = this.#entries.get(id);
    if (!e || e.hostId !== scope.hostId || e.deviceId !== scope.deviceId || e.threadId !== scope.threadId) throw new Error('Upload unavailable');
    return e;
  }
  #cancel(e) {
    if (!this.#entries.delete(e.id)) return;
    e.cancelled = true;
    this.#clearTimers(e);
    e.stream.destroy(new Error('Upload cancelled'));
  }
  async chunk(id, scope, seq, bytes) {
    const e = this.#get(id, scope);
    if (e.busy || seq !== e.seq || !Buffer.isBuffer(bytes) || !bytes.length || bytes.length > this.maxChunk || e.bytes + bytes.length > e.size) {
      this.#cancel(e); throw new Error('Invalid upload chunk');
    }
    e.busy = true;
    try {
      e.seq++; e.bytes += bytes.length;
      if (!e.stream.write(bytes)) await once(e.stream, 'drain');
      if (e.cancelled || this.#entries.get(id) !== e) throw new Error('Upload cancelled');
      this.#progress(e);
    } catch (error) { this.#cancel(e); throw error; }
    finally { e.busy = false; }
  }
  async finish(id, scope) {
    const e = this.#get(id, scope);
    if (e.finishing) throw new Error('Upload already finishing');
    if (e.busy || e.bytes !== e.size) { this.#cancel(e); throw new Error('Incomplete upload'); }
    e.finishing = true;
    e.stream.end();
    let saved;
    try {
      saved = await e.done;
      if (e.cancelled) throw new Error('Upload cancelled');
      const staged = this.store.resolve({ id: saved.id, ...scope });
      if (!staged) throw new Error('Upload unavailable');
      const file = await open(staged.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      try {
        const before = await file.stat();
        if (!before.isFile() || before.size !== staged.size) throw new Error('Image changed');
        const digest = await digestFile(file);
        if (e.kind === 'image') await this.validator(file);
        const after = await file.stat(), pathInfo = await lstat(staged.path);
        if (!pathInfo.isFile() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
            before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs ||
            after.dev !== pathInfo.dev || after.ino !== pathInfo.ino || digest !== await digestFile(file)) throw new Error('Image changed');
        if (!this.store.seal({ id: saved.id, ...scope }, { dev: after.dev, ino: after.ino, size: after.size, mtimeMs: after.mtimeMs, ctimeMs: after.ctimeMs, digest })) throw new Error('Upload unavailable');
      } finally { await file.close(); }
      if (e.cancelled) throw new Error('Upload cancelled');
      this.#entries.delete(id); this.#clearTimers(e);
      return saved;
    } catch (error) {
      this.#entries.delete(id); this.#clearTimers(e);
      if (saved) await this.store.remove({ id: saved.id, ...scope });
      throw error;
    }
  }
  async cancel(id, scope) { const e = this.#get(id, scope); this.#cancel(e); await e.done.catch(() => {}); }
  async close() { const entries = [...this.#entries.values()]; for (const e of entries) this.#cancel(e); await Promise.all([...this.#pending].map(p => p.catch(() => {}))); }
}
