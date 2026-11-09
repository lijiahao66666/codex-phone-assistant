import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { WebSocket } from 'ws';
import { createPairRelay } from '../src/relay/server.mjs';

const thread = '33333333-3333-4333-8333-333333333333';
test('lazy output negotiation and pages use authenticated device routing and bounded parameters', { timeout: 10000 }, async () => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, body, extra = {}) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body) });
  let peer;
  try {
    const host = await (await post('/api/enroll', { name: 'lazy-output' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken }), device = await paired.json();
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const received = [];
    peer = new WebSocket(`ws://127.0.0.1:${port}/connector`, { headers: { authorization: `Bearer ${host.secret}` } });
    peer.on('message', raw => { const msg = JSON.parse(raw); received.push(msg);
      if (msg.type === 'request') peer.send(JSON.stringify({ type: 'event', id: msg.id, event: 'state', data: { seq: 1, conversation: { id: thread, turns: [] } } }));
      if (msg.type === 'tool-output') peer.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, data: { threadId: thread, turnKey: msg.turnKey, itemId: msg.itemId, hash: msg.hash, offset: msg.offset, text: 'page', nextOffset: null } }));
    }); await once(peer, 'open');
    for (const lazy of [false, true]) {
      const stop = new AbortController();
      const response = await fetch(`${base}/api/threads/${thread}/events`, { headers: { ...headers, cookie, ...(lazy ? { 'x-codex-lazy-output': '1' } : {}) }, signal: stop.signal });
      await response.body.getReader().read(); stop.abort();
      assert.equal(received.filter(m => m.type === 'request').at(-1).lazyOutput, lazy ? true : undefined);
    }
    const params = new URLSearchParams({ turn: 'turn/a', item: 'item#1', hash: 'a'.repeat(64), offset: '0' });
    const path = `/api/threads/${thread}/tool-output?${params}`;
    assert.equal((await fetch(base + path, { headers })).status, 401);
    assert.equal((await fetch(base + path, { headers: { ...headers, cookie, 'x-codex-expected-device': thread } })).status, 409);
    const response = await fetch(base + path, { headers: { ...headers, cookie, 'x-codex-expected-device': device.deviceId } });
    assert.equal(response.status, 200); assert.equal((await response.json()).text, 'page');
    const request = received.find(m => m.type === 'tool-output'); assert.equal(request.deviceId, device.deviceId); assert.equal(request.turnKey, 'turn/a'); assert.equal(request.itemId, 'item#1'); assert.equal(request.offset, 0);
    for (const query of [params + '&offset=1', params + '&extra=x', new URLSearchParams({ turn: 'x', item: 'y', hash: 'z', offset: '0' }), new URLSearchParams({ turn: 'x', item: 'y', hash: 'a'.repeat(64), offset: '-1' })]) {
      assert.equal((await fetch(`${base}/api/threads/${thread}/tool-output?${query}`, { headers: { ...headers, cookie } })).status, 400);
    }
    assert.equal(received.filter(m => m.type === 'tool-output').length, 1);
  } finally { peer?.terminate(); await relay.close(); }
});
