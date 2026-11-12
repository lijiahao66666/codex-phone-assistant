import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';

const visible = '33333333-3333-4333-8333-333333333333';
const hidden = '44444444-4444-4444-8444-444444444444';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('paired search goes through real relay and connector, filters results and handles cancellation', { timeout: 15000 }, async () => {
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin }); await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, body, extra = {}, signal) => fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal });
  let connector, release; const gate = new Promise(resolve => { release = resolve; }); const calls = [];
  try {
    const host = await (await post('/api/enroll', { name: 'search fixture' })).json();
    const code = await (await post('/api/host/pair-code', {}, { authorization: `Bearer ${host.secret}` })).json();
    const paired = await post('/api/pair', { qrToken: code.qrToken });
    const { deviceId } = await paired.json();
    const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
    const auth = { cookie, 'x-codex-expected-device': deviceId };
    const search = (query, extra = {}, signal) => post('/api/threads/search', { query, ...extra }, auth, signal);
    assert.equal((await search('x')).status, 503);
    connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, hostId: host.hostId, secret: host.secret, allowInsecureForTests: true,
      listThreads: async () => ({ projects: [], recent: [], nextCursor: null }),
      modelRequest: async (method, params) => { calls.push(params.searchTerm); if (params.searchTerm === 'slow') await gate; return { data: [{ thread: { id: visible, path: '/private' }, snippet: 'matching text' }, { thread: { id: hidden }, snippet: 'hidden' }], nextCursor: 'next' }; },
      searchAuthorizeForTests: async () => new Map([[visible, 'Visible']]),
      readSearchUnreadForTests: async () => ({ status: 'available', canReadUnread: true, scopeKey: 'a'.repeat(64), unreadThreadIds: new Set([visible, hidden]) }),
    });
    connector.start();
    let result; for (let i = 0; i < 100; i++) { result = await search('ready'); if (result.status === 200) break; await delay(20); }
    assert.equal(result.status, 200); const data = await result.json();
    const activity = await post('/api/activity', {}, auth);
    assert.equal(activity.status, 200);
    assert.deepEqual((await activity.json()).items, []);
    assert.equal((await post('/api/activity', {}, { cookie })).status, 409);
    assert.equal((await post('/api/activity', { extra: true }, auth)).status, 400);
    assert.equal((await post('/api/activity', {}, { ...auth, origin: 'https://evil.test' })).status, 403);
    assert.equal(data.scopeKey, 'a'.repeat(64));
    assert.deepEqual(data.results, [{ id: visible, title: 'Visible', snippet: 'matching text', unread: true }]);
    assert.equal((await search('different', { cursor: data.nextCursor })).status, 400);
    assert.equal((await post('/api/threads/search', { query: 'x' }, { cookie })).status, 409);
    assert.equal((await post('/api/threads/search', { query: 'x' })).status, 401);
    assert.equal((await post('/api/threads/search', { query: 'x' }, { ...auth, origin: 'https://evil.test' })).status, 403);
    const controller = new AbortController(); const slow = search('slow', {}, controller.signal).catch(() => null);
    while (!calls.includes('slow')) await delay(5);
    const old = search('old'); await delay(50); const latest = search('latest'); await delay(50); controller.abort(); await slow; release();
    assert.equal((await old).status, 503); assert.equal((await latest).status, 200);
    assert.equal(calls.includes('old'), false); assert.equal(calls.includes('latest'), true);
  } finally { release(); await connector?.close(); await relay.close(); }
});
