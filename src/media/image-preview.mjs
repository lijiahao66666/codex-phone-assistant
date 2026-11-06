import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, sep } from 'node:path';
import { referencedMediaPaths } from './media-resolver.mjs';

function within(root, path) {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function imageType(bytes) {
  if (bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return 'image/png';
  if (bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return 'image/jpeg';
  if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp') {
    const brand = bytes.toString('ascii', 8, 12);
    if (brand === 'qt  ') return 'video/quicktime';
    if (!['avif', 'avis'].includes(brand)) return 'video/mp4';
  }
  if (bytes.subarray(0, 4).equals(Buffer.from('1a45dfa3', 'hex'))) return 'video/webm';
  return null;
}

export class ImagePreview {
  static async create({ roots, helperPath, maxBytes = 32 * 1024 * 1024, ttlMs = 60000, now = Date.now } = {}) {
    if (!Array.isArray(roots) || !roots.length || roots.some(root => !isAbsolute(root)) || !isAbsolute(helperPath || '') ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 32 * 1024 * 1024 || !Number.isSafeInteger(ttlMs) || ttlMs < 1) throw new TypeError('Invalid preview configuration');
    return new ImagePreview(await Promise.all(roots.map(root => realpath(root))), helperPath, maxBytes, ttlMs, now);
  }
  #handles = new Map();
  #cacheBytes = 0;
  constructor(roots, helperPath, maxBytes, ttlMs, now) { this.roots = roots; this.helperPath = helperPath; this.maxBytes = maxBytes; this.ttlMs = ttlMs; this.now = now; }
  // The returned path is internal metadata used to associate a handle with an item.
  async issue({ state, hostId, deviceId, threadId }) {
    if (!hostId || !deviceId || !threadId || state?.id !== threadId) throw new TypeError('Invalid preview scope');
    for (const [id, item] of this.#handles) if (item.expires <= this.now()) { if (item.cached) this.#cacheBytes -= item.cached.bytes.length; this.#handles.delete(id); }
    const result = [];
    for (const path of referencedMediaPaths(state)) {
      try {
        const canonical = await realpath(path);
        const root = this.roots.find(value => within(value, canonical));
        if (!root) continue;
        const info = await stat(canonical, { bigint: true });
        if (!info.isFile() || info.size < 1n || info.size > BigInt(this.maxBytes)) continue;
        const identity = [info.dev, info.ino, info.size, info.mtimeNs / 1000000000n, info.mtimeNs % 1000000000n, info.ctimeNs].map(value => value.toString());
        const existing = [...this.#handles].find(([, item]) => item.path === path && item.canonical === canonical &&
          item.hostId === hostId && item.deviceId === deviceId && item.threadId === threadId &&
          item.identity.every((value, index) => value === identity[index]));
        if (existing) { existing[1].expires = this.now() + this.ttlMs; result.push({ id: existing[0], path, ...(existing[1].mime ? { mime: existing[1].mime } : {}) }); continue; }
        if (this.#handles.size >= 256) break;
        const id = randomBytes(24).toString('base64url');
        const extension = extname(path).toLowerCase();
        const mime = ['.mp4'].includes(extension) ? 'video/mp4' : ['.webm'].includes(extension) ? 'video/webm' : ['.mov'].includes(extension) ? 'video/quicktime' : null;
        this.#handles.set(id, { path, canonical, root, identity, hostId, deviceId, threadId, mime, expires: this.now() + this.ttlMs });
        result.push({ id, path, ...(mime ? { mime } : {}) });
      } catch (error) { if (!['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) throw error; }
    }
    return result;
  }
  async read({ id, state, hostId, deviceId, threadId }) {
    const item = this.#handles.get(id);
    if (!item || item.hostId !== hostId || item.deviceId !== deviceId || item.threadId !== threadId || item.expires <= this.now() ||
        state?.id !== threadId || !referencedMediaPaths(state).has(item.path)) return null;
    try {
      if (await realpath(item.path) !== item.canonical) return null;
      const bytes = await this.#readFile(item.root, relative(item.root, item.canonical), item.identity);
      if (this.#handles.get(id) !== item || item.expires <= this.now()) return null;
      const mime = imageType(bytes);
      return mime ? { mime, bytes } : null;
    } catch (error) { if (['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) return null; throw error; }
  }
  async readChunk({ id, state, hostId, deviceId, threadId, offset, length = 128 * 1024 }) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 128 * 1024) throw new TypeError('Invalid image range');
    const item = this.#handles.get(id);
    if (!item || item.hostId !== hostId || item.deviceId !== deviceId || item.threadId !== threadId || item.expires <= this.now() ||
        state?.id !== threadId || !referencedMediaPaths(state).has(item.path)) return null;
    let image = item.cached;
    if (!image) {
      if (!item.loading) item.loading = this.read({ id, state, hostId, deviceId, threadId }).finally(() => { item.loading = null; });
      image = await item.loading;
      if (!image || this.#handles.get(id) !== item || item.expires <= this.now()) return null;
      if (!item.cached) {
        for (const candidate of this.#handles.values()) {
          if (this.#cacheBytes + image.bytes.length <= 16 * 1024 * 1024) break;
          if (candidate.cached) { this.#cacheBytes -= candidate.cached.bytes.length; candidate.cached = null; }
        }
        item.cached = image;
        this.#cacheBytes += image.bytes.length;
      }
    }
    if (offset >= image.bytes.length) return null;
    const end = Math.min(offset + length, image.bytes.length);
    return { mime: image.mime, size: image.bytes.length, offset, bytes: image.bytes.subarray(offset, end) };
  }
  async validateHandle({ id, getState, hostId, deviceId, threadId }) {
    const item = this.#handles.get(id);
    if (!item || item.hostId !== hostId || item.deviceId !== deviceId || item.threadId !== threadId || item.expires <= this.now()) return false;
    try {
      if (await realpath(item.path) !== item.canonical) return false;
      const info = await stat(item.canonical, { bigint: true });
      const identity = [info.dev, info.ino, info.size, info.mtimeNs / 1000000000n, info.mtimeNs % 1000000000n, info.ctimeNs].map(String);
      const state = getState();
      return info.isFile() && item.identity.every((value, index) => value === identity[index]) && this.#handles.get(id) === item && item.expires > this.now() && state?.id === threadId && referencedMediaPaths(state).has(item.path);
    } catch { return false; }
  }
  #readFile(root, path, identity) {
    return new Promise((resolve, reject) => {
      const child = spawn(this.helperPath, [root, path, String(this.maxBytes), ...identity], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = []; let size = 0, failed = false;
      const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 8000);
      child.stdout.on('data', chunk => { size += chunk.length; if (size > this.maxBytes) { failed = true; child.kill('SIGKILL'); } else chunks.push(chunk); });
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => { clearTimeout(timer); if (failed || code !== 0) reject(new Error('Image unavailable')); else resolve(Buffer.concat(chunks)); });
    });
  }
  revokeDevice(deviceId) { for (const [id, item] of this.#handles) if (item.deviceId === deviceId) { if (item.cached) this.#cacheBytes -= item.cached.bytes.length; this.#handles.delete(id); } }
  clear() { this.#handles.clear(); this.#cacheBytes = 0; }
}
