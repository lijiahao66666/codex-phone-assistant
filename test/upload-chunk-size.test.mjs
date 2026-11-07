import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { randomBytes } from 'node:crypto';
import { ChunkUploads } from '../src/media/chunk-upload.mjs';
import { UploadStore } from '../src/media/upload-store.mjs';

const scope = { hostId: 'host', deviceId: 'device', threadId: 'thread' };
async function fixture(maxChunk = 512 * 1024) {
  const root = await mkdtemp(join(tmpdir(), 'phone-upload-chunk-size-'));
  const store = await UploadStore.create({ root });
  const uploads = new ChunkUploads(store, { maxChunk, validator: async () => {} });
  return { store, uploads, root, async close() { await uploads.close(); await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('512 KiB chunks preserve random bytes and reject one byte over limit', async () => {
  const f = await fixture();
  try {
    const bytes = randomBytes(1024 * 1024 + 17);
    const id = f.uploads.start({ ...scope, name: 'random.bin', size: bytes.length, kind: 'file' });
    await f.uploads.chunk(id, scope, 0, bytes.subarray(0, 512 * 1024));
    await f.uploads.chunk(id, scope, 1, bytes.subarray(512 * 1024, 1024 * 1024));
    await f.uploads.chunk(id, scope, 2, bytes.subarray(1024 * 1024));
    const saved = await f.uploads.finish(id, scope);
    const resolved = f.store.resolve({ id: saved.id, ...scope });
    assert.deepEqual(await readFile(resolved.path), bytes);
    const oversized = f.uploads.start({ ...scope, name: 'too-large.bin', size: 512 * 1024 + 1, kind: 'file' });
    await assert.rejects(f.uploads.chunk(oversized, scope, 0, Buffer.alloc(512 * 1024 + 1)), /Invalid upload chunk/);
  } finally { await f.close(); }
});

test('mixed legacy and 512 KiB chunks retain order and reject skipped sequence', async () => {
  const f = await fixture();
  try {
    const first = Buffer.alloc(128 * 1024, 1), second = Buffer.alloc(512 * 1024, 2), last = Buffer.alloc(3, 3);
    const id = f.uploads.start({ ...scope, name: 'mixed.bin', size: first.length + second.length + last.length, kind: 'file' });
    await f.uploads.chunk(id, scope, 0, first);
    await f.uploads.chunk(id, scope, 1, second);
    await f.uploads.chunk(id, scope, 2, last);
    const saved = await f.uploads.finish(id, scope);
    assert.deepEqual(await readFile(f.store.resolve({ id: saved.id, ...scope }).path), Buffer.concat([first, second, last]));
    const bad = f.uploads.start({ ...scope, name: 'bad.bin', size: second.length * 2, kind: 'file' });
    await assert.rejects(f.uploads.chunk(bad, scope, 1, second), /Invalid upload chunk/);
  } finally { await f.close(); }
});

test('chunk transport preserves arbitrary file types and cancellation clears partial files', async () => {
  const f = await fixture();
  try {
    const bytes = randomBytes(512 * 1024);
    for (const name of ['photo.jpg', 'report.pdf', 'document.docx', 'archive.zip', 'recording.mp4']) {
      const id = f.uploads.start({ ...scope, name, size: bytes.length, kind: 'file' });
      await f.uploads.chunk(id, scope, 0, bytes);
      const saved = await f.uploads.finish(id, scope);
      assert.deepEqual(await readFile(f.store.resolve({ id: saved.id, ...scope }).path), bytes, name);
      await f.store.remove({ id: saved.id, ...scope });
    }
    const cancelled = f.uploads.start({ ...scope, name: 'cancel.bin', size: bytes.length * 2, kind: 'file' });
    await f.uploads.chunk(cancelled, scope, 0, bytes);
    await f.uploads.cancel(cancelled, scope);
    await assert.rejects(f.uploads.chunk(cancelled, scope, 1, bytes), /Upload unavailable/);
    assert.deepEqual(await readdir(f.store.directory), []);
  } finally { await f.close(); }
});

test('real staged transfers need a quarter of chunk round trips at 512 KiB', async t => {
  const bytes = randomBytes(4 * 1024 * 1024), rtt = 20;
  async function transfer(chunk) {
    const f = await fixture();
    try {
      const id = f.uploads.start({ ...scope, name: 'rtt.bin', size: bytes.length, kind: 'file' });
      let requests = 0; const started = performance.now();
      for (let offset = 0; offset < bytes.length; offset += chunk) {
        await delay(rtt);
        await f.uploads.chunk(id, scope, requests++, bytes.subarray(offset, offset + chunk));
      }
      const result = await f.uploads.finish(id, scope);
      const elapsed = Math.round(performance.now() - started);
      assert.deepEqual(await readFile(f.store.resolve({ id: result.id, ...scope }).path), bytes);
      return { requests, elapsed };
    } finally { await f.close(); }
  }
  const legacy = await transfer(128 * 1024), fast = await transfer(512 * 1024);
  assert.equal(legacy.requests, 32); assert.equal(fast.requests, 8);
  t.diagnostic(JSON.stringify({ bytes: bytes.length, artificialRttMs: rtt, legacy128KiB: legacy, candidate512KiB: fast }));
});
