import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createServer } from 'node:net';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

test('two phones can explicitly restore retained credentials and only the active phone can read', { timeout: 15000 }, async () => {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin });
  await relay.listen(port);
  const base = `http://127.0.0.1:${port}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const request = (path, { cookie, method = 'GET', data, extra = {} } = {}) => fetch(base + path, {
    method, headers: { ...headers, ...(cookie ? { cookie } : {}), ...extra },
    ...(data === undefined ? {} : { body: JSON.stringify(data) }),
  });
  const post = (path, data, extra = {}) => request(path, { method: 'POST', data, extra });
  let connector;
  let releaseOldList, oldListStarted;
  const started = new Promise(resolve => { oldListStarted = resolve; });
  let blockList = false;
  try {
    const host = await (await post('/api/enroll', { name: 'pairing-recovery-test' })).json();
    const auth = { authorization: `Bearer ${host.secret}` };
    const pairPhone = async () => {
      const code = await (await post('/api/host/pair-code', {}, auth)).json();
      const response = await post('/api/pair', { qrToken: code.qrToken });
      assert.equal(response.status, 200);
      return { ...await response.json(), cookie: response.headers.getSetCookie().map(s => s.split(';')[0]).join('; ') };
    };
    const a = await pairPhone();
    connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, secret: host.secret, hostId: host.hostId,
      allowInsecureForTests: true, listThreads: async () => {
        if (blockList) { blockList = false; oldListStarted(); await new Promise(resolve => { releaseOldList = resolve; }); }
        return { projects: [], recent: [] };
      } });
    connector.start();
    let online = false;
    for (let i = 0; i < 100; i++) {
      online = (await (await request('/api/host-status', { cookie: a.cookie })).json()).online;
      if (online) break;
      await delay(10);
    }
    assert.equal(online, true);
    const threads = phone => request('/api/threads', { cookie: phone.cookie, method: 'POST', data: { visibleThreads: [] } });
    assert.equal((await threads(a)).status, 200);
    blockList = true;
    const oldRequest = threads(a);
    await started;
    assert.equal((await request('/api/capabilities', { cookie: a.cookie })).status, 200);
    const b = await pairPhone();
    assert.equal((await oldRequest).status, 503);
    const status = async phone => (await request('/api/pairing/status', { cookie: phone.cookie })).json();
    assert.deepEqual(await status(a), { state: 'replaced', activeDeviceId: b.deviceId });
    assert.deepEqual(await status(b), { state: 'active', activeDeviceId: b.deviceId });
    assert.equal((await request('/api/capabilities', { cookie: a.cookie })).status, 401);
    const restore = (phone, expected) => request('/api/pairing/restore', { cookie: phone.cookie, method: 'POST', data: { expectedActiveDeviceId: expected } });
    assert.equal((await restore(a, a.deviceId)).status, 409);
    assert.equal((await status(b)).state, 'active');
    assert.equal((await restore(a, b.deviceId)).status, 200);
    releaseOldList();
    assert.equal((await threads(a)).status, 200); // Connector accepts the same device again.
    assert.equal((await request('/api/capabilities', { cookie: a.cookie })).status, 200);
    assert.equal((await status(b)).state, 'replaced');
    assert.equal((await restore(a, b.deviceId)).status, 200); // Idempotent retry.
    assert.equal((await restore(b, a.deviceId)).status, 200);
    assert.equal((await threads(b)).status, 200);
    assert.equal((await status(a)).state, 'replaced');
    assert.equal((await restore(a, b.deviceId)).status, 200);
    assert.equal((await request('/api/pairing/restore', { cookie: b.cookie, method: 'POST', data: { expectedActiveDeviceId: a.deviceId }, extra: { origin: 'https://other.example' } })).status, 403);
    assert.equal((await request('/api/pairing/restore', { method: 'POST', data: { expectedActiveDeviceId: a.deviceId } })).status, 401);
    for (const data of [{}, { expectedActiveDeviceId: [] }, { expectedActiveDeviceId: b.deviceId, extra: true }]) {
      assert.equal((await request('/api/pairing/restore', { cookie: b.cookie, method: 'POST', data })).status, 400);
    }
    assert.equal((await post(`/api/host/devices/${b.deviceId}/revoke`, {}, auth)).status, 200);
    assert.equal((await restore(b, a.deviceId)).status, 401);
    assert.equal((await request('/api/pairing/status', { cookie: b.cookie })).status, 401);
    const listed = await (await request('/api/host/devices', { extra: auth })).json();
    assert.equal(listed.devices.length, 1); // Restoring never creates new pairings.
  } finally { releaseOldList?.(); await connector?.close(); await relay.close(); }
});
