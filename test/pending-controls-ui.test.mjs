import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

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
    addEventListener(type, listener) { this.listeners[type] = listener; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name]; }
    querySelectorAll(selector) { return descendants(this).slice(1).filter(node => selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1))); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    after() {} before() {}
  }
  const nodes = new Map(), requests = [];
  const store = { read: async () => null, reserve: async () => true, remove: async () => true };
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement: () => new Element(), createDocumentFragment: () => new Element() };
  const context = vm.createContext({ document, store, AbortController, URLSearchParams, TextDecoder, Date, setTimeout, clearTimeout,
    localStorage: { getItem() { return null; } }, sessionStorage: { removeItem() {} }, window: { addEventListener() {} },
    fetch: async (url, options = {}) => { requests.push({ url, options }); return await handler?.(url, options) || response({ projects: [], recent: [] }); } });
  let source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
  source = source.replace("import('/recovery-attempt-store.js').then(module => module.createRecoveryAttemptStore())", 'Promise.resolve(store)');
  const run = code => vm.runInContext(code, context);
  run(source); await tick();
  run(`selectedId='${threadId}';currentDeviceId='device';historyScope={hostId:'host',deviceId:'device'};connected=true;loadThreads=async()=>{};recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'clear'});recoveryChecks.set(recoveryKey(currentDeviceId,selectedId),{status:'ready'});`);
  return { nodes, requests, run, show(view, live = true) { run(`showState(${JSON.stringify({ id: threadId, runtimeStatus: 'idle', requests: [], turns: [], history: { complete: true }, ...view })},${live})`); }, find(selector) { return [...nodes.values(), run('questionPanel')].flatMap(descendants).find(node => selector.startsWith('.') && String(node.className || '').split(/\s+/).includes(selector.slice(1))); } };
}

test('live approval submits one decision while pending and history never exposes its buttons', async () => {
  let release;
  const f = await fixture(url => url.endsWith('/approvals') ? new Promise(resolve => { release = () => resolve(response()); }) : undefined);
  const view = { requests: [{ id: 'approval', kind: 'command', command: 'echo isolated' }] };
  f.show(view, false);
  assert.equal(f.find('.approval-accept'), undefined);
  f.show(view);
  const accept = f.find('.approval-accept'), decline = f.find('.approval-decline');
  const work = accept.listeners.click();
  await decline.listeners.click(); await accept.listeners.click();
  assert.equal(f.requests.filter(request => request.url.endsWith('/approvals')).length, 1);
  assert.equal(accept.disabled, true); assert.equal(decline.disabled, true);
  release(); await work;
  assert.deepEqual(JSON.parse(f.requests.find(request => request.url.endsWith('/approvals')).options.body), { requestId: 'approval', kind: 'command', decision: 'accept' });
  f.show(view); assert.equal(f.find('.approval-accept'), undefined);
});

for (const kind of ['userInput', 'async']) {
  test(`${kind} questions validate all answers and preserve uncertain submission across rerenders`, async () => {
    const endpoint = kind === 'async' ? '/async-question' : '/user-input';
    const f = await fixture(url => url.endsWith(endpoint) ? Promise.reject(new TypeError('isolated network failure')) : undefined);
    const questions = [{ id: 'question', question: 'Choose a path', options: [] }];
    const view = kind === 'async'
      ? { turns: [{ id: 'turn', status: 'completed', items: [{ id: 'question-item', type: 'agentMessage', text: 'Choose a path', questions }] }] }
      : { requests: [{ id: 'question-item', kind: 'userInput', questions }] };
    f.show(view);
    let form = f.find('.user-input-form');
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.some(request => request.url.endsWith(endpoint)), false);
    assert.ok(descendants(form).some(node => node.textContent === '请回答所有问题'));
    const input = f.find('.user-input-text'); input.value = 'answer'; input.listeners.input();
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.filter(request => request.url.endsWith(endpoint)).length, 1);
    assert.deepEqual(JSON.parse(f.requests.find(request => request.url.endsWith(endpoint)).options.body), { requestId: 'question-item', answers: { question: 'answer' } });
    f.show(view); form = f.find('.user-input-form');
    assert.equal(f.find('.approval-accept').disabled, true);
    assert.ok(descendants(form).some(node => node.textContent === '结果暂不确定，请查看电脑上的任务状态'));
    await form.listeners.submit({ preventDefault() {} });
    assert.equal(f.requests.filter(request => request.url.endsWith(endpoint)).length, 1);
    f.show({ requests: [], turns: [] }); assert.equal(f.run('questionPanel.hidden'), true);
  });
}

test('recovery uncertainty prevents approval and question actions from dispatching writes', async () => {
  const f = await fixture();
  f.show({ requests: [{ id: 'approval', kind: 'file' }, { id: 'input', kind: 'userInput', questions: [{ id: 'q', question: 'Answer', options: [] }] }] });
  f.run("recoveries.set(recoveryKey(currentDeviceId,selectedId),{status:'unknown',requestId:'old'});updateComposer()");
  await f.find('.approval-accept').listeners.click();
  const input = f.find('.user-input-text'); input.value = 'answer'; input.listeners.input();
  await f.find('.user-input-form').listeners.submit({ preventDefault() {} });
  assert.equal(f.requests.some(request => request.url.endsWith('/approvals') || request.url.endsWith('/user-input')), false);
});
