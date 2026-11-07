import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';
import { relayConfig, startRelay } from '../src/relay/cli.mjs';

test('relay serves the repository H5 assets and forwards authenticated model requests', { timeout: 10000 }, async () => {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin });
  await relay.listen(port);
  const base = `http://127.0.0.1:${port}`;
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  let peer;
  try {
    for (const [path, mime] of [['/', 'text/html'], ['/recovery-attempt-store.js', 'javascript'], ['/history-projection.mjs', 'javascript'], ['/state-chunks.mjs', 'javascript'], ['/app-icon-20261106.png', 'image/png'], ['/markdown-parser.js', 'javascript']]) {
      const response = await fetch(base + path, { headers });
      assert.equal(response.status, 200, path);
      assert.match(response.headers.get('content-type'), new RegExp(mime));
      assert.ok((await response.arrayBuffer()).byteLength > 0);
    }
    assert.equal((await fetch(base + '/api/models', { headers })).status, 401);
    const enrolled = await post('/api/enroll', { name: 'relay-test' });
    assert.equal(enrolled.status, 201);
    const host = await enrolled.json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(paired.status, 200);
    const device = await paired.json();
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    assert.ok(device.deviceId);
    let writes = 0;
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    peer.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'flow-probe') return;
      if (message.type === 'request' && message.path === '/api/models') peer.send(JSON.stringify({ type: 'response', id: message.id, ok: true, data: { models: [{ model: 'test-model', supportedReasoningEfforts: ['low', 'high'] }] } }));
      if (message.type === 'model') {
        writes++;
        assert.equal(message.deviceId, device.deviceId);
        assert.equal(message.model, 'test-model');
        assert.equal(message.effort, 'high');
        peer.send(JSON.stringify({ type: 'response', id: message.id, status: 'accepted' }));
      }
    });
    await once(peer, 'open');
    const models = await fetch(base + '/api/models', { headers: { ...headers, cookie } });
    assert.equal(models.status, 200);
    assert.equal((await models.json()).models[0].model, 'test-model');
    const threadId = randomUUID();
    assert.equal((await post(`/api/threads/${threadId}/model`, { model: 'test-model', effort: 'high' }, { cookie })).status, 202);
    assert.equal(writes, 1);
    assert.equal((await post(`/api/threads/${threadId}/model`, { model: 'test-model' }, { cookie, 'x-codex-expected-device': randomUUID() })).status, 409);
    assert.equal(writes, 1);
  } finally {
    peer?.terminate();
    await relay.close();
  }
});

test('relay CLI configuration creates a persistent database and validates flags', async () => {
  assert.throws(() => relayConfig({}), /HUB_ORIGIN/);
  assert.throws(() => relayConfig({ HUB_ORIGIN: 'https://relay.example.test', PORT: '-1' }), /PORT/);
  assert.throws(() => relayConfig({ HUB_ORIGIN: 'https://relay.example.test', HUB_TRUSTED_PROXY: 'yes' }), /0 or 1/);
  const dir = await mkdtemp(join(tmpdir(), 'codex-relay-config-'));
  let relay;
  try {
    const database = join(dir, 'nested', 'relay.sqlite');
    ({ relay } = await startRelay({ HUB_ORIGIN: 'https://relay.example.test', HUB_DATABASE: database, PORT: '0' }));
    assert.ok((await stat(database)).isFile());
    if (process.platform !== 'win32') assert.equal((await stat(database)).mode & 0o077, 0);
  } finally { await relay?.close(); await rm(dir, { recursive: true, force: true }); }
});

test('relay restart preserves the phone cookie and desktop credential without pairing again', { timeout: 10000 }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'codex-relay-restart-'));
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const database = join(dir, 'relay.sqlite');
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', connection: 'close' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  let relay, peer;
  try {
    relay = createPairRelay({ origin, database, production: true });
    await relay.listen(port);
    const host = await (await post('/api/enroll', { name: 'Existing Mac' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(paired.status, 200);
    const device = await paired.json();
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    await relay.close();
    relay = createPairRelay({ origin, database, production: true });
    await relay.listen(port);
    const devicesResponse = await fetch(base + '/api/devices', { headers: { ...headers, cookie } });
    assert.equal(devicesResponse.status, 200, 'the saved phone cookie remains authenticated');
    const devices = await devicesResponse.json();
    assert.equal(devices.currentDeviceId, device.deviceId);
    assert.deepEqual(devices.devices.map(value => value.deviceId), [device.deviceId]);
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    await once(peer, 'open');
    const status = await fetch(base + '/api/host-status', { headers: { ...headers, cookie } });
    assert.equal(status.status, 200);
    assert.equal((await status.json()).online, true, 'the existing Mac secret reconnects');
  } finally {
    peer?.terminate();
    await relay?.close();
    await rm(dir, { recursive: true, force: true });
  }
});
