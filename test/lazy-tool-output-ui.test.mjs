import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash, webcrypto } from 'node:crypto';

const threadId = '11111111-1111-4111-8111-111111111111';
const tick = () => new Promise(resolve => setImmediate(resolve));
const response = (value = {}, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => value });
const descendants = node => [node, ...node.children.flatMap(descendants)];
async function fixture(handler) {
  class Element {
    constructor() { this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.style = {}; this.attributes = {}; this.classList = { toggle() {}, contains() { return false; } }; }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get childNodes() { return this.children; }
    addEventListener(type, listener) { const old = this.listeners[type]; this.listeners[type] = old ? (...args) => { old(...args); return listener(...args); } : listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    querySelectorAll(selector) { return descendants(this).slice(1).filter(node => selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    after() {} before() {}
  }
  const nodes = new Map(), requests = [];
  const store = { read: async () => null, reserve: async () => true, remove: async () => true };
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement: () => new Element(), createDocumentFragment: () => new Element() };
  const context = vm.createContext({ document, store, AbortController, URLSearchParams, TextDecoder, TextEncoder, Uint8Array, crypto: webcrypto, Date, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } }, sessionStorage: { removeItem() {} }, window: { addEventListener() {} },
    fetch: async (url, options = {}) => { requests.push({ url, options }); return await handler?.(url, options) || response({ projects: [], recent: [] }); } });
  let source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  source = source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)');
  const run = code => vm.runInContext(code, context);
  run(source); await tick();
  run(`selectedId='${threadId}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=true;loadThreads=async()=>{};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});`);
  return { nodes, requests, run, all(selector) { return [...nodes.values()].flatMap(descendants).filter(node => String(node.className || '').split(/\s+/).includes(selector.slice(1))); }, show(view, live = true) { run(`showState(${JSON.stringify({ id: threadId, runtimeStatus: 'idle', requests: [], turns: [], history: { complete: true }, ...view })},${live})`); }, find(selector) { return [...nodes.values(), run('questionPanel')].flatMap(descendants).find(node => selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1))); } };
}

const hashOf = text => createHash('sha256').update(text).digest('hex');
const second = ' second'.repeat(600), full = 'first' + second, fresh = 'fresh output'.repeat(500), final = ' final'.repeat(700);
const hash = hashOf(full), nextHash = hashOf(fresh);
const view = (value = hash, bytes = Buffer.byteLength(value === nextHash ? fresh : full)) => ({ turns: [{ id: 'turn', viewKey: 'stable-turn', status: 'inProgress', items: [{ id: 'cmd', type: 'commandExecution', command: 'echo large', status: 'completed', outputRef: { hash: value, bytes } }] }] });
const page = (request, text, nextOffset = null) => {
  const params = new URL(request, 'http://test').searchParams;
  return response({ threadId, turnKey: params.get('turn'), itemId: params.get('item'), hash: params.get('hash'), offset: Number(params.get('offset')), text, nextOffset });
};
const outputRequests = f => f.requests.filter(request => request.url.includes('/tool-output?'));
const open = f => { const details = f.find('.command-details'); details.open = true; details.listeners.toggle(); return details; };

test('large output loads only on expansion, pages on demand and survives rerenders', async () => {
  const f = await fixture(url => url.includes('/tool-output?') ? page(url, new URL(url, 'http://test').searchParams.get('offset') === '0' ? 'first' : second, new URL(url, 'http://test').searchParams.get('offset') === '0' ? 5 : null) : undefined);
  f.show(view());
  assert.equal(outputRequests(f).length, 0);
  assert.match(f.find('.command-output-status').textContent, /展开后加载/);
  open(f); await tick();
  assert.equal(outputRequests(f).length, 1);
  assert.equal(outputRequests(f)[0].options.headers['x-codex-expected-device'], 'device');
  assert.equal(f.find('.command-output-text').textContent, 'first');
  f.show(view());
  assert.equal(f.find('.command-details').open, true);
  assert.equal(outputRequests(f).length, 1);
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, full);
  assert.equal(f.find('.command-output-more'), undefined);
  assert.equal(outputRequests(f).length, 2);
  assert.match(outputRequests(f)[1].url, /offset=5/);
});

test('hash change aborts old load and never renders the old page', async () => {
  let release;
  const f = await fixture(url => url.includes('/tool-output?') ? new URL(url, 'http://test').searchParams.get('hash') === hash ? new Promise(resolve => { release = () => resolve(page(url, 'old output')); }) : page(url, fresh) : undefined);
  f.show(view()); open(f); await tick();
  const oldSignal = outputRequests(f)[0].options.signal;
  f.show(view(nextHash)); await tick();
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.find('.command-output-text'), undefined);
  assert.equal(outputRequests(f).length, 1);
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, fresh);
  release(); await tick();
  assert.equal(f.find('.command-output-text').textContent, fresh);
});

for (const change of ['task', 'device']) test(`${change} switch aborts loading and ignores a delayed response`, async () => {
  let release;
  const f = await fixture(url => url.includes('/tool-output?') ? new Promise(resolve => { release = () => resolve(page(url, 'must not appear')); }) : undefined);
  f.show(view()); open(f); await tick();
  const oldHolder = f.find('.command-output');
  if (change === 'task') f.run("selectedId='other';clearConversation()");
  else f.run("resetHistoryScope();currentDeviceId='other';historyScope={hostId:'host',deviceId:'other'}");
  assert.equal(outputRequests(f)[0].options.signal.aborted, true);
  release(); await tick();
  assert.equal(descendants(oldHolder).some(node => node.textContent === 'must not appear'), false);
  assert.equal(f.run('toolOutputEntries.size'), 0);
});

test('failed and malformed pages preserve the loaded prefix and retry the same offset', async () => {
  let attempt = 0;
  const f = await fixture(url => {
    if (!url.includes('/tool-output?')) return;
    attempt++;
    if (attempt === 1) return response({}, 503);
    if (attempt === 2) return page(url, 'prefix', 6);
    if (attempt === 3) return page(url, 'wrong', 40);
    return page(url, final);
  });
  f.show(view(hashOf('prefix' + final), Buffer.byteLength('prefix' + final))); open(f); await tick();
  assert.match(f.find('.command-output-status').textContent, /加载失败/);
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, 'prefix');
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, 'prefix');
  assert.equal(f.find('.command-output-more').textContent, '重试加载');
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, 'prefix' + final);
  assert.deepEqual(outputRequests(f).map(request => new URL(request.url, 'http://test').searchParams.get('offset')), ['0', '0', '6', '6']);
});

test('history and ambiguous references never fetch output; inline history output remains visible', async () => {
  const f = await fixture();
  f.show(view(), false); open(f); await tick();
  assert.equal(outputRequests(f).length, 0);
  assert.match(f.find('.command-output').children[0].textContent, /连接电脑/);
  f.show({ turns: [{ id: 'turn', status: 'completed', items: [{ id: 'cmd', type: 'commandExecution', command: 'echo old', output: 'recorded output' }] }] }, false);
  assert.ok(f.all('.item-code').some(node => node.textContent === 'recorded output'));
  const duplicate = view(); duplicate.turns.push({ ...duplicate.turns[0] });
  f.show(duplicate); open(f); await tick();
  assert.equal(outputRequests(f).length, 0);
});

test('complete output verifies UTF-8 bytes and digest, clearing corrupted data before retry', async () => {
  let corrupt = true;
  const expected = '界'.repeat(2000);
  const f = await fixture(url => url.includes('/tool-output?') ? page(url, corrupt ? '错'.repeat(2000) : expected) : undefined);
  f.show(view(hashOf(expected), Buffer.byteLength(expected))); open(f); await tick(); await tick();
  assert.equal(f.find('.command-output-text'), undefined);
  assert.match(f.find('.command-output-status').textContent, /加载失败/);
  corrupt = false;
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, expected);
});

test('output keeps a bounded display window while all pages remain reachable and can restart', async () => {
  const limit = 2 * 1024 * 1024, whole = 'x'.repeat(limit) + 'tail';
  const f = await fixture(url => {
    if (!url.includes('/tool-output?')) return;
    const offset = Number(new URL(url, 'http://test').searchParams.get('offset'));
    const end = Math.min(whole.length, offset + 16384);
    return page(url, whole.slice(offset, end), end === whole.length ? null : end);
  });
  f.show(view(hashOf(whole), whole.length)); open(f); await tick();
  for (let pageIndex = 1; pageIndex < 129; pageIndex++) await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, 'tail');
  assert.match(f.find('.command-output-range').textContent, /2097153～2097156/);
  assert.equal(f.find('.command-output-more'), undefined);
  assert.ok(f.run('[...toolOutputEntries.values()].every(entry => entry.text.length <= toolOutputCharacterLimit)'));
  await f.find('.command-output-restart').listeners.click();
  assert.equal(f.find('.command-output-text').textContent, whole.slice(0, 16384));
  assert.equal(f.find('.command-output-range'), undefined);
  assert.match(outputRequests(f).at(-1).url, /offset=0/);
});

test('frequent output revisions do not automatically redownload while expanded', async () => {
  const f = await fixture(url => url.includes('/tool-output?') ? page(url, 'prefix', 6) : undefined);
  f.show(view()); open(f); await tick();
  for (let revision = 0; revision < 10; revision++) f.show(view(hashOf(`revision-${revision}`)));
  await tick();
  assert.equal(outputRequests(f).length, 1);
  assert.equal(f.find('.command-output-text'), undefined);
  assert.equal(f.find('.command-output-more').textContent, '重新加载输出');
});

test('a changed authoritative item rejects an old page even before its deferred render', async () => {
  let release;
  const f = await fixture(url => url.includes('/tool-output?') ? new Promise(resolve => { release = () => resolve(page(url, full)); }) : undefined);
  f.show(view()); open(f); await tick();
  f.run(`streamView=${JSON.stringify({ id: threadId, ...view(nextHash) })}`);
  release(); await tick(); await tick();
  assert.equal(f.find('.command-output-text'), undefined);
  assert.equal(f.run('[...toolOutputEntries.values()][0].text'), '');
});

test('a premature final page clears the prefix and retries from zero', async () => {
  let attempt = 0;
  const f = await fixture(url => {
    if (!url.includes('/tool-output?')) return;
    if (++attempt === 1) return page(url, 'first', 5);
    return page(url, 'short');
  });
  f.show(view()); open(f); await tick();
  await f.find('.command-output-more').listeners.click();
  assert.equal(f.find('.command-output-text'), undefined);
  assert.match(f.find('.command-output-status').textContent, /加载失败/);
  assert.equal(f.run('[...toolOutputEntries.values()][0].nextOffset'), 0);
});
