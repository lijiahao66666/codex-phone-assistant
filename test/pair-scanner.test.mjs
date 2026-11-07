import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../public/pair.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
function fixture() {
  class Element {
    constructor() { this.hidden = true; this.listeners = {}; this.value = ''; this.readyState = 2; this.videoWidth = 640; this.videoHeight = 480; }
    addEventListener(type, fn) { this.listeners[type] = fn; }
    focus() { this.focused = true; } blur() { this.focused = false; }
    async play() {}
    getContext() { return { drawImage() {}, getImageData() { return { data: [], width: 640, height: 480 }; } }; }
  }
  const nodes = new Map(), events = new Map(), frames = new Map(), timers = new Map(), requests = [];
  let cameraResolve, cameraReject, trackStops = 0, decoded = null, redirected;
  const stream = { getTracks: () => [{ stop() { trackStops++; } }] };
  const context = vm.createContext({ URL, URLSearchParams, document: { querySelector(key) { if (!nodes.has(key)) nodes.set(key, new Element()); return nodes.get(key); } },
    location: { hash: '', pathname: '/', origin: 'https://phone.test', assign(path) { redirected = path; } },
    window: { history: { replaceState() {} }, addEventListener(type, fn) { events.set(type, fn); } },
    navigator: { mediaDevices: { getUserMedia: () => new Promise((resolve, reject) => { cameraResolve = resolve; cameraReject = reject; }) } },
    jsQR: () => decoded,
    requestAnimationFrame(fn) { const id = Symbol(); frames.set(id, fn); return id; }, cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn) { const id = Symbol(); timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options }); return Response.json({}, { status: url === '/api/host-status' ? 401 : 200 }); },
  });
  vm.runInContext(source, context);
  return { nodes, events, frames, timers, requests, get trackStops() { return trackStops; }, get redirected() { return redirected; },
    open() { return nodes.get('#scan').listeners.click(); }, resolve() { cameraResolve(stream); }, reject() { cameraReject({ name: 'NotAllowedError' }); },
    decode(value) { decoded = value; }, tick() { const [id, fn] = frames.entries().next().value; frames.delete(id); fn(); } };
}

test('scanner opens immediately and closing during camera permission stops a late stream', async () => {
  const f = fixture(), opening = f.open();
  assert.equal(f.nodes.get('#scanner').hidden, false);
  assert.equal(f.nodes.get('#scan-status').textContent, '正在打开相机…');
  f.nodes.get('#stop-scan').listeners.click();
  assert.equal(f.nodes.get('#scanner').hidden, true);
  f.resolve(); await opening;
  assert.equal(f.trackStops, 1);
  assert.equal(f.nodes.get('#camera').srcObject, null);
  assert.equal(f.frames.size, 0);
});

test('manual input, Escape and pagehide release camera and frame timers', async () => {
  for (const action of ['manual', 'escape', 'pagehide']) {
    const f = fixture(), opening = f.open(); f.resolve(); await opening;
    assert.equal(f.frames.size, 1); assert.equal(f.timers.size, 1);
    if (action === 'manual') f.nodes.get('#scan-manual').listeners.click();
    if (action === 'escape') f.events.get('keydown')({ key: 'Escape' });
    if (action === 'pagehide') f.events.get('pagehide')();
    assert.equal(f.nodes.get('#scanner').hidden, true);
    assert.equal(f.trackStops, 1); assert.equal(f.frames.size, 0); assert.equal(f.timers.size, 0);
    if (action === 'manual') assert.equal(f.nodes.get('#code').focused, true);
  }
});

test('wrong QR is explained in fullscreen and a valid QR stops scanning before pairing', async () => {
  const f = fixture(), opening = f.open(); f.resolve(); await opening;
  f.decode({ data: 'https://other.test/pair#token=' + 'q'.repeat(43) }); f.tick();
  assert.equal(f.nodes.get('#scan-status').textContent, '二维码不是此服务的配对码');
  assert.equal(f.requests.filter(r => r.url === '/api/pair').length, 0);
  f.decode({ data: 'https://phone.test/pair#token=' + 'q'.repeat(43) }); f.tick(); await flush();
  assert.equal(f.nodes.get('#scanner').hidden, true);
  assert.equal(f.trackStops, 1);
  assert.deepEqual(JSON.parse(f.requests.find(r => r.url === '/api/pair').options.body), { qrToken: 'q'.repeat(43) });
  assert.equal(f.redirected, '/');
});

test('permission refusal returns to the pairing form with a usable retry', async () => {
  const f = fixture(), opening = f.open(); f.reject(); await opening;
  assert.equal(f.nodes.get('#scanner').hidden, true);
  assert.equal(f.nodes.get('#scan').disabled, false);
  assert.match(f.nodes.get('#pair-error').textContent, /相机权限未开启/);
});
