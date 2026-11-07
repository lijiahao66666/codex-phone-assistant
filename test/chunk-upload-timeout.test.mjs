import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ChunkUploads } from '../src/media/chunk-upload.mjs';
import { UploadStore } from '../src/media/upload-store.mjs';

const scope = { hostId: 'host', deviceId: 'device', threadId: 'thread' };
async function fixture(options) {
  const root = await mkdtemp(join(tmpdir(), 'phone-upload-timeout-'));
  const store = await UploadStore.create({ root });
  const uploads = new ChunkUploads(store, { maxChunk: 131072, ...options });
  return { store, uploads, async close() { await uploads.close(); await store.close(); await rm(root, { recursive: true, force: true }); } };
}

test('ongoing transfer can exceed the idle timeout while preserving all bytes', async () => {
  const f = await fixture({ timeoutMs: 180, maxDurationMs: 2000 });
  try {
    const bytes = Buffer.concat(Array.from({ length: 4 }, (_, i) => Buffer.alloc(131072, i + 1)));
    const id = f.uploads.start({ ...scope, name: 'continued.bin', kind: 'file', size: bytes.length });
    const began = Date.now();
    for (let seq = 0; seq < 4; seq++) {
      await delay(80);
      await f.uploads.chunk(id, scope, seq, bytes.subarray(seq * 131072, (seq + 1) * 131072));
    }
    assert.ok(Date.now() - began > 180);
    const result = await f.uploads.finish(id, scope);
    const saved = f.store.resolve({ id: result.id, ...scope });
    assert.deepEqual(await readFile(saved.path), bytes);
    assert.ok(f.store.claim({ id: result.id, ...scope }));
    await f.store.discardRejected({ id: result.id, ...scope });
  } finally { await f.close(); }
});

test('idle partial upload expires and removes its temporary file', async () => {
  const f = await fixture({ timeoutMs: 80, maxDurationMs: 2000 });
  try {
    const id = f.uploads.start({ ...scope, name: 'idle.bin', kind: 'file', size: 262144 });
    await f.uploads.chunk(id, scope, 0, Buffer.alloc(131072));
    await delay(130);
    await assert.rejects(f.uploads.chunk(id, scope, 1, Buffer.alloc(131072)), /Upload unavailable/);
    await f.uploads.close();
    assert.deepEqual(await readdir(f.store.directory), []);
  } finally { await f.close(); }
});

for (const action of ['cancel', 'close']) test(`${action} prevents a backpressured chunk from reviving the upload`, async () => {
  const f = await fixture({ timeoutMs: 100, maxDurationMs: 1000 });
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const put = f.store.put.bind(f.store);
  f.store.put = async options => { await gate; return put(options); };
  try {
    const id = f.uploads.start({ ...scope, name: 'cancelled.bin', kind: 'file', size: 262144 });
    const chunk = f.uploads.chunk(id, scope, 0, Buffer.alloc(131072));
    const rejected = assert.rejects(chunk, /Upload cancelled/);
    const cancelled = action === 'cancel' ? f.uploads.cancel(id, scope) : f.uploads.close();
    release();
    await Promise.all([cancelled, rejected]);
    await delay(130);
    await assert.rejects(f.uploads.chunk(id, scope, 1, Buffer.alloc(131072)), /Upload unavailable/);
    await assert.rejects(f.uploads.finish(id, scope), /Upload unavailable/);
    assert.deepEqual(await readdir(f.store.directory), []);
  } finally { release(); await f.close(); }
});

test('continued progress cannot extend the total upload deadline', async () => {
  const f = await fixture({ timeoutMs: 200, maxDurationMs: 150 });
  try {
    const id = f.uploads.start({ ...scope, name: 'bounded.bin', kind: 'file', size: 393216 });
    await f.uploads.chunk(id, scope, 0, Buffer.alloc(131072));
    await delay(90);
    await f.uploads.chunk(id, scope, 1, Buffer.alloc(131072));
    await delay(100);
    await assert.rejects(f.uploads.chunk(id, scope, 2, Buffer.alloc(131072)), /Upload unavailable/);
    await f.uploads.close();
    assert.deepEqual(await readdir(f.store.directory), []);
  } finally { await f.close(); }
});
