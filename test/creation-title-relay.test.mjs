import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

test('creation titles are optional, bounded, validated and forwarded unchanged on prepare and submit', { timeout: 10000 }, async () => {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin });
  await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, value, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(value) });
  let peer;
  const forwarded = [], threadId = randomUUID();
  try {
    const host = await (await post('/api/enroll', { name: 'title-contract-test' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    peer.on('message', raw => {
      const message = JSON.parse(raw);
      if (!['prepare-chat', 'submit-chat'].includes(message.type)) return;
      forwarded.push(message);
      peer.send(JSON.stringify({ type: 'response', id: message.id, status: 'accepted', threadId }));
    });
    await once(peer, 'open');
    for (const [path, fields] of [
      ['/api/chats/prepare', { projectId: '/isolated', digest: 'a'.repeat(64) }],
      ['/api/chats/submit', { text: 'full first prompt', attachmentIds: [randomUUID()] }],
    ]) {
      for (const title of [undefined, 'Readable first prompt', 'x'.repeat(80)]) {
        const requestId = randomUUID();
        const response = await post(path, { requestId, ...fields, ...(title === undefined ? {} : { title }) }, { cookie });
        assert.equal(response.status, 202);
        assert.equal(forwarded.find(message => message.requestId === requestId).title, title);
      }
      const count = forwarded.length;
      for (const title of ['', 'x'.repeat(81), 'line\nbreak', 'tab\there', ' padded ', '\u2028', '\u0000', null, 5, {}]) {
        const invalid = await post(path, { requestId: randomUUID(), ...fields, title }, { cookie });
        assert.equal(invalid.status, 400, `${path}: ${JSON.stringify(title)}`);
      }
      assert.equal(forwarded.length, count, 'invalid title never reaches the host');
    }
  } finally { peer?.terminate(); await relay.close(); }
});
