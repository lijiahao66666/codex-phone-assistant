import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { switchDeviceVersion } from '../public/device-version-switch.mjs';

function fixture({ targetProtocol = 'v1', protocol = 'unversioned', work = false, selectStatus = 200, failAfterSelect = false, reconnect = false } = {}) {
  const current = { hostId: randomUUID(), deviceId: randomUUID() }, target = { hostId: randomUUID(), deviceId: randomUUID() }, epoch = randomUUID();
  let busy = false, frozen = false, selected = false, navigation = null, changed = 0, requests = [];
  const locks = { async request(_name, _options, run) { return run({}); } };
  const ok = body => ({ ok: true, status: 200, json: async () => body });
  const fetchImpl = async (url, options = {}) => {
    requests.push({ url, options });
    if (url.startsWith('/api/ui-profile?')) return ok({ status: 'ready', uiProtocol: targetProtocol, ...target, currentDeviceId: selected ? target.deviceId : current.deviceId, profileEpoch: selected && reconnect ? randomUUID() : epoch });
    if (url === '/api/devices/select') { selected = true; return { ok: selectStatus === 200, status: selectStatus }; }
    if (failAfterSelect) throw new Error('connection lost');
    if (url === '/api/devices') return ok({ currentDeviceId: target.deviceId, devices: [target] });
    throw new Error('unexpected request');
  };
  const options = { current, target, protocol, getCurrent: () => current, hasWork: () => work, setBusy: value => { busy = value; }, freeze: () => { frozen = true; }, changed: () => { changed++; }, navigate: path => { navigation = path; }, locks, fetchImpl, fragment: '#thread=example' };
  options.testEpoch = epoch;
  return { options, state: () => ({ busy, frozen, selected, navigation, changed, requests }) };
}

test('cross-version selection keeps drafts in the existing page and never changes the device', async () => {
  const f = fixture({ work: true });
  assert.equal((await switchDeviceVersion(f.options)).status, 'work-present');
  assert.equal(f.state().selected, false); assert.equal(f.state().navigation, null); assert.equal(f.state().busy, false);
});

test('empty cross-version selection binds the exact profile and rechecks the device before navigating', async () => {
  const f = fixture();
  assert.equal((await switchDeviceVersion(f.options)).status, 'navigating');
  assert.equal(f.state().navigation, '/h5/v1.0.2/desktop.html#thread=example'); assert.equal(f.state().changed, 1);
  const selection = f.state().requests.find(item => item.url === '/api/devices/select');
  assert.deepEqual(JSON.parse(selection.options.body), { deviceId: f.options.target.deviceId, expectedDeviceId: f.options.current.deviceId, uiProtocol: 'v1', profileEpoch: f.options.testEpoch });
  assert.equal(selection.options.headers['x-codex-expected-device'], f.options.current.deviceId);
});

test('same-version selection retains in-memory state and no cross-version navigation occurs', async () => {
  const f = fixture({ protocol: 'v1', work: true });
  assert.equal((await switchDeviceVersion(f.options)).status, 'selected'); assert.equal(f.state().navigation, null);
});

test('rejected or unknown selection freezes on identity races and never retries', async () => {
  for (const options of [{ selectStatus: 409 }, { failAfterSelect: true }]) {
    const f = fixture(options), outcome = await switchDeviceVersion(f.options);
    assert.ok(['changed', 'outcome-unknown'].includes(outcome.status)); assert.equal(f.state().frozen, true);
    assert.equal(f.state().requests.filter(item => item.url === '/api/devices/select').length, 1); assert.equal(f.state().navigation, null);
  }
});

test('missing browser lock prevents even a preflight', async () => {
  const f = fixture(); f.options.locks = null;
  assert.equal((await switchDeviceVersion(f.options)).status, 'unsupported'); assert.equal(f.state().requests.length, 0);
});

test('a target reconnect after selection freezes instead of navigating on stale profile', async () => {
  const f = fixture({ reconnect: true });
  assert.equal((await switchDeviceVersion(f.options)).status, 'outcome-unknown');
  assert.equal(f.state().frozen, true); assert.equal(f.state().navigation, null);
});
