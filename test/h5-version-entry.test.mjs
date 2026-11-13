import test from 'node:test';
import assert from 'node:assert/strict';
import { decideVersionEntry, offlineFetch } from '../public/h5-version-entry.mjs';
import { readFile } from 'node:fs/promises';
import { renderVersionEntry } from '../scripts/prepare-h5-version-entry.mjs';

const hostId = '11111111-1111-4111-8111-111111111111', deviceId = '22222222-2222-4222-8222-222222222222';
const devices = { devices: [{ hostId, deviceId }], currentDeviceId: deviceId };
const fetchFor = (status, uiProtocol) => async url => ({ ok: true, json: async () => url === '/api/devices' ? devices : { status, uiProtocol, hostId, deviceId } });
test('both fixed versions delay application scripts until the entry guard succeeds', async () => {
  for (const version of ['v1.0.1', 'v1.0.2']) {
    const original = await readFile(new URL(`../scripts/h5-shells/${version}.html`, import.meta.url), 'utf8');
    const entry = await readFile(new URL(`../public/h5/${version}/desktop.html`, import.meta.url), 'utf8');
    assert.equal(entry, renderVersionEntry(original)); assert.match(entry, /<div class="app" hidden>/);
    assert.match(entry, /src="\/h5-version-entry\.mjs"/); assert.doesNotMatch(entry, /<script defer /);
  }
});
test('a direct version page starts only after the current desktop proves the matching protocol', async () => {
  const pathname = '/h5/v1.0.2-readsync1/desktop.html';
  const result = await decideVersionEntry({ pathname, hash: '#notificationThread=abc', fetchImpl: fetchFor('ready', 'v1') });
  assert.equal(result.status, 'load'); assert.ok(result.scripts.includes('/h5/v1.0.2-readsync1/notifications.js'));
  assert.ok(result.scripts.every(src => src.startsWith('/h5/v1.0.2-readsync1/') || src.startsWith('/download/')));
  assert.deepEqual(await decideVersionEntry({ pathname, hash: '#new', fetchImpl: fetchFor('ready', 'unversioned') }), { status: 'navigate', path: '/#new' });
  assert.deepEqual(await decideVersionEntry({ pathname: '/h5/v1.0.2/desktop.html', hash: '#thread=example', fetchImpl: fetchFor('ready', 'v1') }), { status: 'navigate', path: '/h5/v1.0.2-readsync1/desktop.html#thread=example' });
  assert.deepEqual(await decideVersionEntry({ pathname: '/h5/v1.0.2-activity1/desktop.html', hash: '#thread=example', fetchImpl: fetchFor('ready', 'v1') }), { status: 'navigate', path: '/h5/v1.0.2-readsync1/desktop.html#thread=example' });
  assert.equal((await decideVersionEntry({ pathname: '/h5/v1.0.1/desktop.html', fetchImpl: fetchFor('ready', 'unversioned') })).status, 'load');
});
test('offline and unsupported direct pages do not load scripts or guess a version', async () => {
  for (const status of ['offline', 'pending', 'unsupported']) assert.deepEqual(await decideVersionEntry({ pathname: '/h5/v1.0.1/desktop.html', fetchImpl: fetchFor(status, null) }), { status });
  assert.deepEqual(await decideVersionEntry({ pathname: '/h5/v1.0.1/desktop.html', hash: '#token=secret', fetchImpl: async () => ({ ok: true, json: async () => ({ devices: [] }) }) }), { status: 'navigate', path: '/#token=secret' });
  assert.deepEqual(await decideVersionEntry({ pathname: '//evil.example', fetchImpl: fetchFor('ready', 'v1') }), { status: 'invalid' });
});

test('offline guard blocks writes and pins read requests to the verified pair', async () => {
  let calls = 0, captured;
  const fetch = offlineFetch(async (input, init) => { calls++; captured = init; return new Response(JSON.stringify(devices), { status: 200 }); }, { hostId, deviceId }, 'https://example.test');
  await assert.rejects(fetch('/api/chats', { method: 'POST' }), /read-only/); assert.equal(calls, 0);
  await fetch('/api/threads', { headers: { 'x-codex-expected-device': hostId } }); assert.equal(captured.headers.get('x-codex-expected-device'), deviceId);
  await fetch('/api/devices');
  const changed = offlineFetch(async () => new Response(JSON.stringify({ devices: [], currentDeviceId: null })), { hostId, deviceId }, 'https://example.test');
  await assert.rejects(changed('/api/devices'), /scope changed/);
});
