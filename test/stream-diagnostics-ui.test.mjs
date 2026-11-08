import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { webcrypto } from 'node:crypto';
import { StateChunkAssembler, encodeStateChunks } from '../public/state-chunks.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const streamId = '22222222-2222-4222-8222-222222222222';
const tick = () => new Promise(resolve => setImmediate(resolve));
const jsonResponse = value => ({ ok: true, status: 200, json: async () => value });
async function fixture({ legacyHeaders = false } = {}) {
  class Element {
    constructor() { this.children = []; this.listeners = {}; this.dataset = {}; this.value = ''; this.style = {}; this.classList = { toggle() {}, contains() { return false; } }; this.scrollHeight = 300; this.clientHeight = 500; this.scrollTop = 0; }
    addEventListener(type, fn) { this.listeners[type] = fn; } append(...nodes) { this.children.push(...nodes); } replaceChildren(...nodes) { this.children = nodes; } get childNodes() { return this.children; } setAttribute() {} after() {} before() {}
    querySelectorAll(selector) { return this.children.flatMap(node => [...(selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1)) ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    cloneNode() { const copy = new Element(); copy.value = this.value; copy.textContent = this.textContent; return copy; }
  }
  const nodes = new Map(), timers = new Map(), streams = [], requests = [];
  let now = 0;
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement() { return new Element(); }, createDocumentFragment() { return new Element(); } };
  const context = vm.createContext({ document, testChunkModule: { StateChunkAssembler }, crypto: webcrypto, AbortController, URLSearchParams, TextDecoder, TextEncoder, Date, performance: { now: () => now },
    setTimeout(fn, ms) { const token = { unref() {} }; timers.set(token, { fn, ms }); return token; }, clearTimeout(token) { timers.delete(token); },
    localStorage: { getItem() { return null; }, removeItem() {} }, sessionStorage: { removeItem() {} }, window: { addEventListener() {} },
    store: { read: async () => null }, fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (!url.endsWith('/events')) return jsonResponse({ projects: [], recent: [] });
      let release;
      const stream = { response: { ok: true, status: 200, ...(legacyHeaders ? {} : { headers: { get: () => streamId } }), body: { getReader: () => ({ read: () => new Promise(resolve => { release = resolve; }) }) } },
        send(text) { const resolve = release; release = null; assert.ok(resolve, 'reader is waiting'); resolve({ value: new TextEncoder().encode(text), done: false }); },
        end() { release?.({ done: true }); }, signal: options.signal };
      streams.push(stream); return stream.response;
    } });
  let source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  source = source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)')
    .replaceAll("await import('/state-chunks.mjs')", 'await Promise.resolve(testChunkModule)');
  const run = code => vm.runInContext(code, context);
  run(source); await tick();
  run(`selectedId='${id}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};loadThreads=async()=>{};`);
  const snapshot = () => JSON.parse(JSON.stringify(run('connectionDiagnosticsSnapshot()')));
  const fire = ms => { const entry = [...timers.entries()].find(([, timer]) => timer.ms === ms); assert.ok(entry, `timer ${ms}`); timers.delete(entry[0]); entry[1].fn(); };
  return { run, streams, requests, snapshot, fire, advance(ms) { now += ms; }, cleanup() { run('active?.abort();clearTimeout(reconnectTimer);'); timers.clear(); for (const stream of streams) stream.end(); } };
}
const state = seq => ({ seq, conversation: { id, title: 'PRIVATE TITLE', model: 'model', reasoningEffort: 'high', runtimeStatus: 'idle', turns: [], requests: [], history: { complete: true } } });
const event = (type, value) => `event: ${type}\ndata: ${JSON.stringify(value)}\n\n`;

test('selection timing includes debounce and distinguishes history drafting from live attachment', async () => {
  const f = await fixture();
  try {
    f.run(`renderTask({id:selectedId,title:'PRIVATE TITLE'}).listeners.click()`);
    f.advance(220); f.fire(220); await tick();
    let row = f.snapshot().at(-1);
    assert.equal(row.milestones.fetch, 220);
    assert.equal(row.streamId, streamId);
    assert.equal(row.milestones.connected, undefined);
    f.advance(15); f.streams[0].send(event('history', state(1))); await tick();
    row = f.snapshot().at(-1);
    assert.equal(row.milestones['first-bytes'], 235);
    assert.equal(row.milestones['first-state'], undefined);
    assert.equal(row.milestones.connected, undefined);
    f.advance(30); f.streams[0].send(event('state', state(1))); await tick();
    row = f.snapshot().at(-1);
    assert.equal(row.milestones.connected, 265);
    assert.equal(row.milestones['handle-start'], 265);
    assert.equal(row.milestones['handle-end'], 265);
    assert.ok(Object.hasOwn(row.milestones, 'input-enabled'));
    const copy = f.run('connectionDiagnosticsSnapshot()'); copy[0].milestones.connected = -1;
    assert.equal(f.snapshot()[0].milestones.connected, 265);
    assert.doesNotMatch(JSON.stringify(row), /PRIVATE|device|host|conversation|threadId/);
  } finally { f.cleanup(); }
});

test('rapid task clicks close superseded debounce attempts and open only the final stream', async () => {
  const f = await fixture();
  try {
    f.run("renderTask({id:selectedId}).listeners.click()");
    f.advance(40);
    f.run("renderTask({id:'44444444-4444-4444-8444-444444444444'}).listeners.click()");
    assert.equal(f.snapshot()[0].outcome, 'superseded');
    assert.equal(f.snapshot()[0].milestones.fetch, undefined);
    f.advance(220); f.fire(220); await tick();
    assert.equal(f.streams.length, 1);
    assert.equal(f.snapshot()[1].milestones.fetch, 220);
    f.run("renderTask({id:selectedId}).listeners.click()");
    assert.equal(f.snapshot().length, 2, 'clicking the active selected task does not create an attempt');
  } finally { f.cleanup(); }
});

test('cancelled fetches and reconnects cannot contaminate a newer attempt; old relay headers are optional', async () => {
  const f = await fixture({ legacyHeaders: true });
  try {
    f.run('void connect(selectedId)'); await tick();
    f.run('void connect(selectedId)'); await tick();
    f.streams[0].send(event('state', state(1))); await tick();
    assert.equal(f.snapshot()[0].outcome, 'cancelled');
    assert.equal(f.snapshot()[0].milestones.connected, undefined);
    assert.equal(f.snapshot()[1].milestones.connected, undefined);
    f.streams[1].end(); await tick();
    assert.equal(f.snapshot()[1].outcome, 'disconnected');
    f.fire(500); await tick();
    assert.equal(f.snapshot()[2].trigger, 'reconnect');
    assert.equal(f.snapshot()[2].streamId, undefined);
    f.streams[2].send(event('state', state(1))); await tick();
    assert.ok(Object.hasOwn(f.snapshot()[2].milestones, 'connected'));
    for (let i = 0; i < 40; i++) f.run("beginConnectionDiagnostic('direct').close('cancelled')");
    assert.equal(f.snapshot().length, 32);
    assert.ok(f.snapshot().every(row => Object.keys(row.milestones).length <= 14));
  } finally { f.cleanup(); }
});

test('chunked states become connected only after complete validated assembly', async () => {
  const f = await fixture();
  try {
    f.run('void connect(selectedId)'); await tick();
    const frames = [];
    for await (const frame of encodeStateChunks({ event: 'state', data: state(1) }, { transferId: 'private-transfer', generation: 1, seq: 1, chunkBytes: 64 })) frames.push(frame);
    for (const frame of frames.slice(0, -1)) {
      f.advance(1); f.streams[0].send(event('state-chunk', frame)); await tick();
    }
    assert.equal(f.snapshot()[0].milestones.connected, undefined);
    f.advance(1); f.streams[0].send(event('state-chunk', frames.at(-1)));
    for (let i = 0; i < 10 && f.snapshot()[0].milestones.connected === undefined; i++) await tick();
    const row = f.snapshot()[0];
    assert.ok(row.milestones['chunk-end'] >= row.milestones['chunk-begin']);
    assert.ok(row.milestones.connected >= row.milestones['chunk-end']);
    assert.doesNotMatch(JSON.stringify(row), /private-transfer|PRIVATE/);
  } finally { f.cleanup(); }
});
