import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { open, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, sep } from 'node:path';

const types = new Map([
  ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'], ['.avif', 'image/avif'],
  ['.mp4', 'video/mp4'], ['.webm', 'video/webm'], ['.mov', 'video/quicktime'],
  ['.pdf', 'application/pdf'], ['.txt', 'text/plain; charset=utf-8'],
]);

async function matchesType(file, mime) {
  const bytes = Buffer.alloc(32);
  const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
  const b = bytes.subarray(0, bytesRead);
  const starts = hex => b.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (mime === 'image/png') return starts('89504e470d0a1a0a');
  if (mime === 'image/jpeg') return starts('ffd8ff');
  if (mime === 'image/gif') return ['GIF87a', 'GIF89a'].includes(b.toString('ascii', 0, 6));
  if (mime === 'image/webp') return b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/webm') return starts('1a45dfa3');
  if (mime === 'application/pdf') return b.toString('ascii', 0, 5) === '%PDF-';
  if (['image/avif', 'video/mp4', 'video/quicktime'].includes(mime)) {
    if (b.length < 12 || b.toString('ascii', 4, 8) !== 'ftyp') return false;
    const brand = b.toString('ascii', 8, 12);
    if (mime === 'image/avif') return ['avif', 'avis'].includes(brand);
    if (mime === 'video/quicktime') return brand === 'qt  ';
    return !['avif', 'avis', 'qt  '].includes(brand);
  }
  // Text preview is not enabled until its response handling is defined.
  return false;
}

function within(root, path) {
  const rel = relative(root, path);
  return rel === '' || (rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// Only structured desktop item fields are considered; arbitrary text is not authorization.
export function referencedMediaPaths(state) {
  const turns = [...(Array.isArray(state?.turns) ? state.turns : [])];
  const history = state?.turnHistory?.kind === 'canonical' ? state.turnHistory.history : null;
  for (const island of history?.islands ?? []) for (const entry of island.entries ?? []) {
    const turn = history.entitiesByKey?.[entry.value];
    if (turn) turns.push(turn);
  }
  const paths = new Set();
  const add = value => { if (typeof value === 'string' && isAbsolute(value)) paths.add(value); };
  for (const turn of turns) for (const item of turn.items ?? []) {
    if (item?.type === 'imageView') add(item.path);
    if (item?.type === 'imageGeneration') add(item.savedPath);
    if (item?.type === 'userMessage' || item?.type === 'steeringUserMessage') for (const content of (item.type === 'steeringUserMessage' ? item.input : item.content) ?? []) {
      if (content?.type === 'localImage') add(content.path);
    }
  }
  return paths;
}

export function parseRange(header, size) {
  if (!Number.isSafeInteger(size) || size < 1) throw new RangeError('Invalid file size');
  if (header == null) return { start: 0, end: size - 1, partial: false };
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) throw new RangeError('Invalid range');
  let start, end;
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw new RangeError('Invalid range');
    start = Math.max(0, size - suffix); end = size - 1;
  } else {
    start = Number(match[1]); end = match[2] ? Number(match[2]) : size - 1;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start >= size || end < start) throw new RangeError('Invalid range');
    end = Math.min(end, size - 1);
  }
  return { start, end, partial: true };
}

export class MediaResolver {
  static async create({ roots, maxBytes = 200 * 1024 * 1024, ttlMs = 60000, maxHandles = 2048, now = Date.now } = {}) {
    if (!Array.isArray(roots) || !roots.length || roots.some(root => !isAbsolute(root)) ||
        !Number.isSafeInteger(maxBytes) || maxBytes < 1 || !Number.isSafeInteger(ttlMs) || ttlMs < 1 || !Number.isSafeInteger(maxHandles) || maxHandles < 1) throw new TypeError('Invalid media configuration');
    const resolved = await Promise.all(roots.map(async root => {
      const path = await realpath(root);
      if (!(await stat(path)).isDirectory()) throw new TypeError('Media root must be a directory');
      return path;
    }));
    return new MediaResolver(resolved, maxBytes, ttlMs, maxHandles, now);
  }

  #handles = new Map();
  constructor(roots, maxBytes, ttlMs, maxHandles, now) { this.roots = roots; this.maxBytes = maxBytes; this.ttlMs = ttlMs; this.maxHandles = maxHandles; this.now = now; }

  async issue({ state, hostId, deviceId, threadId }) {
    if (!hostId || !deviceId || !threadId || state?.id !== threadId) throw new TypeError('Invalid media scope');
    for (const [id, entry] of this.#handles) if (entry.expires <= this.now()) this.#handles.delete(id);
    const result = [];
    for (const path of referencedMediaPaths(state)) {
      if (this.#handles.size >= this.maxHandles) break;
      const mime = types.get(extname(path).toLowerCase());
      if (!mime) continue;
      try {
        const canonical = await realpath(path);
        if (!this.roots.some(root => within(root, canonical))) continue;
        const info = await stat(canonical);
        if (!info.isFile() || info.size < 1 || info.size > this.maxBytes) continue;
        const file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
        try {
          const opened = await file.stat();
          if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino || opened.size !== info.size || !(await matchesType(file, mime))) continue;
        } finally { await file.close(); }
        const id = randomBytes(24).toString('base64url');
        this.#handles.set(id, { path, canonical, hostId, deviceId, threadId, mime, dev: info.dev, ino: info.ino, size: info.size, mtimeMs: info.mtimeMs, expires: this.now() + this.ttlMs });
        result.push({ id, mime, size: info.size });
      } catch (error) { if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error; }
    }
    return result;
  }

  async open({ id, state, hostId, deviceId, threadId, range }) {
    const entry = this.#handles.get(id);
    if (!entry || entry.hostId !== hostId || entry.deviceId !== deviceId || entry.threadId !== threadId ||
        state?.id !== threadId || !referencedMediaPaths(state).has(entry.path) || entry.expires <= this.now()) {
      if (entry?.expires <= this.now()) this.#handles.delete(id);
      return null;
    }
    let file;
    try {
      const canonical = await realpath(entry.canonical);
      if (canonical !== entry.canonical || !this.roots.some(root => within(root, canonical))) return null;
      file = await open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
      const info = await file.stat();
      const current = await stat(canonical);
      if (!info.isFile() || info.dev !== current.dev || info.ino !== current.ino || info.dev !== entry.dev || info.ino !== entry.ino || info.size !== entry.size || info.mtimeMs !== entry.mtimeMs || !(await matchesType(file, entry.mime))) { await file.close(); return null; }
      const bounds = parseRange(range, info.size);
      return { file, mime: entry.mime, size: info.size, ...bounds };
    } catch (error) {
      await file?.close();
      if (error instanceof RangeError) throw error;
      if (['ENOENT', 'EACCES', 'ELOOP'].includes(error.code)) return null;
      throw error;
    }
  }

  revokeDevice(deviceId) { for (const [id, entry] of this.#handles) if (entry.deviceId === deviceId) this.#handles.delete(id); }
  clear() { this.#handles.clear(); }
}
