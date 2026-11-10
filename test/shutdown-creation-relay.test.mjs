import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

test('explicit pre-dispatch shutdown rejection reaches all creation routes', async () => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  let peer;
  try {
    const host = await (await post('/api/enroll', { name: 'shutdown-test' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    peer.on('message', raw => { const msg = JSON.parse(raw); if (['create-chat', 'prepare-chat', 'submit-chat'].includes(msg.type)) peer.send(JSON.stringify({ type: 'response', id: msg.id, status: 'not-dispatched' })); });
    await once(peer, 'open');
    for (const [path, body] of [
      ['/api/chats', { requestId: randomUUID(), projectId: '/tmp', text: 'hello' }],
      ['/api/chats/prepare', { requestId: randomUUID(), projectId: '/tmp', digest: 'a'.repeat(64) }],
      ['/api/chats/submit', { requestId: randomUUID(), text: 'hello', attachmentIds: [randomUUID()] }],
    ]) {
      const response = await post(path, body, { cookie });
      assert.equal(response.status, 409, path); assert.deepEqual(await response.json(), { error: 'not-dispatched' });
    }
  } finally { peer?.terminate(); await relay.close(); }
});
