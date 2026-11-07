import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

test('upload pipeline is advertised only by its current host and resets on reconnect', async () => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, imageUpload: true }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, data, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  const sockets = [];
  async function host(name) {
    const host = await (await post('/api/enroll', { name })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    assert.equal(paired.status, 200);
    return { ...host, cookie: paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ') };
  }
  async function connect(host, capabilities) {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    sockets.push(socket);
    socket.on('message', raw => { if (JSON.parse(raw).type === 'flow-probe' && capabilities) socket.send(JSON.stringify({ type: 'capabilities', streamFlow: 2, ...capabilities })); });
    await once(socket, 'open');
    return socket;
  }
  const read = async host => (await fetch(base + '/api/capabilities', { headers: { cookie: host.cookie, 'sec-fetch-site': 'same-origin' } })).json();
  async function expect(host, chunk, concurrency) {
    let value;
    for (let i = 0; i < 50; i++) {
      value = await read(host);
      if (value.imageChunkBytes === chunk && value.uploadConcurrency === concurrency) return;
      await delay(10);
    }
    assert.deepEqual([value.imageChunkBytes, value.uploadConcurrency], [chunk, concurrency]);
  }
  try {
    const legacy = await host('legacy'), modern = await host('modern');
    const old = await connect(legacy, { streamFlow: 2 });
    const current = await connect(modern, { uploadChunkBytes: 524288, uploadConcurrency: 2 });
    await expect(legacy, 131072, 1);
    await expect(modern, 524288, 2);
    current.close(); await once(current, 'close');
    await expect(modern, 131072, 1);
    const reconnect = await connect(modern, null);
    await expect(modern, 131072, 1);
    reconnect.send(JSON.stringify({ type: 'capabilities', streamFlow: 2, uploadChunkBytes: 524288, uploadConcurrency: 1 }));
    await expect(modern, 131072, 1);
    reconnect.send(JSON.stringify({ type: 'capabilities', streamFlow: 2, uploadChunkBytes: 524288, uploadConcurrency: 2 }));
    await expect(modern, 524288, 2);
    await expect(legacy, 131072, 1);
    assert.equal(old.readyState, WebSocket.OPEN);
  } finally {
    for (const socket of sockets) socket.terminate();
    await relay.close();
  }
});
