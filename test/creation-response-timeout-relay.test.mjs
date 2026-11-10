import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

test('creation handoff has a bounded recovery window while ordinary relay requests retain their short timeout', { timeout: 10000 }, async () => {
  const reserve = createServer();
  await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, requestTimeoutMs: 50, recoveryResponseTimeoutMs: 600 });
  await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  const messages = [], replies = new Set(), delayed = new Set();
  let peer;
  try {
    const host = await (await post('/api/enroll', { name: 'creation-timeout-test' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const threadId = randomUUID();
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    peer.on('message', raw => {
      const message = JSON.parse(raw);
      messages.push(message);
      if (!delayed.has(message.requestId)) return;
      // Represent the release/discover/resume phase using a real wall-clock
      // delay longer than the ordinary response window.
      const reply = delay(150).then(() => {
        peer.send(JSON.stringify({ type: 'response', id: message.id, status: 'accepted', threadId }));
      }).finally(() => replies.delete(reply));
      replies.add(reply);
    });
    await once(peer, 'open');
    for (const [path, fields] of [
      ['/api/chats', { projectId: '/tmp', text: 'hello' }],
      ['/api/chats/prepare', { projectId: '/tmp', digest: 'a'.repeat(64) }],
      ['/api/chats/submit', { text: 'hello', attachmentIds: [randomUUID()] }],
    ]) {
      const requestId = randomUUID(); delayed.add(requestId);
      const response = await post(path, { requestId, ...fields }, { cookie });
      assert.equal(response.status, 202, `${path} must survive the ordinary timeout`);
      assert.deepEqual(await response.json(), { threadId });
      const forwarded = messages.find(message => message.requestId === requestId);
      assert.ok(forwarded);
      assert.equal(messages.some(message => message.type === 'cancel-reply' && message.id === forwarded.id), false);
    }

    // This read is deliberately unanswered; creation must not lengthen the
    // normal request deadline or leave its connector work unbounded.
    const ordinaryStart = performance.now();
    const ordinary = await post('/api/chats/status', { requestId: randomUUID() }, { cookie });
    assert.equal(ordinary.status, 503);
    assert.deepEqual(await ordinary.json(), { error: 'unavailable' });
    assert.ok(performance.now() - ordinaryStart < 300, 'ordinary reads must expire well before the 600 ms creation window');

    const requestId = randomUUID();
    const expired = await post('/api/chats', { requestId, projectId: '/tmp', text: 'never acknowledged' }, { cookie });
    assert.equal(expired.status, 504, 'creation still ends at its own bounded response deadline');
    assert.deepEqual(await expired.json(), { error: 'outcome-unknown' });
    const forwarded = messages.find(message => message.requestId === requestId);
    assert.ok(forwarded);
    await delay(10);
    assert.equal(messages.some(message => message.type === 'cancel-reply' && message.id === forwarded.id), true);
  } finally {
    await Promise.allSettled([...replies]);
    peer?.terminate();
    await relay.close();
  }
});
