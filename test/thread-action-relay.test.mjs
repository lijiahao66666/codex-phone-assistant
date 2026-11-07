import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

const threadId = '33333333-3333-4333-8333-333333333333';

test('a paired phone can archive and delete a thread through its connector', { timeout: 10000 }, async () => {
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
    const host = await (await post('/api/enroll', { name: 'thread-action' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');

    const actions = [];
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    peer.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type === 'thread-action') {
        actions.push(message);
        peer.send(JSON.stringify({ type: 'response', id: message.id, status: 'accepted' }));
      }
    });
    await new Promise(resolve => peer.once('open', resolve));

    const archive = await post(`/api/threads/${threadId}/archive`, {}, { cookie });
    assert.equal(archive.status, 202);
    assert.deepEqual(await archive.json(), { status: 'accepted' });
    assert.equal(actions.length, 1);
    assert.equal(actions[0].action, 'archive');
    assert.equal(actions[0].conversationId, threadId);

    const remove = await post(`/api/threads/${threadId}/delete`, {}, { cookie });
    assert.equal(remove.status, 202);
    assert.equal(actions[1].action, 'delete');

    const invalid = await post(`/api/threads/${threadId}/archive`, { extra: true }, { cookie });
    assert.equal(invalid.status, 400);
    assert.equal(actions.length, 2);
  } finally { peer?.terminate(); await relay.close(); }
});
