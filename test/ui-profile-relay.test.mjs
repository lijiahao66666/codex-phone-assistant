import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

test('UI profile is scoped to the active pair, negotiated per connection and reset on disconnect', async () => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }, sockets = [];
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  async function pair(name) {
    const host = await (await post('/api/enroll', { name })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const response = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(response.status, 200); const phone = await response.json();
    return { ...host, ...phone, cookie: response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  async function open(pair) {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${pair.secret}` } });
    sockets.push(ws); await once(ws, 'open'); return ws;
  }
  const request = (pair, extra = {}) => fetch(base + '/api/ui-profile', { headers: { cookie: pair.cookie, 'sec-fetch-site': 'same-origin', 'x-codex-expected-device': pair.deviceId, ...extra } });
  async function expectProfile(pair, status, protocol) {
    let result;
    for (let i = 0; i < 100; i++) {
      result = await (await request(pair)).json();
      if (result.status === status && result.uiProtocol === protocol) break;
      await delay(10);
    }
    assert.deepEqual(result, { status, uiProtocol: protocol, hostId: pair.hostId, deviceId: pair.deviceId });
  }
  try {
    const old = await pair('old'), current = await pair('current');
    await expectProfile(old, 'offline', null);
    const wsOld = await open(old), wsCurrent = await open(current);
    await expectProfile(old, 'pending', null); await expectProfile(current, 'pending', null);
    wsOld.send(JSON.stringify({ type: 'capabilities', streamFlow: 2 }));
    wsCurrent.send(JSON.stringify({ type: 'capabilities', uiProtocol: 1, streamFlow: 2 }));
    await expectProfile(old, 'ready', 'unversioned'); await expectProfile(current, 'ready', 'v1');
    const released = { type: 'capabilities', streamFlow: 2, taskNotifications: 1, desktopNotificationRead: 1, desktopUnreadOpen: 1, activity: 1, threadSearch: 1 };
    wsOld.send(JSON.stringify({ ...released, threadSearch: 0 })); await expectProfile(old, 'ready', 'unversioned');
    wsOld.send(JSON.stringify(released)); await expectProfile(old, 'ready', 'v1');
    wsOld.send(JSON.stringify({ ...released, uiProtocol: 2 })); await expectProfile(old, 'unsupported', null);
    wsOld.send(JSON.stringify({ type: 'capabilities', streamFlow: 2 })); await expectProfile(old, 'ready', 'unversioned');
    // Both device credentials belong to this browser; preflight must not
    // change selection and a stale connection epoch cannot select the target.
    const cookie = `${old.cookie.split('; ').filter(x => x.startsWith('__Host-codex-device-')).join('; ')}; ${current.cookie.split('; ').filter(x => x.startsWith('__Host-codex-device-')).join('; ')}; __Host-codex-current=${old.deviceId}`;
    const preflight = () => fetch(base + `/api/ui-profile?deviceId=${current.deviceId}`, { headers: { cookie, 'sec-fetch-site': 'same-origin', 'x-codex-expected-device': old.deviceId } });
    const profile = await (await preflight()).json();
    assert.equal(profile.currentDeviceId, old.deviceId); assert.equal(profile.deviceId, current.deviceId); assert.equal(profile.uiProtocol, 'v1'); assert.match(profile.profileEpoch, /^[0-9a-f-]{36}$/);
    assert.equal((await fetch(base + `/api/ui-profile?deviceId=${current.deviceId}`, { headers: { cookie: old.cookie, 'sec-fetch-site': 'same-origin', 'x-codex-expected-device': old.deviceId } })).status, 403);
    const guardedSelect = epoch => post('/api/devices/select', { deviceId: current.deviceId, expectedDeviceId: old.deviceId, uiProtocol: 'v1', profileEpoch: epoch }, { cookie, 'x-codex-expected-device': old.deviceId });
    assert.equal((await guardedSelect('stale')).status, 409);
    const switched = await guardedSelect(profile.profileEpoch); assert.equal(switched.status, 200); assert.match(switched.headers.get('set-cookie'), new RegExp(`__Host-codex-current=${current.deviceId}`));
    wsCurrent.send(JSON.stringify({ type: 'capabilities', uiProtocol: 1, streamFlow: 2 }));
    for (let i = 0; i < 100; i++) { if ((await (await preflight()).json()).profileEpoch !== profile.profileEpoch) break; await delay(10); }
    assert.equal((await guardedSelect(profile.profileEpoch)).status, 409);
    assert.equal((await request(old, { 'x-codex-expected-device': current.deviceId })).status, 409);
    assert.equal((await request(old, { origin: 'https://other.example' })).status, 403);
    assert.equal((await fetch(base + '/api/ui-profile', { headers: { 'sec-fetch-site': 'same-origin' } })).status, 401);
    wsCurrent.send(JSON.stringify({ type: 'capabilities', uiProtocol: 99, streamFlow: 2 }));
    await expectProfile(current, 'unsupported', null);
    wsOld.close(); await once(wsOld, 'close'); await expectProfile(old, 'offline', null);
    const reconnected = await open(old); await expectProfile(old, 'pending', null);
    reconnected.send(JSON.stringify({ type: 'capabilities', uiProtocol: 1 })); await expectProfile(old, 'ready', 'v1');
    await expectProfile(current, 'unsupported', null);
    assert.equal((await post('/api/devices/remove', { deviceId: old.deviceId }, { cookie: old.cookie })).status, 200);
    assert.equal((await request(old)).status, 401);
    await expectProfile(current, 'unsupported', null);
  } finally { for (const ws of sockets) ws.terminate(); await relay.close(); }
});
