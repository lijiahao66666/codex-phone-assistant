import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {webcrypto} from 'node:crypto';
import {switchDeviceVersion} from '../public/device-version-switch.mjs';
const hostId='11111111-1111-4111-8111-111111111111', deviceId='22222222-2222-4222-8222-222222222222', a='33333333-3333-4333-8333-333333333333', b='44444444-4444-4444-8444-444444444444', c='55555555-5555-4555-8555-555555555555';
async function fixture(options = {}) {
  const nodes = new Map(), documentListeners = new Map(), windowListeners = new Map(), settingsCalls = [], presence = [], timers = new Map();
  let document;
  class Element {
    constructor(tagName = 'div') { this.tagName = tagName.toUpperCase(); this.children = []; this.listeners = {}; this.dataset = {}; this.attributes = {}; this.style = {}; this.value = ''; this.hidden = false; this.disabled = false; this.scrollHeight = 300; this.clientHeight = 500; this.scrollTop = 0; this.className = ''; this.classList = { toggle() {}, contains() { return false; } }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    append(...nodes) { for (const node of nodes) { if (node.fragment) this.append(...node.children); else { node.parent = this; this.children.push(node); } } }
    prepend(...nodes) { for (const node of nodes.reverse()) { node.parent = this; this.children.unshift(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    get childNodes() { return this.children; }
    setAttribute(name, value) { this.attributes[name] = value; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    after() {} before() {} insertBefore() {}
    querySelectorAll(selector) { return this.children.flatMap(node => [...(selector.split(',').some(part => part.trim().startsWith('.') ? node.className.split(/\s+/).includes(part.trim().slice(1)) : part.trim() === 'button' && node.tagName === 'BUTTON') ? [node] : []), ...node.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    getClientRects() { for (let node = this; node; node = node.parent) if (node.hidden) return []; return [{}]; }
    getBoundingClientRect() { return { width: 300, height: 400, top: 0, bottom: 400, left: 0, right: 300 }; }
    cloneNode() { const result = new Element(this.tagName); result.value = this.value; return result; }
    focus() { document.activeElement = this; }
    click() { return this.listeners.click?.({ preventDefault() {}, stopPropagation() {} }); }
  }
  document = { body: new Element('body'), documentElement: { inert: false }, hidden: false, activeElement: null, querySelectorAll() { return []; }, querySelector(selector) { if (!nodes.has(selector)) nodes.set(selector, new Element(selector.startsWith('#open-') || selector.startsWith('#close-') ? 'button' : 'div')); return nodes.get(selector); },
    createElement: tag => new Element(tag), createDocumentFragment() { const element = new Element(); element.fragment = true; return element; },
    addEventListener(type, fn) { if (!documentListeners.has(type)) documentListeners.set(type, []); documentListeners.get(type).push(fn); },
  };
  const window = { innerWidth: 390, innerHeight: 844, pairingReady: new Promise(() => {}),
    setNotificationSettingsOpen(value) { settingsCalls.push(value); },
    refreshNotificationPresence() { presence.push(window.getNotificationThreadId?.()); },
    addEventListener(type, fn) { windowListeners.set(type, fn); },
  };
  const context = vm.createContext({ document, window, crypto: webcrypto, AbortController, Blob, URL, TextDecoder, TextEncoder, URLSearchParams, Date, navigator: { locks: { request: async (_name, _options, run) => run({}) } }, switchModule: { switchDeviceVersion },
    location: { hash: '', replace() {} }, setTimeout(fn, ms) { const key = { unref() {} }; timers.set(key, { fn, ms }); return key; }, clearTimeout(key) { timers.delete(key); },
    localStorage: options.localStorage ?? { getItem() { return null; }, removeItem() {}, setItem() {} }, sessionStorage: { removeItem() {} }, store: { read: async () => null },
    fetch: options.fetch ?? (async () => { throw new Error('This interaction fixture must not make a network request'); }),
  });
  const source = (await readFile(new URL(`../public/h5/${options.version}/desktop.js`, import.meta.url), 'utf8')).replace(/import\('[^']*recovery-attempt-store\.js'\)\.then\(module => module\.createRecoveryAttemptStore\(\)\)/, 'Promise.resolve(store)').replace(/import\('\/h5\/v1\.0\.[12]\/device-version-switch\.mjs'\)/, 'Promise.resolve(switchModule)');
  const run = code => vm.runInContext(code, context);
  run(source);
  const settingsPanel = nodes.get('#settings-panel'), settingsOverlay = nodes.get('#settings-overlay');
  const enable = new Element('button'); enable.hidden = true; nodes.set('#notification-enable', enable);
  if (settingsPanel && settingsOverlay) { settingsPanel.append(enable); settingsOverlay.append(settingsPanel); settingsOverlay.hidden = true; }
  run(`historyScope={hostId:'${hostId}',deviceId:'${deviceId}'};currentDeviceId='${deviceId}';selectedId='${a}';scheduleVisibleStatusRefresh=()=>{};scheduleThreadConnect=()=>{};clearConversation=()=>{};beginStatusHandover=()=>{};`);
  if (options.version === 'v1.0.2' && options.unknownDesktopRead !== true) window.setDesktopNotificationReadReady({ hostId, deviceId }, false, false);
  const data = { projects: [{ id: 'fixture-project', name: 'Fixture', expanded: false, threads: [{ id: a, title: 'Task A', status: 'idle' }, { id: b, title: 'Task B', status: 'idle' }] }], recent: [{ id: c, title: 'Task C', status: 'idle' }] };
  const render = value => { context.testData = value; run('renderThreadList(testData)'); };
  render(data);
  const row = id => nodes.get('#project-list').querySelectorAll('.task').find(node => node.dataset.id === id);
  const group = () => run("projectStatusGroups.get('project:fixture-project')");
  return { run, window, document, nodes, row, group, data, render, settingsCalls, presence,
    notify: value => window.acceptTaskNotification(value),
    key(key, extra = {}) { const event = { key, preventDefault() { this.prevented = true; }, ...extra }; for (const listener of documentListeners.get('keydown') || []) listener(event); return event; },
    event(type, target) { for (const listener of documentListeners.get(type) || []) listener({ target }); },
    flushTimers(ms) { for (const [key, timer] of [...timers]) if (timer.ms === ms) { timers.delete(key); timer.fn(); } },
    visibility(hidden) { document.hidden = hidden; for (const listener of documentListeners.get('visibilitychange') || []) listener(); },
  };
}


for (const version of ['v1.0.1', 'v1.0.2']) {
  test(`${version} detects drafts, attachments, question input and unfinished writes before switching`, async () => {
    const f = await fixture({ version });
    assert.equal(f.run('versionSwitchHasWork()'), false);
    f.run(`newDraft={projectId:'p',text:'',attachments:[],pending:false,uncertain:false}`); assert.equal(f.run('versionSwitchHasWork()'), false);
    f.run(`messageInput.value='draft'`); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.run(`messageInput.value='';newDraft=null;drafts.set('${b}','draft')`); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.run(`drafts.clear();imageDrafts.set('${b}',[{}])`); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.run(`imageDrafts.clear();inputDrafts.set('x',{answers:{q:'yes'},pending:false})`); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.run(`inputDrafts.clear();submissions.set('${b}',{pending:false,uncertain:false})`); assert.equal(f.run('versionSwitchHasWork()'), false);
    f.run(`submissions.set('${b}',{uncertain:true})`); assert.equal(f.run('versionSwitchHasWork()'), true);
  });
  test(`${version} blocks unresolved recovery and checking but permits settled history state`, async () => {
    const f = await fixture({ version });
    for (const status of ['loading', 'pending', 'awaiting-state', 'unknown']) { f.run(`recoveries.set('x',{status:'${status}'})`); assert.equal(f.run('versionSwitchHasWork()'), true, status); }
    f.run(`recoveries.set('x',{status:'clear'})`); assert.equal(f.run('versionSwitchHasWork()'), false);
    f.run(`recoveryChecks.set('x',{status:'checking'})`); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.run(`recoveryChecks.set('x',{status:'ready'})`); assert.equal(f.run('versionSwitchHasWork()'), false);
  });
  test(`${version} prevents switching while IME composition or its final input is unsettled`, async () => {
    const f = await fixture({ version }); const input = f.nodes.get('#message');
    f.event('compositionstart', input); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.event('compositionend', input); assert.equal(f.run('versionSwitchHasWork()'), true);
    // A new composition on the same control must not be cleared by a late timer.
    f.event('compositionstart', input); f.flushTimers(100); assert.equal(f.run('versionSwitchHasWork()'), true);
    f.event('compositionend', input); f.flushTimers(100); assert.equal(f.run('versionSwitchHasWork()'), false);
  });
  test(`${version} freezes a foreign device switch without clearing composer content`, async () => {
    const f = await fixture({ version });
    f.run(`messageInput.value='keep this';deviceChanged()`);
    assert.equal(f.nodes.get('#message').value, 'keep this');
    assert.equal(f.run('versionScopeFrozen'), true);
    await assert.rejects(f.run(`scopedFetch('/api/threads/example',{method:'POST'})`), /scope changed/i);
  });
  test(`${version} frozen view retains all draft text and exposes local file downloads`, async () => {
    const f = await fixture({ version });
    f.run(`messageInput.value='current text'; drafts.set('${b}','other text'); imageDrafts.set('${b}',[{file:new Blob(['file content'],{type:'text/plain'}),kind:'file'}]); inputDrafts.set('q',{answers:{x:'answer'},pending:false}); deviceCreationDrafts.set('${b}',{text:'other device',attachments:[]}); deviceChanged()`);
    const panel = f.document.body.children[0];
    const strings = node => [node.textContent || '', ...node.children.flatMap(strings)];
    const found = strings(panel);
    for (const text of ['current text', 'other text', 'answer', 'other device']) assert.ok(found.includes(text), `missing ${text}`);
    const link = panel.querySelector('.version-frozen-download');
    assert.ok(link); assert.match(link.href, /^blob:/); assert.equal(link.dataset.frozenDownload, 'true');
    assert.equal(f.run('versionScopeFrozen'), true);
  });
  test(`${version} pairing guard blocks drafts and keeps the pairing dialog outside inert app`, async () => {
    const f = await fixture({ version }); const app = f.document.querySelector('.app'); app.inert = false;
    f.run(`messageInput.value='draft'`); assert.equal(f.window.versionPairGuard.begin(), false); assert.equal(app.inert, false);
    f.run(`messageInput.value=''`); assert.equal(f.window.versionPairGuard.begin(), true); assert.equal(app.inert, true);
    assert.equal(f.window.versionPairGuard.isActive(), true); f.window.versionPairGuard.end(); assert.equal(app.inert, false);
  });
  test(`${version} device button protects a draft before changing to the other version`, async () => {
    const target = { hostId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', deviceId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Other' };
    const current = { hostId, deviceId, name: 'Current' }, calls = [];
    const fetch = async (url, options = {}) => {
      calls.push({ url, options });
      if (url === '/api/devices') return { ok: true, json: async () => ({ devices: [current, target], currentDeviceId: deviceId }) };
      if (url.startsWith('/api/ui-profile?')) return { ok: true, json: async () => ({ ...target, currentDeviceId: deviceId, status: 'ready', uiProtocol: version === 'v1.0.1' ? 'v1' : 'unversioned', profileEpoch: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' }) };
      throw new Error('Unexpected network request');
    };
    const f = await fixture({ version, fetch });
    f.run(`messageInput.value='keep draft'`); await f.run('loadDevices()');
    const list = f.nodes.get('#device-list'); const choose = list.children[1].children[0]; await choose.click();
    assert.equal(calls.some(call => call.url === '/api/devices/select'), false);
    assert.equal(f.nodes.get('#message').value, 'keep draft');
    assert.match(f.nodes.get('#send-status').textContent, /草稿/);
  });
}
