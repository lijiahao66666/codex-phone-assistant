import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { createServer } from 'node:net';
import { request as httpRequest, Agent } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { UploadStore } from '../src/media/upload-store.mjs';
import { ChunkUploads } from '../src/media/chunk-upload.mjs';

test('browser compresses every file type only when smaller and preserves raw fallback', async () => {
  const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('async function encodeUploadChunk('), source.indexOf('async function loadCapabilities('));
  const ctx = vm.createContext({ CompressionStream, Response, Blob });
  vm.runInContext(`let uploadCompression='gzip'; ${helper}`, ctx);
  const encode = vm.runInContext('encodeUploadChunk', ctx);
  const bytes = Buffer.from('document content and binary bytes\0'.repeat(4000));
  for (const type of ['image/jpeg', 'application/pdf', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream']) {
    const chunk = new Blob([bytes], { type });
    const result = await encode(chunk);
    assert.equal(result.headers['content-encoding'], 'gzip');
    const compressed = Buffer.from(await result.body.arrayBuffer());
    assert.ok(compressed.length < bytes.length);
    assert.deepEqual(gunzipSync(compressed), bytes);
  }
  const random = new Blob([randomBytes(131072)]);
  assert.equal((await encode(random)).body, random);
  // Once the first chunk of a file proves unhelpful to compress, later chunks
  // may bypass compression without changing their bytes or content type.
  const compressible = new Blob([bytes], { type: 'application/pdf' });
  vm.runInContext('CompressionStream = class { constructor() { throw new Error("must not run"); } }', ctx);
  const skipped = await encode(compressible, undefined, false);
  assert.equal(skipped.body, compressible);
  assert.equal(skipped.compressionRatio, 1);
  assert.equal(skipped.headers['content-encoding'], undefined);
  assert.deepEqual(Buffer.from(await skipped.body.arrayBuffer()), bytes);
  vm.runInContext('CompressionStream = undefined', ctx);
  vm.runInContext('uploadCompression=null', ctx);
  assert.equal((await encode(new Blob([bytes]))).headers['content-encoding'], undefined);
  vm.runInContext("uploadCompression='gzip'; CompressionStream=undefined", ctx);
  assert.equal((await encode(random)).body, random);
  await assert.rejects(encode(random, AbortSignal.abort()), /cancelled/);
});

test('real HTTP and connector accept mixed compressed/raw chunks byte for byte and reject corrupt/bomb/unknown encoding', { timeout: 60000 }, async t => {
  const root = await mkdtemp(join(tmpdir(), 'phone-compression-'));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, imageUpload: true }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, data, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  const uploadAgent = new Agent({ keepAlive: true, maxSockets: 2 });
  let connector, store, receiver;
  try {
    const host = await (await post('/api/enroll', { name: 'compression-test' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(paired.status, 200);
    const pair = await paired.json();
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const capabilities = await (await fetch(base + '/api/capabilities', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(capabilities.uploadCompression, 'gzip');
    store = await UploadStore.create({ root });
    receiver = new ChunkUploads(store, { maxChunk: 524288, pipelineWindow: 2, validator: async () => {} });
    connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, hostId: host.hostId, secret: host.secret, imageUpload: true, allowInsecureForTests: true,
      createUploadContext: async () => ({ store, receiver }),
      createSession: () => Object.assign(new EventEmitter(), { async close() {} }) });
    connector.start();
    for (let i = 0; i < 50; i++) {
      const status = await fetch(base + '/api/capabilities', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
      const data = await status.json();
      if (data.imageChunkBytes === 524288 && data.uploadConcurrency === 2) break;
      await delay(10);
    }
    const negotiated = await (await fetch(base + '/api/capabilities', { headers: { cookie, 'sec-fetch-site': 'same-origin' } })).json();
    assert.equal(negotiated.imageChunkBytes, 524288);
    assert.equal(negotiated.uploadConcurrency, 2);
    const thread = '11111111-1111-4111-8111-111111111111';
    const first = Buffer.alloc(131072, 97), second = randomBytes(524288), third = Buffer.alloc(524288, 98), fourth = randomBytes(131072);
    const data = Buffer.concat([first, second, third, fourth]);
    for (const kind of ['file', 'image']) {
      const started = await post(`/api/threads/${thread}/uploads`, { name: kind === 'image' ? 'test.png' : 'report.pdf', size: data.length, kind }, { cookie });
      assert.equal(started.status, 200);
      const upload = (await started.json()).uploadId;
      const put = (seq, bytes, encoding) => new Promise((resolve, reject) => {
        const started = performance.now();
        const request = httpRequest(`${base}/api/threads/${thread}/uploads/${upload}/chunks/${seq}`, {
          method: 'PUT', agent: uploadAgent,
          headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream', 'content-length': bytes.length, ...(encoding ? { 'content-encoding': encoding } : {}) },
        }, response => {
          response.resume();
          response.once('end', () => { t.diagnostic(JSON.stringify({ nativeHttp: true, seq, bytes: bytes.length, status: response.statusCode, elapsedMs: Math.round(performance.now() - started) })); resolve({ status: response.statusCode }); });
          response.once('error', reject);
        });
        request.once('error', reject); request.end(bytes);
      });
      assert.equal((await put(0, gzipSync(first).subarray(0, 12), 'gzip')).status, 400);
      assert.equal((await put(0, gzipSync(Buffer.alloc(524289)), 'gzip')).status, 413);
      assert.equal((await put(0, first, 'br')).status, 415);
      assert.equal((await put(0, Buffer.alloc(524288), 'gzip')).status, 400);
      assert.equal((await put(0, gzipSync(first), 'gzip')).status, 200);
      const later = put(2, gzipSync(third), 'gzip');
      const earlier = put(1, second);
      assert.deepEqual((await Promise.all([earlier, later])).map(response => response.status), [200, 200]);
      assert.equal((await put(3, fourth)).status, 200);
      const finished = await post(`/api/threads/${thread}/uploads/${upload}/finish`, undefined, { cookie });
      assert.equal(finished.status, 200);
      const attachment = (await finished.json()).attachmentId;
      const saved = store.resolve({ id: attachment, hostId: host.hostId, deviceId: pair.deviceId, threadId: thread });
      assert.deepEqual(await readFile(saved.path), data);
      assert.equal(saved.kind, kind);
      assert.equal((await fetch(`${base}/api/threads/${thread}/uploads/${attachment}`, { method: 'DELETE', headers: { cookie, origin, 'sec-fetch-site': 'same-origin' } })).status, 200);
    }
  } finally {
    uploadAgent.destroy();
    await connector?.close(); await receiver?.close(); await store?.close(); await relay.close(); await rm(root, { recursive: true, force: true });
  }
});

test('upload responses allow an earlier slow body beyond ordinary RPC timeout and still cancel bounded waits', { timeout: 10000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'phone-upload-response-'));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, imageUpload: true, requestTimeoutMs: 20, uploadResponseTimeoutMs: 500 }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, data, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: data === undefined ? undefined : JSON.stringify(data) });
  let connector, store, receiver;
  try {
    const host = await (await post('/api/enroll', { name: 'upload-response-test' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(paired.status, 200);
    const pair = await paired.json(), cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    store = await UploadStore.create({ root }); receiver = new ChunkUploads(store, { maxChunk: 524288, pipelineWindow: 2, validator: async () => {} });
    let markLater, cancelled = 0;
    const originalChunk = receiver.chunk.bind(receiver), originalCancel = receiver.cancel.bind(receiver);
    receiver.chunk = (...args) => { if (args[2] === 1) markLater?.(); return originalChunk(...args); };
    receiver.cancel = async (...args) => { cancelled++; return originalCancel(...args); };
    connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, hostId: host.hostId, secret: host.secret, imageUpload: true, allowInsecureForTests: true,
      createUploadContext: async () => ({ store, receiver }), createSession: () => Object.assign(new EventEmitter(), { async close() {} }) }); connector.start();
    for (let i = 0; i < 50; i++) {
      const status = await fetch(base + '/api/host-status', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
      if ((await status.json()).online) break;
      await delay(10);
    }
    const thread = '11111111-1111-4111-8111-111111111111', scope = { hostId: host.hostId, deviceId: pair.deviceId, threadId: thread };
    const data = Buffer.from('first chunk bytes'.padEnd(32, '.') + 'second chunk bytes'.padEnd(32, '.'));
    const start = async () => {
      const response = await post(`/api/threads/${thread}/uploads`, { name: 'ordered.txt', kind: 'file', size: data.length }, { cookie });
      assert.equal(response.status, 200); return (await response.json()).uploadId;
    };
    const put = (upload, seq, bytes, bodyDelay = 0) => new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/threads/${thread}/uploads/${upload}/chunks/${seq}`, {
        method: 'PUT', headers: { cookie, origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/octet-stream', 'content-length': bytes.length },
      }, response => { response.resume(); response.once('end', () => resolve(response.statusCode)); response.once('error', reject); });
      request.once('error', reject); request.flushHeaders();
      if (bodyDelay) setTimeout(() => request.end(bytes), bodyDelay); else request.end(bytes);
    });
    const upload = await start(), laterReceived = new Promise(resolve => { markLater = resolve; });
    const later = put(upload, 1, data.subarray(32)); await laterReceived;
    // The later response already waits while the earlier request body arrives.
    const earlier = put(upload, 0, data.subarray(0, 32), 100);
    assert.deepEqual(await Promise.all([earlier, later]), [200, 200]);
    const finished = await post(`/api/threads/${thread}/uploads/${upload}/finish`, undefined, { cookie }); assert.equal(finished.status, 200);
    const id = (await finished.json()).attachmentId;
    assert.deepEqual(await readFile(store.resolve({ id, ...scope }).path), data);
    await store.remove({ id, ...scope });
    const stalled = await start(); markLater = null;
    assert.equal(await put(stalled, 1, data.subarray(32)), 503);
    for (let i = 0; i < 50 && !cancelled; i++) await delay(10);
    assert.ok(cancelled > 0);
    await assert.rejects(receiver.chunk(stalled, scope, 0, data.subarray(0, 32)), /Upload unavailable/);
  } finally {
    await connector?.close(); await receiver?.close(); await store?.close(); await relay.close(); await rm(root, { recursive: true, force: true });
  }
});
