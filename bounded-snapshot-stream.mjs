import { createHash, randomUUID } from 'node:crypto';

const MAX = 32 * 1024 * 1024, CHUNK = 48 * 1024;

// emit must resolve only when the transport has accepted the frame or rejects.
export class BoundedSnapshotStream {
  constructor(emit, { maxBytes = MAX, chunkBytes = CHUNK } = {}) {
    if (typeof emit !== 'function' || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX || !Number.isSafeInteger(chunkBytes) || chunkBytes < 1 || chunkBytes > CHUNK) throw new TypeError('invalid options');
    this.emit = emit; this.maxBytes = maxBytes; this.chunkBytes = chunkBytes; this.generation = 0; this.closed = false; this.pending = null; this.running = false;
  }
  cancel() { this.generation++; if (this.pending) { this.pending.reject(new Error('superseded')); this.pending = null; } }
  close() { this.closed = true; this.cancel(); }
  send(value, seq) {
    if (this.closed || !Number.isSafeInteger(seq) || seq < 1) throw new Error('invalid state');
    const generation = ++this.generation;
    if (this.pending) this.pending.reject(new Error('superseded'));
    const work = new Promise((resolve, reject) => { this.pending = { value, seq, generation, resolve, reject }; });
    void this.#pump();
    return work;
  }
  async #pump() {
    if (this.running) return;
    this.running = true;
    while (this.pending && !this.closed) {
      const item = this.pending; this.pending = null;
      try { item.resolve(await this.#send(item.value, item.seq, item.generation)); }
      catch (error) { item.reject(error); }
    }
    this.running = false;
  }
  async #send(value, seq, generation) {
    if (this.closed || generation !== this.generation) throw new Error('superseded');
    const transferId = randomUUID();
    const bytes = Buffer.from(JSON.stringify(value));
    if (bytes.length > this.maxBytes) throw new RangeError('state too large');
    const count = Math.ceil(bytes.length / this.chunkBytes), hash = createHash('sha256').update(bytes).digest('hex');
    const send = async frame => {
      if (this.closed || generation !== this.generation) throw new Error('superseded');
      await this.emit(frame);
      if (this.closed || generation !== this.generation) throw new Error('superseded');
    };
    await send({ type: 'begin', transferId, generation, seq, size: bytes.length, chunkBytes: this.chunkBytes, count, hash });
    for (let index = 0; index < count; index++) await send({ type: 'chunk', transferId, generation, index, data: bytes.subarray(index * this.chunkBytes, (index + 1) * this.chunkBytes).toString('base64') });
    await send({ type: 'end', transferId, generation });
    return { generation, seq };
  }
}
