// Experimental protocol primitive; callers must await each received frame in order.
const DEFAULT_CHUNK_BYTES = 48 * 1024;
const DEFAULT_MAX_BYTES = 32 * 1024 * 1024;
const MAX_CHUNKS = 4096;
const TOKEN = /^[A-Za-z0-9_-]{1,128}$/;
const validInt = value => Number.isSafeInteger(value) && value >= 0;
const toHex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');

function bytesToBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  return btoa(binary);
}

function base64ToBytes(value, expected) {
  if (typeof value !== 'string' || value.length !== 4 * Math.ceil(expected / 3) || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new Error('invalid chunk');
  let binary;
  try { binary = atob(value); } catch { throw new Error('invalid chunk'); }
  if (binary.length !== expected) throw new Error('invalid chunk');
  const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
  if (bytesToBase64(bytes) !== value) throw new Error('invalid chunk');
  return bytes;
}

async function digest(bytes) { return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))); }

export async function* encodeStateChunks(value, { transferId, generation, seq, chunkBytes = DEFAULT_CHUNK_BYTES, maxBytes = DEFAULT_MAX_BYTES } = {}) {
  if (typeof transferId !== 'string' || !TOKEN.test(transferId) || !validInt(generation) || generation < 1 || !validInt(seq) || seq < 1 || !validInt(chunkBytes) || chunkBytes < 1 || chunkBytes > DEFAULT_CHUNK_BYTES || !validInt(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES) throw new TypeError('invalid transfer options');
  const json = JSON.stringify(value);
  if (typeof json !== 'string') throw new TypeError('invalid state');
  const bytes = new TextEncoder().encode(json);
  if (bytes.length > maxBytes) throw new RangeError('state too large');
  const count = Math.ceil(bytes.length / chunkBytes);
  if (count > MAX_CHUNKS) throw new RangeError('too many chunks');
  const hash = await digest(bytes);
  yield { type: 'begin', transferId, generation, seq, size: bytes.length, chunkBytes, count, hash };
  for (let index = 0; index < count; index++) {
    yield { type: 'chunk', transferId, generation, index, data: bytesToBase64(bytes.subarray(index * chunkBytes, Math.min((index + 1) * chunkBytes, bytes.length))) };
  }
  yield { type: 'end', transferId, generation };
}

export class StateChunkAssembler {
  constructor({ maxBytes = DEFAULT_MAX_BYTES, maxChunkBytes = DEFAULT_CHUNK_BYTES } = {}) {
    if (!validInt(maxBytes) || maxBytes < 1 || maxBytes > DEFAULT_MAX_BYTES || !validInt(maxChunkBytes) || maxChunkBytes < 1 || maxChunkBytes > DEFAULT_CHUNK_BYTES) throw new TypeError('invalid limits');
    this.maxBytes = maxBytes; this.maxChunkBytes = maxChunkBytes; this.generation = 0; this.active = null; this.version = 0;
  }

  cancel() { this.version++; this.active = null; }

  async accept(frame) {
    if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new Error('invalid frame');
    if (frame.type === 'begin') {
      if (!validInt(frame.generation) || frame.generation <= this.generation) throw new Error('stale generation');
      this.generation = frame.generation; this.version++; this.active = null;
      if (typeof frame.transferId !== 'string' || !TOKEN.test(frame.transferId) || !validInt(frame.seq) || frame.seq < 1 || !validInt(frame.size) || frame.size < 1 || frame.size > this.maxBytes || !validInt(frame.chunkBytes) || frame.chunkBytes < 1 || frame.chunkBytes > this.maxChunkBytes || !validInt(frame.count) || frame.count > MAX_CHUNKS || frame.count !== Math.ceil(frame.size / frame.chunkBytes) || typeof frame.hash !== 'string' || !/^[0-9a-f]{64}$/.test(frame.hash)) throw new Error('invalid begin');
      this.active = { transferId: frame.transferId, generation: frame.generation, seq: frame.seq, size: frame.size, chunkBytes: frame.chunkBytes, count: frame.count, hash: frame.hash, received: 0, chunks: [] };
      return null;
    }
    const active = this.active;
    if (!active || frame.transferId !== active.transferId || frame.generation !== active.generation) throw new Error('unknown transfer');
    try {
      if (frame.type === 'chunk') {
        if (frame.index !== active.chunks.length || frame.index >= active.count) throw new Error('unexpected chunk');
        const expected = Math.min(active.chunkBytes, active.size - active.received);
        const bytes = base64ToBytes(frame.data, expected);
        active.chunks.push(bytes); active.received += bytes.length;
        return null;
      }
      if (frame.type !== 'end' || active.chunks.length !== active.count || active.received !== active.size) throw new Error('incomplete transfer');
      this.active = null; const version = this.version;
      const bytes = new Uint8Array(active.size); let offset = 0;
      for (const chunk of active.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      if (await digest(bytes) !== active.hash) throw new Error('digest mismatch');
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (this.version !== version || this.generation !== active.generation || this.active !== null) throw new Error('superseded transfer');
      return { seq: active.seq, value };
    } catch (error) { if (this.active === active) this.active = null; throw error; }
  }
}
