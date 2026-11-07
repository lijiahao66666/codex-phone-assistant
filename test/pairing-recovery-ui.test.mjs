import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../public/desktop.js', import.meta.url), 'utf8');
const a = '11111111-1111-4111-8111-111111111111';
const b = '22222222-2222-4222-8222-222222222222';
const c = '33333333-3333-4333-8333-333333333333';
const flush = () => new Promise(resolve => setImmediate(resolve));

async function fixture() {
  class Element {
    constructor() { this.hidden = true; this.children = []; this.dataset = {}; this.listeners = {}; this.value = ''; this.classList = { toggle() {}, contains() { return false; } }; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    setAttribute() {} append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    get childNodes() { return this.children; }
    querySelectorAll() { return []; }
    focus() { this.focused = true; }
  }
  const nodes = new Map(), timers = new Map(), listeners = new Map(), requests = [];
  const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); }, createElement() { return new Element(); }, createDocumentFragment() { return new Element(); } };
  let state = { state: 'replaced', activeDeviceId: b }, restoreCode = 200, statusCode = 200, pendingRestore, delayRestore = false;
  const window = { pairingReady: Promise.resolve('replaced'), pairingConflictState: { activeDeviceId: b }, addEventListener(type, fn) { listeners.set(type, fn); } };
  const context = vm.createContext({ document, AbortController, TextDecoder, sessionStorage: { removeItem() {} }, window,
    setTimeout(fn, ms) { const timer = { fn, ms, unref() {} }; timers.set(timer, timer); return timer; }, clearTimeout(timer) { timers.delete(timer); },
    fetch: async (url, options = {}) => {
      requests.push({ url, options });
      if (url === '/api/pairing/status') return Response.json(state, { status: statusCode });
      if (url === '/api/pairing/restore') {
        if (delayRestore) await new Promise(resolve => { pendingRestore = resolve; });
        if (restoreCode === 200) state = { state: 'active', activeDeviceId: a };
        return Response.json(restoreCode === 409 ? { error: 'pairing-changed' } : {}, { status: restoreCode });
      }
      if (url === '/api/host-status') return Response.json(state.state === 'active' ? { online: true } : { error: 'device-replaced', activeDeviceId: state.activeDeviceId }, { status: state.state === 'active' ? 200 : 401 });
      return Response.json({ projects: [], recent: [] });
    } });
  vm.runInContext(source, context);
  // Home rendering has its own tests; observe whether recovery restarts it.
  vm.runInContext('let pairedStarts=0; startPairedHome=async()=>{pairingAvailable=true;pairedStarts++}', context);
  await flush();
  return { context, nodes, timers, listeners, requests, run: code => vm.runInContext(code, context),
    setState(value) { state = value; }, setRestoreCode(value) { restoreCode = value; }, setStatusCode(value) { statusCode = value; },
    holdRestore() { delayRestore = true; }, releaseRestore() { pendingRestore(); },
    dispose() { listeners.get('pagehide')(); } };
}

test('replacement dialog dismisses without takeover, reopens manually and restores only on click', async () => {
  const f = await fixture();
  try {
    const dialog = f.nodes.get('#pairing-conflict');
    assert.equal(dialog.hidden, false);
    assert.equal(f.run('pairingAvailable'), false);
    assert.equal(f.nodes.get('#unpaired-control').textContent, '配对已切换 · 恢复本机');
    f.nodes.get('#pairing-conflict-dismiss').listeners.click();
    await f.run('refreshPairingStatus()');
    assert.equal(dialog.hidden, true);
    assert.equal(f.requests.some(r => r.url.endsWith('/restore')), false);
    assert.equal(f.run('window.showPairingRecovery()'), true);
    assert.equal(dialog.hidden, false);
    f.holdRestore();
    const restore = f.nodes.get('#pairing-conflict-restore').listeners.click();
    await flush();
    f.nodes.get('#pairing-conflict-dismiss').listeners.click();
    f.run('window.showPairingRecovery()');
    await f.nodes.get('#pairing-conflict-restore').listeners.click();
    assert.equal(f.requests.filter(r => r.url.endsWith('/restore')).length, 1);
    f.releaseRestore(); await restore; await flush();
    assert.deepEqual(JSON.parse(f.requests.find(r => r.url.endsWith('/restore')).options.body), { expectedActiveDeviceId: b });
    assert.equal(dialog.hidden, true);
    assert.equal(f.run('pairedStarts'), 1);
    // When the other phone restores again, show the same dialog again.
    f.setState({ state: 'replaced', activeDeviceId: b });
    await f.run('refreshPairingStatus()');
    assert.equal(dialog.hidden, false);
  } finally { f.dispose(); }
});

test('stale restore asks for another click, network errors allow retry, revoked credentials require pairing', async () => {
  const f = await fixture();
  try {
    f.setState({ state: 'replaced', activeDeviceId: c });
    f.setRestoreCode(409);
    await f.nodes.get('#pairing-conflict-restore').listeners.click(); await flush();
    assert.equal(f.nodes.get('#pairing-conflict').hidden, false);
    assert.equal(f.run('replacedActiveDeviceId'), c);
    assert.equal(f.requests.filter(r => r.url.endsWith('/restore')).length, 1);
    f.setRestoreCode(503);
    await f.nodes.get('#pairing-conflict-restore').listeners.click();
    assert.equal(f.nodes.get('#pairing-conflict-restore').disabled, false);
    assert.match(f.nodes.get('#pairing-conflict-error').textContent, /恢复失败/);
    assert.deepEqual(JSON.parse(f.requests.filter(r => r.url.endsWith('/restore'))[1].options.body), { expectedActiveDeviceId: c });
    f.setRestoreCode(401);
    await f.nodes.get('#pairing-conflict-restore').listeners.click();
    assert.equal(f.nodes.get('#pairing-conflict').hidden, true);
    assert.equal(f.run('window.showPairingRecovery()'), false);
  } finally { f.dispose(); }
});

test('background page stops polling and foreground checks which phone is active', async () => {
  const f = await fixture();
  try {
    assert.ok([...f.timers.values()].some(t => t.ms === 4000));
    f.listeners.get('pagehide')();
    assert.equal(f.timers.size, 0);
    const count = f.requests.length;
    await f.run('refreshPairingStatus()');
    assert.equal(f.requests.length, count);
    f.listeners.get('pageshow')({ persisted: true }); await flush();
    assert.ok(f.requests.length > count);
    assert.equal(f.nodes.get('#pairing-conflict').hidden, false);
    f.setStatusCode(401);
    await f.run('refreshPairingStatus()');
    assert.equal(f.run('pairingWasReplaced'), false);
    assert.equal(f.nodes.get('#pairing-conflict').hidden, true);
  } finally { f.dispose(); }
});
