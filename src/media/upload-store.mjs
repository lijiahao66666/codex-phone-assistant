import { createHash, randomUUID } from 'node:crypto';
import { constants, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

// Files are private to this process and never addressed by a user-supplied path.
export class UploadStore {
  static async create({ root, maxBytes = 20 * 1024 * 1024, maxFiles = 20, stagedTtlMs = 300000 } = {}) {
    if (!isAbsolute(root ?? '') || !Number.isSafeInteger(maxBytes) || maxBytes < 1 ||
        !Number.isSafeInteger(maxFiles) || maxFiles < 1 || !Number.isSafeInteger(stagedTtlMs) || stagedTtlMs < 1) throw new TypeError('Invalid upload configuration');
    const directory = await mkdtemp(join(root, 'codex-phone-upload-'));
    return new UploadStore(directory, maxBytes, maxFiles, stagedTtlMs);
  }

  #files = new Map();
  #pending = new Set();
  #closed = false;
  #retained = false;
  constructor(directory, maxBytes, maxFiles, stagedTtlMs) {
    this.directory = directory;
    this.maxBytes = maxBytes;
    this.maxFiles = maxFiles;
    this.stagedTtlMs = stagedTtlMs;
  }

  async put({ hostId, deviceId, threadId, name, kind = 'image', chunks }) {
    if (this.#closed) throw new Error('Upload store closed');
    if (typeof hostId !== 'string' || !hostId || typeof deviceId !== 'string' || !deviceId || typeof threadId !== 'string' || !threadId ||
        typeof name !== 'string' || !name || name.length > 255 || /[\x00-\x1f\x7f/\\\u2028\u2029]/.test(name) || !['image', 'file'].includes(kind) ||
        !chunks || typeof chunks[Symbol.asyncIterator] !== 'function') throw new TypeError('Invalid upload');
    if (this.#files.size + this.#pending.size >= this.maxFiles) throw new Error('Upload capacity reached');
    const suffix = /\.([a-zA-Z0-9]{1,10})$/.exec(name)?.[1];
    const id = randomUUID(), path = join(this.directory, suffix ? `${id}.${suffix.toLowerCase()}` : id);
    this.#pending.add(id);
    let file, size = 0;
    try {
      file = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
      for await (const part of chunks) {
        if (this.#closed) throw new Error('Upload store closed');
        if (!Buffer.isBuffer(part) && !(part instanceof Uint8Array)) throw new TypeError('Invalid upload chunk');
        size += part.byteLength;
        if (size > this.maxBytes) throw new Error('Upload too large');
        await file.writeFile(part);
      }
      if (size === 0) throw new Error('Empty upload');
      await file.close(); file = null;
      if (this.#closed) throw new Error('Upload store closed');
      const entry = { hostId, deviceId, threadId, name, kind, path, size, claimed: false };
      entry.timer = setTimeout(() => { void this.remove({ id, hostId, deviceId, threadId }).catch(() => {}); }, this.stagedTtlMs);
      entry.timer.unref();
      this.#files.set(id, entry);
      return { id, name, size };
    } catch (error) {
      await file?.close().catch(() => {});
      await rm(path, { force: true });
      throw error;
    } finally {
      this.#pending.delete(id);
      if (this.#closed && !this.#retained && !this.#pending.size) await rm(this.directory, { recursive: true, force: true });
    }
  }

  resolve({ id, hostId, deviceId, threadId }) {
    const file = this.#files.get(id);
    if (this.#closed || !file || file.hostId !== hostId || file.deviceId !== deviceId || file.threadId !== threadId || file.claimed) return null;
    return { path: file.path, name: file.name, kind: file.kind, size: file.size };
  }

  seal(scope, expected) {
    const file = this.#files.get(scope.id);
    if (!this.resolve(scope) || !expected || typeof expected.digest !== 'string') return false;
    file.seal = expected;
    return true;
  }

  // Claim is irreversible: a timed-out write may still have reached Codex.
  claim({ id, hostId, deviceId, threadId }) {
    const resolved = this.resolve({ id, hostId, deviceId, threadId });
    if (!resolved) return null;
    const entry = this.#files.get(id);
    if (entry.seal) {
      let fd;
      try {
        fd = openSync(entry.path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        const before = fstatSync(fd), expected = entry.seal;
        if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino ||
            before.size !== expected.size || before.mtimeMs !== expected.mtimeMs || before.ctimeMs !== expected.ctimeMs) return null;
        const hash = createHash('sha256'), buffer = Buffer.alloc(65536);
        let offset = 0, count;
        while ((count = readSync(fd, buffer, 0, buffer.length, offset)) > 0) { hash.update(buffer.subarray(0, count)); offset += count; }
        const after = fstatSync(fd);
        if (offset !== expected.size || hash.digest('hex') !== expected.digest || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) return null;
      } catch { return null; }
      finally { if (fd !== undefined) closeSync(fd); }
    }
    entry.claimed = true;
    clearTimeout(entry.timer);
    return resolved;
  }

  async remove({ id, hostId, deviceId, threadId }) {
    const file = this.#files.get(id);
    if (!file || file.hostId !== hostId || file.deviceId !== deviceId || file.threadId !== threadId || file.claimed) return false;
    this.#files.delete(id);
    clearTimeout(file.timer);
    await rm(file.path, { force: true });
    return true;
  }

  async discardRejected({ id, hostId, deviceId, threadId }) {
    const file = this.#files.get(id);
    if (!file?.claimed || file.hostId !== hostId || file.deviceId !== deviceId || file.threadId !== threadId) return false;
    this.#files.delete(id);
    if (this.#closed) this.#retained = this.#files.size > 0;
    await rm(file.path, { force: true });
    if (this.#closed && !this.#retained && !this.#pending.size) await rm(this.directory, { recursive: true, force: true });
    return true;
  }

  async close() {
    if (this.#closed) return;
    this.#closed = true;
    const unclaimed = [];
    for (const file of this.#files.values()) clearTimeout(file.timer);
    for (const [id, file] of this.#files) if (!file.claimed) { this.#files.delete(id); unclaimed.push(file); }
    this.#retained = this.#files.size > 0;
    await Promise.all(unclaimed.map(file => rm(file.path, { force: true })));
    if (!this.#retained && !this.#pending.size) await rm(this.directory, { recursive: true, force: true });
  }
}
