import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocketServer } from 'ws';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { fixture, threadId, turn, until } from './helpers/owner-history-fixture.mjs';

const deviceId = '22222222-2222-4222-8222-222222222222';
const hostId = '33333333-3333-4333-8333-333333333333';
const listed = () => ({ projects: [], recent: [{ id: threadId, title: 'fixture', recency: 1 }] });

async function connectorFixture(f, { router = {}, ...options } = {}) {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await once(server, 'listening');
  const incoming = once(server, 'connection');
  const connector = createPreviewConnector({
    url: `ws://127.0.0.1:${server.address().port}/connector`, secret: 's'.repeat(43), hostId,
    allowInsecureForTests: true, listThreads: async () => listed(),
    ownerRouter: { localOwner: f.local, discover: async () => ({ kind: 'owner', ownerId: f.local.ownerId() }),
      isRecoveryLocked: () => false, journal: { threadWritePending: () => false }, ...router },
    ...options,
  });
  connector.start();
  const [socket] = await incoming;
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw.toString())));
  return { messages,
    send: message => socket.send(JSON.stringify(message)),
    archive(id) { socket.send(JSON.stringify({ type: 'thread-action', action: 'archive', conversationId: threadId, deviceId, id })); },
    async response(id) {
      await until(() => messages.some(message => message.id === id), `connector response ${id}`);
      return messages.find(message => message.id === id);
    },
    async close() { await connector.close(); await new Promise(resolve => server.close(resolve)); },
  };
}

test('connector archives a freshly authorized idle helper thread exactly once', async () => {
  const f = await fixture({ data: [turn('latest')], nextCursor: null });
  let c;
  try {
    await f.resume();
    let lists = 0;
    c = await connectorFixture(f, { listThreads: async () => { lists++; return listed(); } });
    const before = f.requests.length;
    c.archive('idle');
    assert.equal((await c.response('idle')).status, 'accepted');
    assert.equal(lists, 1, 'list authorization is refreshed for the mutation');
    assert.deepEqual(f.requests.slice(before).map(request => request.method), ['thread/archive']);
    await until(() => f.frames.some(frame => frame.method === 'thread-archived'), 'desktop archive broadcast');
  } finally { await c?.close(); await f.close(); }
});

test('connector reports desktop-owner unsupported after paginated scope authorization without runtime writes', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  let c;
  try {
    let lists = 0;
    c = await connectorFixture(f, { router: { discover: async () => ({ kind: 'owner', ownerId: 'native-desktop' }) },
      listThreads: async options => {
        lists++;
        return options.before ? listed() : { projects: [], recent: [], nextCursor: { id: threadId, recency: 2 } };
      },
    });
    const before = f.requests.length;
    c.archive('native');
    assert.deepEqual(await c.response('native'), { type: 'response', id: 'native', status: 'not-supported-desktop-owner' });
    assert.equal(lists, 2);
    assert.equal(f.requests.length, before);
  } finally { await c?.close(); await f.close(); }
});

test('connector refuses hidden threads, recovery locks, journal uncertainty and missing discovery', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  try {
    await f.resume();
    for (const options of [
      { listThreads: async () => ({ projects: [], recent: [] }) },
      { router: { isRecoveryLocked: () => true } },
      { router: { journal: { threadWritePending: () => true } } },
      { router: { journal: {} } },
      { router: { discover: undefined } },
    ]) {
      const c = await connectorFixture(f, options);
      try {
        const before = f.requests.length;
        c.archive('blocked');
        assert.equal((await c.response('blocked')).status, 'unavailable');
        assert.equal(f.requests.length, before);
      } finally { await c.close(); }
    }
  } finally { await f.close(); }
});

test('archive reservation excludes concurrent mutation and rechecks locks after owner discovery', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  let c, release;
  try {
    await f.resume();
    let discovered = false, locked = false;
    const paused = new Promise(resolve => { release = resolve; });
    c = await connectorFixture(f, { router: {
      discover: async () => { discovered = true; await paused; return { kind: 'owner', ownerId: f.local.ownerId() }; },
      journal: { threadWritePending: () => locked },
    } });
    const before = f.requests.length;
    c.archive('first');
    await until(() => discovered, 'owner discovery');
    c.archive('second');
    assert.equal((await c.response('second')).status, 'unavailable');
    locked = true; release();
    assert.equal((await c.response('first')).status, 'unavailable');
    assert.equal(f.requests.length, before);
  } finally { release?.(); await c?.close(); await f.close(); }
});

test('device revoked during discovery cannot archive or receive a success response', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  let c, release;
  try {
    await f.resume();
    let discovered = false, done = false;
    const paused = new Promise(resolve => { release = resolve; });
    c = await connectorFixture(f, { router: { discover: async () => {
      discovered = true; await paused; done = true; return { kind: 'owner', ownerId: f.local.ownerId() };
    } } });
    const before = f.requests.length;
    c.archive('revoked');
    await until(() => discovered, 'owner discovery');
    c.send({ type: 'device-revoked', deviceId });
    c.send({ type: 'flow-probe' });
    await until(() => c.messages.some(message => message.type === 'capabilities'), 'revocation processed');
    release(); await until(() => done, 'discovery released');
    c.send({ type: 'flow-probe' });
    await until(() => c.messages.filter(message => message.type === 'capabilities').length === 2, 'post-discovery barrier');
    assert.equal(f.requests.length, before);
    assert.equal(c.messages.some(message => message.id === 'revoked'), false);
  } finally { release?.(); await c?.close(); await f.close(); }
});

test('connector does not archive while model-service retains an unconfirmed model lock', async () => {
  const f = await fixture({ data: [], nextCursor: null });
  let c;
  try {
    await f.resume();
    c = await connectorFixture(f, { modelRequest: async () => { assert.fail('no model RPC expected'); },
      modelJournal: { get: () => ({ phase: 'dispatched', operationId: 'unconfirmed-model' }) },
    });
    const before = f.requests.length;
    c.archive('model-locked');
    assert.equal((await c.response('model-locked')).status, 'unavailable');
    assert.equal(f.requests.length, before);
  } finally { await c?.close(); await f.close(); }
});

test('connector never retries an archive whose dispatched outcome is unknown', async () => {
  const f = await fixture({ data: [], nextCursor: null }, { holdMethods: ['thread/archive'], timeout: 100 });
  let c;
  try {
    await f.resume();
    c = await connectorFixture(f);
    c.archive('timeout');
    assert.equal((await c.response('timeout')).status, 'unknown');
    assert.equal(f.requests.filter(request => request.method === 'thread/archive').length, 1);
    c.archive('retry');
    assert.equal((await c.response('retry')).status, 'unavailable');
    assert.equal(f.requests.filter(request => request.method === 'thread/archive').length, 1);
  } finally { await c?.close(); await f.close(); }
});
