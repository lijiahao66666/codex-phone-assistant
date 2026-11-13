import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseBootstrap } from '../public/h5-bootstrap.mjs';
import { readFile } from 'node:fs/promises';
import { renderBootstrap } from '../scripts/prepare-h5-bootstrap.mjs';

const hostId = '11111111-1111-4111-8111-111111111111';
const deviceId = '22222222-2222-4222-8222-222222222222';
const devices = { devices: [{ hostId, deviceId }], currentDeviceId: deviceId };
const ok = value => ({ ok: true, json: async () => value });
const run = (protocol, hash = '') => chooseBootstrap({ hash, fetchImpl: async (url, options) => {
  if (url === '/api/devices') return ok(devices);
  assert.equal(options.headers['x-codex-expected-device'], deviceId);
  return ok({ status: 'ready', uiProtocol: protocol, hostId, deviceId });
} });

test('the bootstrap shell tracks the pairing page while delaying app scripts', async () => {
  const shell = await readFile(new URL('../public/h5-bootstrap.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/desktop.html', import.meta.url), 'utf8');
  assert.equal(shell, renderBootstrap(source));
  assert.match(shell, /<div class="app" hidden>/);
  assert.doesNotMatch(shell, /<script defer /);
  assert.match(shell, /id="pair-form"/);
});

test('chooses the authorized desktop version and preserves notification fragments', async () => {
  assert.deepEqual(await run('unversioned'), { status: 'navigate', path: '/h5/v1.0.1/desktop.html' });
  const hash = '#notificationHost=x&notificationDevice=y&notificationThread=z';
  assert.deepEqual(await run('v1', hash), { status: 'navigate', path: '/h5/v1.0.2-open1/desktop.html' + hash });
});

test('pair links and an unpaired browser load the pairing flow without consuming fragments', async () => {
  for (const hash of ['#new', '#token=example']) assert.deepEqual(await chooseBootstrap({ hash, fetchImpl: () => { throw new Error('unexpected network'); } }), { status: 'pair' });
  assert.deepEqual(await chooseBootstrap({ fetchImpl: async () => ok({ devices: [], currentDeviceId: null }) }), { status: 'pair' });
});

test('does not guess a version when the host is offline or profile identity changes', async () => {
  for (const status of ['offline', 'pending', 'unsupported']) assert.deepEqual(await chooseBootstrap({ fetchImpl: async url => ok(url === '/api/devices' ? devices : { status, hostId, deviceId }) }), { status });
  assert.deepEqual(await chooseBootstrap({ fetchImpl: async url => ok(url === '/api/devices' ? devices : { status: 'ready', uiProtocol: 'v1', hostId, deviceId: hostId }) }), { status: 'superseded' });
});

test('discards an in-flight profile when selected computer changes', async () => {
  let count = 0;
  const result = await chooseBootstrap({ fetchImpl: async url => {
    if (url === '/api/ui-profile') return ok({ status: 'ready', uiProtocol: 'v1', hostId, deviceId });
    return ok(++count === 1 ? devices : { devices: [{ hostId, deviceId: hostId }], currentDeviceId: hostId });
  } });
  assert.deepEqual(result, { status: 'superseded' });
});

test('offline fallback requires a previously verified protocol for the exact pair and rechecks current device', async () => {
  const values = new Map(), storage = { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) };
  let status = 'ready', reads = 0, changed = false;
  const fetchImpl = async url => url === '/api/devices' ? ok(changed && ++reads > 1 ? { devices: [{ hostId, deviceId: hostId }], currentDeviceId: hostId } : devices) : ok({ status, uiProtocol: status === 'ready' ? 'v1' : null, hostId, deviceId });
  assert.equal((await chooseBootstrap({ fetchImpl, storage })).status, 'navigate');
  status = 'offline';
  assert.deepEqual(await chooseBootstrap({ fetchImpl, storage }), { status: 'navigate', path: '/h5/v1.0.2-open1/desktop.html', offline: true, scope: { hostId, deviceId } });
  assert.deepEqual(await chooseBootstrap({ fetchImpl, storage: { getItem: () => null } }), { status: 'offline' });
  const foreignHost = '33333333-3333-4333-8333-333333333333';
  assert.deepEqual(await chooseBootstrap({ storage, fetchImpl: async url => url === '/api/devices' ? ok({ devices: [{ hostId: foreignHost, deviceId }], currentDeviceId: deviceId }) : ok({ status: 'offline', uiProtocol: null, hostId: foreignHost, deviceId }) }), { status: 'offline' });
  reads = 0; changed = true; assert.deepEqual(await chooseBootstrap({ fetchImpl, storage }), { status: 'superseded' });
  status = 'pending'; changed = false; assert.deepEqual(await chooseBootstrap({ fetchImpl, storage }), { status: 'pending' });
  status = 'unsupported'; assert.deepEqual(await chooseBootstrap({ fetchImpl, storage }), { status: 'unsupported' });
});
