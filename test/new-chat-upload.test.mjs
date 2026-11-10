import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto, randomBytes } from 'node:crypto';

const thread = '11111111-1111-4111-8111-111111111111';
const upload = '22222222-2222-4222-8222-222222222222';
const attachment = '33333333-3333-4333-8333-333333333333';
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (status = 200, value = {}) => ({ ok: status >= 200 && status < 300, status, json: async () => value, clone: () => response(status, value) });
async function fixture(handler, { compression = false } = {}) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } get childNodes() { return this.children; }
    addEventListener(type, fn) { this.listeners[type] = fn; } setAttribute() {} querySelectorAll() { return []; } after() {} before() {}
  }
  const nodes = new Map(), requests = [], compressionCalls = [];
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement() { return new Element(); }, createDocumentFragment() { return new Element(); } };
  const context = vm.createContext({ document, Blob, AbortController, TextDecoder, TextEncoder, Response, URL, Date, setTimeout, clearTimeout, crypto: webcrypto,
    CompressionStream: class extends CompressionStream { constructor(format) { compressionCalls.push(format); super(format); } },
    localStorage: { getItem() { return null; }, setItem() {}, removeItem() {} }, sessionStorage: { removeItem() {} }, window: { addEventListener() {} },
    fetch: async (url, options = {}) => {
      requests.push({ url, options }); const custom = await handler?.(url, options); if (custom) return custom;
      if (url.endsWith('/capabilities')) return response(200, { imageUpload: true, imageChunkBytes: 524288, uploadConcurrency: 2, maxImageBytes: 20 * 1024 * 1024, ...(compression ? { uploadCompression: 'gzip' } : {}) });
      if (url === '/api/chats/prepare') return response(202, { threadId: thread });
      if (url.endsWith('/uploads') && options.method === 'POST') return response(200, { uploadId: upload });
      if (url.includes('/chunks/')) return response();
      if (url.endsWith('/finish')) return response(200, { attachmentId: attachment });
      if (url === '/api/chats/submit') return response(202, { threadId: thread });
      return response(200, { projects: [], recent: [] });
    },
  });
  const run = code => vm.runInContext(code, context);
  const source = process.env.CODEX_PHONE_UI_SOURCE ? await readFile(process.env.CODEX_PHONE_UI_SOURCE, 'utf8') : await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  run(source); await tick();
  run("selectedId=null;connected=true;imageUploadAvailable=true;currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};newModels=[];connect=async()=>{};loadThreads=async()=>{};newDraft={projectId:'project',attachments:[],model:null,effort:null,pending:false,uncertain:false};messageInput.value='first file';");
  return { run, nodes, requests, compressionCalls, seed(bytes) { context.uploadTestBytes = bytes; run("newDraft.attachments=[{file:Object.assign(new Blob([uploadTestBytes]),{name:'original.bin'}),kind:'file',previewPromise:Promise.resolve()}]"); }, submit: () => nodes.get('#composer-form').listeners.submit({ preventDefault() {} }) };
}
async function until(check) { for (let i = 0; i < 100; i++) { if (check()) return; await tick(); } assert.fail('expected upload condition was not reached'); }
const chunks = f => f.requests.filter(request => request.url.includes('/chunks/'));
const submissions = f => f.requests.filter(request => request.url === '/api/chats/submit');

test('new chat uses negotiated two-chunk uploads and waits for every creation-bound acknowledgement before submit', async () => {
  const pending = new Map(); let active = 0, maximum = 0;
  const f = await fixture((url, options) => {
    if (!url.includes('/chunks/')) return;
    return new Promise(resolve => { const seq = Number(url.split('/').at(-1)); active++; maximum = Math.max(maximum, active); pending.set(seq, () => { active--; resolve(response()); }); });
  });
  const data = randomBytes(3 * 524288); f.seed(data); const sending = f.submit();
  await until(() => pending.has(1)); assert.deepEqual([...pending.keys()], [0, 1]); assert.equal(maximum, 2);
  assert.equal(f.requests.some(request => request.url.endsWith('/finish')), false);
  pending.get(1)(); await until(() => pending.has(2)); pending.get(2)(); await tick();
  assert.equal(f.requests.some(request => request.url.endsWith('/finish')), false); assert.equal(submissions(f).length, 0);
  pending.get(0)(); await sending;
  const prepare = JSON.parse(f.requests.find(request => request.url === '/api/chats/prepare').options.body);
  assert.match(prepare.digest, /^[a-f0-9]{64}$/); assert.match(prepare.requestId, /^[a-f0-9-]{36}$/);
  for (const request of f.requests.filter(request => request.url.includes('/uploads'))) assert.equal(request.options.headers['x-creation-id'], prepare.requestId);
  assert.deepEqual(Buffer.concat(await Promise.all(chunks(f).map(async request => Buffer.from(await request.options.body.arrayBuffer())))), data);
  assert.deepEqual(JSON.parse(submissions(f)[0].options.body), { requestId: prepare.requestId, text: 'first file', attachmentIds: [attachment] });
});

test('new chat refreshes stale capabilities before the first upload and preserves original bytes in legacy serial chunks', async () => {
  let active = 0, maximum = 0;
  const f = await fixture((url, options) => {
    if (url.endsWith('/capabilities')) return response(200, { imageUpload: true, imageChunkBytes: 131072, uploadConcurrency: 1, maxImageBytes: 20 * 1024 * 1024 });
    if (url.includes('/chunks/')) return new Promise(resolve => { active++; maximum = Math.max(maximum, active); setImmediate(() => { active--; resolve(response()); }); });
  });
  const data = randomBytes(262144); f.seed(data); f.run('imageChunkBytes=524288;uploadConcurrency=2'); await f.submit();
  assert.equal(maximum, 1); assert.equal(chunks(f).length, 2);
  for (const request of chunks(f)) assert.ok(request.options.body.size <= 131072);
  assert.deepEqual(Buffer.concat(await Promise.all(chunks(f).map(async request => Buffer.from(await request.options.body.arrayBuffer())))), data);
  const capIndex = f.requests.findIndex(request => request.url.endsWith('/capabilities'));
  assert.ok(capIndex >= 0 && capIndex < f.requests.findIndex(request => request.url.endsWith('/uploads')));
  assert.equal(submissions(f).length, 1);
});

test('new chat aborts a failed upload sibling and a manual retry retains its prepared creation identity', async () => {
  let failing = true, siblingAborted = false;
  const f = await fixture((url, options) => {
    if (!failing) return;
    if (url.endsWith('/chunks/0')) return new Promise(resolve => setImmediate(() => resolve(response(503))));
    if (url.endsWith('/chunks/1')) return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => { siblingAborted = true; reject(new Error('aborted')); }, { once: true }));
  });
  f.seed(randomBytes(2 * 524288)); await f.submit(); await tick();
  assert.equal(siblingAborted, true); assert.equal(submissions(f).length, 0);
  assert.equal(f.requests.some(request => request.url.endsWith('/finish')), false);
  const requestId = f.run('newDraft.requestId'); assert.equal(f.run('newDraft.prepared.threadId'), thread);
  assert.equal(f.run('newDraft.pending'), false); assert.equal(f.run('newDraft.uncertain'), false);
  assert.ok(f.requests.some(request => request.options.method === 'DELETE' && request.options.headers['x-creation-id'] === requestId));
  failing = false; await f.submit();
  assert.equal(f.requests.filter(request => request.url === '/api/chats/prepare').length, 1);
  assert.equal(JSON.parse(submissions(f)[0].options.body).requestId, requestId);
});

for (const path of ['/api/chats/prepare', '/api/chats/submit']) test(`${path} explicit not-dispatched stays retryable`, async () => {
  let reject = true;
  const f = await fixture(url => url === path && reject ? response(409, { error: 'not-dispatched' }) : undefined);
  f.seed(Buffer.from('file')); await f.submit();
  assert.equal(f.run('newDraft.uncertain'), false);
  assert.match(f.run('newDraft.message'), /稍后重试/);
  reject = false; await f.submit();
  assert.equal(f.run('newDraft'), null);
});

test('text-only creation with explicit not-dispatched stays retryable', async () => {
  let reject = true;
  const f = await fixture(url => url === '/api/chats' ? (reject ? response(409, { error: 'not-dispatched' }) : response(202, { threadId: thread })) : undefined);
  await f.submit(); assert.equal(f.run('newDraft.uncertain'), false); assert.match(f.run('newDraft.message'), /稍后重试/);
  reject = false; await f.submit(); assert.equal(f.run('newDraft'), null);
});

test('new chat skips later compression after an ineffective first chunk without changing bytes', async () => {
  const f = await fixture(url => url.endsWith('/capabilities') ? response(200, { imageUpload: true, imageChunkBytes: 131072, uploadConcurrency: 1, maxImageBytes: 20 * 1024 * 1024, uploadCompression: 'gzip' }) : undefined, { compression: true });
  const data = randomBytes(3 * 131072); f.seed(data); await f.submit();
  assert.equal(f.compressionCalls.length, 1); assert.equal(chunks(f).length, 3);
  assert.ok(chunks(f).every(request => !request.options.headers['content-encoding']));
  assert.deepEqual(Buffer.concat(await Promise.all(chunks(f).map(async request => Buffer.from(await request.options.body.arrayBuffer())))), data);
});

test('new chat does not dispatch prepared uploads with a different device after capability refresh', async () => {
  let release;
  const f = await fixture(url => url.endsWith('/capabilities') ? new Promise(resolve => { release = resolve; }) : undefined);
  f.seed(Buffer.from('scope test')); const pending = f.submit(); await until(() => Boolean(release));
  f.run("currentDeviceId='other-device';historyScopeGeneration++");
  release(response(200, { imageUpload: true, imageChunkBytes: 524288, uploadConcurrency: 2, maxImageBytes: 20 * 1024 * 1024 })); await pending;
  assert.equal(f.requests.some(request => request.url.includes('/uploads')), false); assert.equal(submissions(f).length, 0);
});

test('new chat resumes only missing attachment indices and submits the preserved staged order', async () => {
  const f = await fixture(); f.seed(Buffer.from('second original'));
  f.run(`newDraft.attachments.unshift({file:Object.assign(new Blob(['already staged']),{name:'first.bin'}),kind:'file',previewPromise:Promise.resolve()});newDraft.requestId='44444444-4444-4444-8444-444444444444';newDraft.prepared={threadId:'${thread}',uploaded:['55555555-5555-4555-8555-555555555555']};`);
  await f.submit();
  assert.equal(f.requests.some(request => request.url === '/api/chats/prepare'), false);
  const started = f.requests.filter(request => request.url.endsWith('/uploads') && request.options.method === 'POST'); assert.equal(started.length, 1);
  assert.equal(JSON.parse(started[0].options.body).name, 'original.bin');
  assert.deepEqual(JSON.parse(submissions(f)[0].options.body), { requestId: '44444444-4444-4444-8444-444444444444', text: 'first file', attachmentIds: ['55555555-5555-4555-8555-555555555555', attachment] });
});
