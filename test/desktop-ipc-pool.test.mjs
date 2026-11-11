import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { DesktopIpcPool } from '../src/desktop/ipc-pool.mjs';

function packet(value) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length); return Buffer.concat([header, body]);
}
async function until(check) {
  const deadline = Date.now() + 2000;
  while (!check()) { if (Date.now() > deadline) throw new Error('condition timed out'); await delay(2); }
}
async function fixture({ idleMs = 30000, onRequest } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'hub-ipc-pool-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\hub-pool-${randomUUID()}` : join(directory, 'ipc.sock');
  const sockets = new Set(), messages = [], revisions = new Map();
  let connections = 0, closedConnections = 0;
  const reply = (socket, msg, result = {}) => socket.write(packet({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result }));
  const change = (socket, id, type = 'snapshot') => {
    const revision = (revisions.get(id) || 0) + 1; revisions.set(id, revision);
    socket.write(packet({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: {
      conversationId: id, hostId: 'local', change: type === 'snapshot'
        ? { type, revision, conversationState: { id, threadRuntimeStatus: { type: 'idle' } } }
        : { type, revision, baseRevision: revision - 1, patches: [] },
    } }));
  };
  const server = net.createServer(socket => {
    const index = ++connections; sockets.add(socket); let input = Buffer.alloc(0);
    socket.on('error', () => {});
    socket.once('close', () => { sockets.delete(socket); closedConnections++; });
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4 && input.length >= 4 + input.readUInt32LE()) {
        const size = input.readUInt32LE(), msg = JSON.parse(input.subarray(4, size + 4)); input = input.subarray(size + 4);
        messages.push(msg);
        if (onRequest?.({ socket, msg, reply, index })) continue;
        if (msg.method === 'initialize') reply(socket, msg, { clientId: `client-${index}` });
        else if (msg.method === 'thread-owner-discovery') reply(socket, msg);
        else if (msg.method === 'thread-stream-following-changed') { if (msg.params.following) change(socket, msg.params.conversationId); }
        else reply(socket, msg, { ok: true });
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const pool = new DesktopIpcPool({ idleMs, createClient: () => new DesktopIpc({ socketPath, timeout: 1000 }) });
  return { pool, messages, sockets, reply, change, get connections() { return connections; }, get closedConnections() { return closedConnections; },
    async close() { await pool.close(); for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); await rm(directory, { recursive: true, force: true }); } };
}

test('80 conversation leases reuse one physical connection without retaining snapshots', { timeout: 10000 }, async () => {
  const f = await fixture();
  try {
    for (let i = 0; i < 80; i++) {
      const lease = await f.pool.acquire().connect(); let received = null;
      await lease.subscribe(`thread-${i % 2}`, change => { received = change; });
      await until(() => received?.type === 'snapshot');
      await lease.close();
      assert.equal(f.pool.entries.size, 0);
    }
    await until(() => f.messages.filter(m => m.method === 'thread-stream-following-changed' && !m.params.following).length === 80);
    assert.equal(f.connections, 1);
    assert.equal(f.messages.filter(m => m.method === 'initialize').length, 1);
    assert.equal(f.pool.leases.size, 0);
    assert.equal(f.pool.client.state, 'ready');
  } finally { await f.close(); }
});

test('a second consumer receives a fresh baseline and releasing it leaves the first subscribed', async () => {
  const f = await fixture();
  try {
    const a = await f.pool.acquire().connect(), first = [];
    await a.subscribe('thread', change => first.push(change)); await until(() => first.length === 1);
    const b = await f.pool.acquire().connect(), second = [];
    await b.subscribe('thread', change => second.push(change)); await until(() => second.length === 1);
    assert.equal(second[0].type, 'snapshot'); assert.ok(second[0].revision > first[0].revision);
    assert.equal(first.length, 2);
    await b.close();
    const socket = [...f.sockets][0]; f.change(socket, 'thread', 'patches');
    await until(() => first.length === 3);
    assert.equal(second.length, 1); assert.equal(first.at(-1).type, 'patches');
    assert.equal(f.messages.filter(m => m.method === 'thread-stream-following-changed' && !m.params.following).length, 0);
    assert.equal(a.state, 'ready'); assert.equal(f.connections, 1);
    await a.close();
    await until(() => f.messages.some(m => m.method === 'thread-stream-following-changed' && !m.params.following));
  } finally { await f.close(); }
});

test('physical disconnection invalidates every lease and the next lease reconnects without old listeners', async () => {
  const f = await fixture();
  try {
    const a = await f.pool.acquire().connect(), b = await f.pool.acquire().connect();
    let disconnectedA = 0, disconnectedB = 0, oldEvents = 0;
    a.on('disconnect', () => disconnectedA++); b.on('disconnect', () => disconnectedB++);
    await a.subscribe('thread', () => oldEvents++); await until(() => oldEvents === 1);
    [...f.sockets][0].destroy(); await until(() => disconnectedA && disconnectedB);
    assert.equal(disconnectedA, 1); assert.equal(disconnectedB, 1);
    assert.equal(a.state, 'closed'); assert.equal(b.state, 'closed'); assert.equal(f.pool.entries.size, 0);
    const c = await f.pool.acquire().connect(); let currentEvents = 0;
    await c.subscribe('thread', () => currentEvents++); await until(() => currentEvents === 1);
    assert.equal(f.connections, 2); assert.equal(oldEvents, 1);
    await a.close(); assert.equal(c.state, 'ready');
  } finally { await f.close(); }
});

test('a joining consumer skips in-flight patches until its baseline while the existing consumer keeps receiving them', async () => {
  const f = await fixture();
  try {
    const a = await f.pool.acquire().connect(), first = [];
    await a.subscribe('thread', change => first.push(change)); await until(() => first.length === 1);
    const b = await f.pool.acquire().connect(), second = [];
    const refresh = f.pool.client.refreshSubscription.bind(f.pool.client);
    f.pool.client.refreshSubscription = (id, host) => {
      const listener = f.pool.client.subscriptions.get(JSON.stringify([host, id])).listener;
      listener({ type: 'patches', revision: 2, baseRevision: 1, patches: [] }, { ownerId: 'owner', hostId: 'local', conversationId: id });
      refresh(id, host);
    };
    await b.subscribe('thread', change => second.push(change)); await until(() => second.length === 1);
    assert.deepEqual(second.map(change => change.type), ['snapshot']);
    assert.deepEqual(first.map(change => change.type), ['snapshot', 'patches', 'snapshot']);
  } finally { await f.close(); }
});

test('closing a lease during pending discovery cancels its subscription without disconnecting a peer', async () => {
  let held;
  const f = await fixture({ onRequest({ socket, msg, reply }) {
    if (msg.method === 'thread-owner-discovery' && msg.params.conversationId === 'slow') { held = () => reply(socket, msg); return true; }
  } });
  try {
    const a = await f.pool.acquire().connect(), b = await f.pool.acquire().connect();
    const subscribing = a.subscribe('slow', () => assert.fail('closed listener called'));
    const rejected = assert.rejects(subscribing, /cancelled|closed/i);
    await until(() => held); await a.close(); held(); await rejected;
    let count = 0; await b.subscribe('fast', () => count++); await until(() => count === 1);
    assert.equal(f.connections, 1); assert.equal(b.state, 'ready');
    assert.equal(f.messages.some(m => m.method === 'thread-stream-following-changed' && m.params.conversationId === 'slow' && m.params.following), false);
  } finally { await f.close(); }
});

test('one admission gate cannot block another consumer and cancelling it does not remove the live subscription', async () => {
  const f = await fixture();
  try {
    const sidebar = await f.pool.acquire().connect(), main = await f.pool.acquire().connect();
    let release, waiting = false, sidebarEvents = 0, mainEvents = 0;
    const gate = new Promise(resolve => { release = resolve; });
    const queued = sidebar.subscribe('thread', () => sidebarEvents++, 'local', { beforeFollow: () => { waiting = true; return gate; } });
    const rejected = assert.rejects(queued, /closed/i); await until(() => waiting);
    await main.subscribe('thread', () => mainEvents++); await until(() => mainEvents === 1);
    await sidebar.close(); release(); await rejected;
    f.change([...f.sockets][0], 'thread', 'patches'); await until(() => mainEvents === 2);
    assert.equal(sidebarEvents, 0); assert.equal(main.state, 'ready');
  } finally { await f.close(); }
});

test('closing a lease prevents an approval already waiting for discovery from being dispatched', async () => {
  let held;
  const f = await fixture({ onRequest({ socket, msg, reply }) {
    if (msg.method === 'thread-owner-discovery') { held = () => reply(socket, msg); return true; }
  } });
  try {
    const a = await f.pool.acquire().connect(), b = await f.pool.acquire().connect();
    const writing = a.replyCommandApproval('thread', 'request', 'accept', { expectedOwnerId: 'owner' });
    const rejected = assert.rejects(writing, { code: 'unavailable' });
    await until(() => held); await a.close(); held(); await rejected;
    assert.equal(f.messages.some(m => m.method === 'thread-follower-command-approval-decision'), false);
    assert.equal(b.state, 'ready'); assert.equal(f.connections, 1);
  } finally { await f.close(); }
});

test('closing a lease during an asynchronous write guard prevents dispatch and keeps its peer ready', async () => {
  const f = await fixture();
  try {
    const a = await f.pool.acquire().connect(), b = await f.pool.acquire().connect();
    let release, guarding = false;
    const gate = new Promise(resolve => { release = resolve; });
    const writing = a.startTurn('thread', { request: {}, context: {} }, {
      expectedOwnerId: 'owner', beforeWrite: () => { guarding = true; return gate; },
    });
    const rejected = assert.rejects(writing, { code: 'unavailable' });
    await until(() => guarding); await a.close(); release(true); await rejected;
    assert.equal(f.messages.some(m => m.method === 'thread-follower-start-turn'), false);
    assert.equal(b.state, 'ready');
  } finally { await f.close(); }
});

test('an already dispatched write is not cancelled or retried when its lease closes', async () => {
  let held;
  const f = await fixture({ onRequest({ socket, msg, reply }) {
    if (msg.method === 'thread-follower-command-approval-decision') { held = () => reply(socket, msg, { ok: true }); return true; }
  } });
  try {
    const a = await f.pool.acquire().connect(), b = await f.pool.acquire().connect();
    const writing = a.replyCommandApproval('thread', 'request', 'accept', { expectedOwnerId: 'owner' });
    await until(() => held); await a.close(); held();
    assert.deepEqual(await writing, { ok: true });
    assert.equal(f.messages.filter(m => m.method === 'thread-follower-command-approval-decision').length, 1);
    assert.equal(b.state, 'ready');
  } finally { await f.close(); }
});

test('an idle pool closes its socket and a later lease creates a fresh connection', async () => {
  const f = await fixture({ idleMs: 20 });
  try {
    const a = await f.pool.acquire().connect(); await a.close();
    await until(() => f.closedConnections === 1);
    assert.equal(f.pool.client, null);
    const b = await f.pool.acquire().connect(); assert.equal(b.state, 'ready'); assert.equal(f.connections, 2);
    await assert.rejects(a.discover('thread'), { code: 'unavailable' });
  } finally { await f.close(); }
});

test('owner probes request a fresh baseline without hydrating history or disturbing a main stream', async () => {
  let holdRefresh = false;
  const f = await fixture({ onRequest({ msg }) {
    if (holdRefresh && msg.method === 'thread-stream-following-changed' && msg.params.following) return true;
  } });
  try {
    const main = await f.pool.acquire().connect(), changes = [];
    await main.subscribe('thread', change => changes.push(change)); await until(() => changes.length === 1);
    holdRefresh = true;
    const caller = await f.pool.acquire().connect(); let settled = false;
    const probing = caller.probeOwner('thread', 'owner', { timeout: 1000 }).then(result => { settled = true; return result; });
    await until(() => f.messages.filter(msg => msg.method === 'thread-stream-following-changed' && msg.params.following).length === 2);
    await delay(10); assert.equal(settled, false, 'an earlier snapshot cannot prove liveness');
    const socket = [...f.sockets][0];
    const broadcast = (change, sourceClientId = 'owner') => socket.write(packet({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId, params: { conversationId: 'thread', hostId: 'local', change } }));
    broadcast({ type: 'snapshot', revision: 2, conversationState: { id: 'thread' } }, 'other-owner');
    broadcast({ type: 'snapshot', revision: 2, conversationState: { id: 'different-thread' } });
    broadcast({ type: 'snapshot', revision: 1.5, conversationState: { id: 'thread' } });
    broadcast({ type: 'patches', revision: 2, baseRevision: 1, patches: [] });
    await delay(10); assert.equal(settled, false);
    f.change(socket, 'thread');
    assert.deepEqual(await probing, { revision: 2 });
    assert.equal(f.pool.entries.get(JSON.stringify(['local', 'thread'])).consumers.size, 1);
    assert.equal(f.connections, 1);
    assert.equal(f.messages.some(msg => msg.method === 'thread-follower-load-complete-history'), false);
    assert.equal(f.messages.some(msg => msg.method === 'thread-stream-following-changed' && !msg.params.following), false);
    await caller.close();
    const prior = changes.length; f.change(socket, 'thread', 'patches'); await until(() => changes.length > prior);
    assert.equal(main.state, 'ready');
  } finally { await f.close(); }
});

test('a standalone owner probe releases only its temporary subscription', async () => {
  const f = await fixture();
  try {
    const caller = await f.pool.acquire().connect();
    assert.deepEqual(await caller.probeOwner('thread', 'owner'), { revision: 1 });
    await until(() => f.messages.some(msg => msg.method === 'thread-stream-following-changed' && !msg.params.following));
    assert.equal(f.pool.entries.size, 0); assert.equal(f.pool.leases.size, 1);
    assert.equal(caller.state, 'ready'); assert.equal(f.connections, 1);
  } finally { await f.close(); }
});

test('owner probes reject a different discovered owner and clean up', async () => {
  const f = await fixture();
  try {
    const caller = await f.pool.acquire().connect();
    await assert.rejects(caller.probeOwner('thread', 'stale-owner'), { code: 'unavailable' });
    assert.equal(f.pool.entries.size, 0); assert.equal(f.pool.leases.size, 1);
  } finally { await f.close(); }
});

test('probe timeout and caller cancellation preserve a main stream on the shared connection', async () => {
  let ignoreFollow = false;
  const f = await fixture({ onRequest({ msg }) { if (ignoreFollow && msg.method === 'thread-stream-following-changed' && msg.params.following) return true; } });
  try {
    const main = await f.pool.acquire().connect(); await main.subscribe('thread', () => {});
    await until(() => f.messages.some(msg => msg.method === 'thread-stream-following-changed'));
    ignoreFollow = true;
    const caller = await f.pool.acquire().connect();
    await assert.rejects(caller.probeOwner('thread', 'owner', { timeout: 20 }), /timed out/);
    assert.equal(f.pool.entries.get(JSON.stringify(['local', 'thread'])).consumers.size, 1);
    const cancelled = caller.probeOwner('thread', 'owner', { timeout: 1000 });
    const rejected = assert.rejects(cancelled, { code: 'unavailable' });
    await until(() => f.pool.entries.get(JSON.stringify(['local', 'thread'])).consumers.size === 2);
    await caller.close(); await rejected;
    assert.equal(f.pool.leases.size, 1); assert.equal(main.state, 'ready'); assert.equal(f.connections, 1);
    assert.equal(f.messages.some(msg => msg.method === 'thread-stream-following-changed' && !msg.params.following), false);
  } finally { await f.close(); }
});

test('owner or transport disconnection rejects an outstanding probe immediately', async () => {
  const f = await fixture({ onRequest({ msg }) { if (msg.method === 'thread-stream-following-changed') return true; } });
  try {
    const caller = await f.pool.acquire().connect();
    const probing = caller.probeOwner('thread', 'owner', { timeout: 1000 });
    const rejected = assert.rejects(probing, { code: 'unavailable' });
    await until(() => f.messages.some(msg => msg.method === 'thread-stream-following-changed'));
    [...f.sockets][0].write(packet({ type: 'broadcast', method: 'client-status-changed', sourceClientId: 'owner', params: { status: 'disconnected', clientId: 'owner' } }));
    await rejected;
    const again = caller.probeOwner('thread', 'owner', { timeout: 1000 });
    const rejectedAgain = assert.rejects(again, { code: 'unavailable' });
    await until(() => f.pool.entries.size === 1);
    [...f.sockets][0].destroy(); await rejectedAgain;
    assert.equal(f.pool.entries.size, 0); assert.equal(f.pool.leases.size, 0);
  } finally { await f.close(); }
});

test('a fresh owner probe replaces stale pending discovery for every waiting consumer', async () => {
  let heldDiscovery, discoveries = 0;
  const f = await fixture({ onRequest({ socket, msg, reply }) {
    if (msg.method === 'thread-owner-discovery' && ++discoveries === 1) {
      heldDiscovery = () => reply(socket, msg); return true;
    }
  } });
  try {
    const main = await f.pool.acquire().connect(), peer = await f.pool.acquire().connect(), caller = await f.pool.acquire().connect();
    const first = [], second = [];
    const subscribing = main.subscribe('thread', change => first.push(change));
    const joining = peer.subscribe('thread', change => second.push(change));
    void subscribing.catch(() => {}); void joining.catch(() => {});
    await until(() => heldDiscovery);
    assert.equal((await caller.discover('thread')).ownerId, 'owner', 'a separate recovery discovery already sees the native owner');
    assert.deepEqual(await caller.probeOwner('thread', 'owner', { timeout: 200 }), { revision: 1 });
    await Promise.all([subscribing, joining]);
    assert.deepEqual(first.map(change => change.type), ['snapshot']);
    assert.deepEqual(second.map(change => change.type), ['snapshot']);
    heldDiscovery(); await delay(10);
    const follows = f.messages.filter(msg => msg.method === 'thread-stream-following-changed' && msg.params.following);
    assert.equal(follows.length, 1, 'late old discovery cannot issue a second follow or snapshot');
    assert.equal(f.pool.entries.get(JSON.stringify(['local', 'thread'])).consumers.size, 2);
    assert.equal(f.connections, 1);
    assert.equal(f.messages.some(msg => msg.method === 'thread-stream-following-changed' && !msg.params.following), false);
  } finally { await f.close(); }
});

test('a probe shares an already requested first baseline without issuing another follow', async () => {
  const f = await fixture({ onRequest({ msg }) {
    if (msg.method === 'thread-stream-following-changed' && msg.params.following) return true;
  } });
  try {
    const main = await f.pool.acquire().connect(), caller = await f.pool.acquire().connect();
    const changes = [];
    await main.subscribe('thread', change => changes.push(change));
    await until(() => f.messages.some(msg => msg.method === 'thread-stream-following-changed' && msg.params.following));
    const probing = caller.probeOwner('thread', 'owner', { timeout: 1000 });
    void probing.catch(() => {});
    await until(() => f.pool.entries.get(JSON.stringify(['local', 'thread'])).consumers.size === 2);
    await delay(10);
    assert.equal(f.messages.filter(msg => msg.method === 'thread-owner-discovery').length, 1);
    assert.equal(f.messages.filter(msg => msg.method === 'thread-stream-following-changed' && msg.params.following).length, 1);
    f.change([...f.sockets][0], 'thread');
    assert.deepEqual(await probing, { revision: 1 });
    assert.equal(changes.length, 1);
    assert.equal(main.state, 'ready');
  } finally { await f.close(); }
});

test('a restarted discovery still rejects an unexpected owner without removing the viewer', async () => {
  let heldDiscovery, discoveries = 0;
  const f = await fixture({ onRequest({ socket, msg, reply }) {
    if (msg.method === 'thread-owner-discovery' && ++discoveries === 1) {
      heldDiscovery = () => reply(socket, msg); return true;
    }
  } });
  try {
    const main = await f.pool.acquire().connect(), caller = await f.pool.acquire().connect();
    const changes = [], subscribing = main.subscribe('thread', change => changes.push(change));
    void subscribing.catch(() => {});
    await until(() => heldDiscovery);
    await assert.rejects(caller.probeOwner('thread', 'stale-owner', { timeout: 200 }), { code: 'unavailable' });
    await subscribing;
    assert.equal(changes.length, 1);
    assert.equal(f.pool.entries.get(JSON.stringify(['local', 'thread'])).consumers.size, 1);
    heldDiscovery(); await delay(10);
    assert.equal(f.messages.filter(msg => msg.method === 'thread-stream-following-changed' && msg.params.following).length, 1);
    assert.equal(main.state, 'ready');
    assert.equal(f.messages.some(msg => msg.method === 'thread-stream-following-changed' && !msg.params.following), false);
  } finally { await f.close(); }
});
