import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { renderVersionPair } from '../scripts/prepare-h5-version-pair.mjs';

for (const version of ['v1.0.1', 'v1.0.2']) {
  const source = await readFile(new URL(`../public/h5/${version}/pair.js`, import.meta.url), 'utf8');
  function run(hash, pathname = `/h5/${version}/desktop.html`) {
    const nodes = new Map(), replacements = [];
    const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, { hidden: true, value: '', addEventListener() {}, focus() {}, blur() {} }); return nodes.get(key); } };
    const location = { hash, pathname, search: '', origin: 'https://phone.test', assign() {} };
    const window = { history: { replaceState(_state, _title, path) { replacements.push(path); } }, addEventListener() {} };
    vm.runInNewContext(source, { URL, URLSearchParams, document, location, window, navigator: {}, fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }), setTimeout, clearTimeout });
    return replacements;
  }
  test(`${version} pairing preserves version path and notification hash`, () => {
    assert.deepEqual(run(''), []);
    assert.deepEqual(run('#notificationHost=one&notificationDevice=two&notificationThread=three'), []);
    assert.deepEqual(run('#new'), [`/h5/${version}/desktop.html`]);
    assert.deepEqual(run('', '/pair'), ['/']);
  });
  test(`${version} pairing adaptation can be reproduced from its pinned source`, async () => {
    const original = await readFile(new URL(`../scripts/h5-shells/${version}-pair.js`, import.meta.url), 'utf8');
    assert.equal(source, renderVersionPair(original));
  });
  test(`${version} pairing guards drafts and keeps the background locked until an in-flight request settles`, async () => {
    const nodes = new Map();
    const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, { hidden: true, value: '', listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, focus() {}, blur() {} }); return nodes.get(key); } };
    let dirty = true, locked = false, release, calls = 0, navigated = false;
    const guard = { begin() { if (dirty) return false; locked = true; return true; }, end() { locked = false; }, isActive() { return locked && !dirty; } };
    const window = { versionPairGuard: guard, history: { replaceState() {} }, addEventListener() {} };
    const location = { hash: '', pathname: `/h5/${version}/desktop.html`, search: '', origin: 'https://phone.test', assign() { navigated = true; } };
    const fetch = async url => { if (url === '/api/host-status') return { ok: true, status: 200 }; calls++; return new Promise(resolve => { release = resolve; }); };
    vm.runInNewContext(source, { URL, URLSearchParams, document, location, window, navigator: {}, fetch, setTimeout, clearTimeout });
    nodes.get('#pair-another').listeners.click();
    assert.equal(nodes.get('#pair-overlay').hidden, true); assert.match(nodes.get('#send-status').textContent, /草稿/); assert.equal(calls, 0);
    dirty = false; nodes.get('#pair-another').listeners.click(); assert.equal(locked, true); assert.equal(nodes.get('#pair-overlay').hidden, false);
    nodes.get('#code').value = '123456'; const pending = nodes.get('#pair-form').listeners.submit({ preventDefault() {} });
    assert.equal(calls, 1); nodes.get('#pair-close').listeners.click(); assert.equal(locked, true);
    release({ ok: false, status: 401 }); await pending;
    assert.equal(locked, false); assert.equal(navigated, false);
  });
  test(`${version} does not reload after another tab invalidates the pairing guard`, async () => {
    const nodes = new Map();
    const document = { querySelector(key) { if (!nodes.has(key)) nodes.set(key, { hidden: true, value: '', listeners: {}, addEventListener(type, handler) { this.listeners[type] = handler; }, focus() {}, blur() {} }); return nodes.get(key); } };
    let valid = true, resolvePair, navigated = false;
    const window = { versionPairGuard: { begin: () => true, isActive: () => valid, end() {} }, history: { replaceState() {} }, addEventListener() {} };
    const location = { hash: '', pathname: `/h5/${version}/desktop.html`, search: '', origin: 'https://phone.test', assign() { navigated = true; } };
    const fetch = async url => url === '/api/host-status' ? { ok: true, status: 200 } : new Promise(resolve => { resolvePair = resolve; });
    vm.runInNewContext(source, { URL, URLSearchParams, document, location, window, navigator: {}, fetch, setTimeout, clearTimeout });
    nodes.get('#pair-another').listeners.click(); nodes.get('#code').value = '123456';
    const pending = nodes.get('#pair-form').listeners.submit({ preventDefault() {} }); valid = false;
    resolvePair({ ok: true, status: 200 }); await pending;
    assert.equal(navigated, false); assert.match(nodes.get('#pair-error').textContent, /电脑状态已变化/);
  });
}
