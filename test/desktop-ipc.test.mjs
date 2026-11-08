import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { DesktopSession } from '../src/desktop/session.mjs';

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

function socketPathFor(directory, name = 'socket') {
  return process.platform === 'win32'
    ? `\\\\.\\pipe\\codex-phone-test-${name}-${randomUUID()}`
    : join(directory, name);
}

async function fixture(handler) {
  const dir = await mkdtemp(join(tmpdir(), 'hub-ipc-'));
  const socketPath = socketPathFor(dir);
  const server = net.createServer(socket => {
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE();
        const msg = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
        handler(socket, msg);
      }
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  return { socketPath, async close() { await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); } };
}

test('non-object IPC frames disconnect and reject pending discovery', async () => {
  for (const value of [null, [], 'invalid', 1]) {
    const f = await fixture((socket, msg) => {
      if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
      else if (msg.method === 'thread-owner-discovery') socket.write(frame(value));
    });
    const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
    try {
      await client.connect();
      await assert.rejects(client.discover('thread'), /Invalid IPC message/);
      assert.equal(client.state, 'closed');
      assert.equal(client.pending.size, 0);
    } finally { await client.close(); await f.close(); }
  }
});

test('direct custom-socket owner probes preserve targeted history revision verification', async () => {
  const probes = [];
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
    else {
      probes.push(msg);
      socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: { revision: 42 } }));
    }
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    assert.deepEqual(await client.probeOwner('thread', 'owner'), { revision: 42 });
    assert.equal(probes.length, 1);
    assert.equal(probes[0].method, 'thread-follower-load-complete-history');
    assert.equal(probes[0].targetClientId, 'owner');
    assert.deepEqual(probes[0].params, { conversationId: 'thread' });
  } finally { await client.close(); await f.close(); }
});

function discoveryRequest(requestId, method = 'thread-owner-discovery') {
  return { type: 'client-discovery-request', requestId, request: {
    type: 'request', requestId: `request-${requestId}`, sourceClientId: 'another-client', version: 1,
    method, params: { hostId: 'local', conversationId: 'thread' },
  } };
}

test('a read-only follower promptly declines router discovery without claiming or executing a request', async () => {
  const answers = []; let original;
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'follower' } }));
    else if (msg.method === 'thread-owner-discovery') {
      original = msg;
      socket.write(frame(discoveryRequest('outer-discovery-id')));
    } else if (msg.type === 'client-discovery-response') {
      answers.push(msg);
      assert.equal(msg.requestId, 'outer-discovery-id');
      socket.write(frame({ type: 'response', requestId: original.requestId, resultType: 'error', error: 'no-client-found' }));
    } else assert.fail(`unexpected request ${msg.type}:${msg.method}`);
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 500 });
  try {
    await client.connect();
    await assert.rejects(client.discover('unowned-thread'), { code: 'no-client-found' });
    assert.deepEqual(answers, [{ type: 'client-discovery-response', requestId: 'outer-discovery-id', response: { canHandle: false } }]);
    assert.equal(client.state, 'ready'); assert.equal(client.pending.size, 0); assert.equal(client.subscriptions.size, 0);
  } finally { await client.close(); await f.close(); }
});

test('fragmented and batched discovery requests decline all methods while preserving replies and stream events', async () => {
  const answers = [];
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'follower' } }));
    else if (msg.type === 'client-discovery-response') answers.push(msg);
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    const changes = []; await client.subscribe('thread', change => changes.push(change));
    const methods = ['thread-owner-discovery', 'thread-follower-start-turn', 'thread-follower-load-complete-history', 'unknown-method'];
    for (const [index, method] of methods.entries()) {
      const value = discoveryRequest(`outer-${index}`, method);
      if (index === 3) value.request.version = 0;
      for (const byte of frame(value)) client.receive(Buffer.from([byte]));
    }
    const discovery = client.discover('other');
    const requestId = [...client.pending.keys()][0];
    client.receive(Buffer.concat([
      frame(discoveryRequest(requestId)),
      frame({ type: 'response', requestId, resultType: 'success', handledByClientId: 'owner', result: {} }),
      frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { hostId: 'local', conversationId: 'thread', change: { type: 'snapshot', revision: 1 } } }),
    ]));
    assert.equal((await discovery).ownerId, 'owner');
    await client.discover('flush');
    assert.deepEqual(answers.map(answer => answer.requestId), ['outer-0', 'outer-1', 'outer-2', 'outer-3', requestId]);
    assert.ok(answers.every(answer => answer.response.canHandle === false));
    assert.deepEqual(changes, [{ type: 'snapshot', revision: 1 }]);
    assert.equal(client.pending.size, 0); assert.equal(client.subscriptions.size, 1);
  } finally { await client.close(); await f.close(); }
});

test('malformed discovery envelopes receive no response and cannot disturb pending requests', async () => {
  const answers = [];
  const f = await fixture((socket, msg) => {
    if (msg.type === 'client-discovery-response') answers.push(msg);
    else socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: msg.method === 'initialize' ? { clientId: 'follower' } : {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    const valid = discoveryRequest('valid');
    const invalid = [
      ...[undefined, null, 1, {}, [], '', ' ', 'bad\nidentifier', 'x'.repeat(129)].map(requestId => ({ ...valid, requestId })),
      ...[undefined, null, 'request', [], 1].map(request => ({ ...valid, request })),
      ...[
        { type: 'response' }, { requestId: '' }, { method: '' }, { method: { toString: 'unsafe' } },
        { version: -1 }, { version: 0.5 }, { version: '1' }, { version: false },
      ].map(change => ({ ...valid, request: { ...valid.request, ...change } })),
    ];
    client.receive(Buffer.concat(invalid.map(frame)));
    assert.equal((await client.discover('still-working')).ownerId, 'owner');
    assert.deepEqual(answers, []);
    assert.equal(client.state, 'ready'); assert.equal(client.pending.size, 0);
  } finally { await client.close(); await f.close(); }
});

test('discovery without a handler declines optional version and opaque params as the native protocol does', async () => {
  const answers = [];
  const f = await fixture((socket, msg) => {
    if (msg.type === 'client-discovery-response') answers.push(msg);
    else socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: msg.method === 'initialize' ? { clientId: 'follower' } : {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    const requests = [undefined, null, 0, 1].flatMap(version => [undefined, null, [], 'opaque', 1].map(params => {
      const request = discoveryRequest(`optional-${String(version)}-${String(params)}`, 'unknown-method');
      request.request.version = version; request.request.params = params;
      return request;
    }));
    client.receive(Buffer.concat(requests.map(frame)));
    await client.discover('flush');
    assert.deepEqual(answers.map(answer => answer.requestId), requests.map(request => request.requestId));
    assert.ok(answers.every(answer => answer.response.canHandle === false));
    assert.equal(client.pending.size, 0); assert.equal(client.subscriptions.size, 0);
  } finally { await client.close(); await f.close(); }
});

test('discovery around a batched initialization response is declined without changing connect state, and ignored after close', async () => {
  const answers = []; let peer;
  const f = await fixture((socket, msg) => {
    peer = socket;
    if (msg.type === 'client-discovery-response') answers.push(msg);
    else if (msg.method === 'initialize') socket.write(Buffer.concat([
      frame(discoveryRequest('before-ready')),
      frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'follower' } }),
      frame(discoveryRequest('after-registration')),
    ]));
    else socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  const receiveStates = [];
  const receive = client.receive.bind(client);
  client.receive = chunk => { receiveStates.push(client.state); receive(chunk); receiveStates.push(client.state); };
  try {
    await client.connect();
    assert.deepEqual(receiveStates, ['connecting', 'connecting']);
    assert.equal(client.state, 'ready');
    await client.discover('flush');
    assert.deepEqual(answers.map(answer => answer.requestId), ['before-ready', 'after-registration']);
    assert.ok(answers.every(answer => answer.response.canHandle === false));
    const closing = client.close();
    assert.doesNotThrow(() => client.receive(frame(discoveryRequest('while-closing'))));
    await closing;
    assert.doesNotThrow(() => client.receive(frame(discoveryRequest('after-closed'))));
    assert.equal(answers.length, 2); assert.equal(client.state, 'closed');
  } finally { peer?.destroy(); await client.close(); await f.close(); }
});

test('owner status requests reannounce only existing subscriptions for that exact owner and host', async () => {
  const follows = [];
  let peer;
  const f = await fixture((socket, msg) => {
    peer = socket;
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId,
      resultType: 'success', result: { clientId: 'follower' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId,
      resultType: 'success', handledByClientId: 'owner', result: {} }));
    else if (msg.method === 'thread-stream-following-changed') follows.push(msg);
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  const query = (sourceClientId, conversationId, hostId = 'local') => frame({ type: 'broadcast',
    method: 'thread-stream-following-status-requested', sourceClientId, params: { conversationId, hostId } });
  try {
    await client.connect();
    const off = await client.subscribe('thread', () => {});
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(follows.length, 1);
    peer.write(Buffer.concat([query('other-owner', 'thread'), query('owner', 'other-thread'), query('owner', 'thread', 'other-host')]));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(follows.length, 1);
    peer.write(query('owner', 'thread'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(follows.length, 2);
    assert.deepEqual(follows[1].targetClientIds, ['owner']);
    assert.equal(follows[1].params.following, true);
    off();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(follows.at(-1).params.following, false);
    const count = follows.length;
    peer.write(query('owner', 'thread'));
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(follows.length, count);
  } finally { await client.close(); await f.close(); }
});

test('closing a half-open peer cannot block session recovery indefinitely', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hub-ipc-half-open-'));
  const socketPath = socketPathFor(dir);
  let peer;
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    peer = socket;
    socket.on('data', chunk => {
      const msg = JSON.parse(chunk.subarray(4, chunk.readUInt32LE() + 4).toString());
      if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
    });
  });
  await new Promise(resolve => server.listen(socketPath, resolve));
  const client = new DesktopIpc({ socketPath, timeout: 50 });
  try {
    await client.connect();
    await Promise.race([client.close(), new Promise((_, reject) => setTimeout(() => reject(new Error('close hung')), 500))]);
    assert.equal(client.state, 'closed');
  } finally { peer?.destroy(); await new Promise(resolve => server.close(resolve)); await rm(dir, { recursive: true, force: true }); }
});

test('closing tolerates a socket destroyed before its close event', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
  });
  const original = net.createConnection;
  let socket;
  net.createConnection = (...args) => (socket = original(...args));
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 100 });
  try {
    await client.connect();
    await client.subscribe('thread', () => {});
    socket.destroy();
    await client.close();
    assert.equal(client.state, 'closed');
  } finally { net.createConnection = original; await client.close(); await f.close(); }
});

test('matches fragmented, out-of-order responses and cleans up subscription', async () => {
  const discoveries = [], follows = [];
  let resolveUnfollow;
  const unfollowed = new Promise(resolve => { resolveUnfollow = resolve; });
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') {
      const response = frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } });
      socket.write(response.subarray(0, 2)); socket.write(response.subarray(2));
    } else if (msg.method === 'thread-owner-discovery') {
      discoveries.push(msg);
      if (discoveries.length === 2) for (const item of discoveries.reverse()) socket.write(frame({ type: 'response', requestId: item.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
    } else if (msg.method === 'thread-stream-following-changed') {
      follows.push(msg.params.following);
      if (msg.params.following) {
        const messages = ['snapshot', 'patches'].map(type => frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', hostId: 'local', change: { type } } }));
        socket.write(Buffer.concat(messages));
      } else resolveUnfollow();
    }
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    assert.equal(client.send, undefined);
    assert.equal(client.request, undefined);
    assert.equal(client.follow, undefined);
    assert.equal(client.socket, undefined);
    const events = [];
    const [unsubscribe, other] = await Promise.all([client.subscribe('thread', change => events.push(change.type)), client.discover('other')]);
    assert.equal(other.ownerId, 'owner');
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(events, ['snapshot', 'patches']);
    assert.equal(unsubscribe(), true);
    await unfollowed;
    assert.deepEqual(follows, [true, false]);
  } finally { await client.close(); await f.close(); }
});

test('reassembles byte-split headers and bodies across consecutive frames', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath });
  try {
    await client.connect();
    const received = [];
    await client.subscribe('thread', change => received.push(change.text));
    const packet = Buffer.concat(['第一条', 'second'].map(text => frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', change: { text } } })));
    for (const byte of packet) client.receive(Buffer.from([byte]));
    assert.deepEqual(received, ['第一条', 'second']);
    assert.equal(client.frameBytes, 0);
    assert.equal(client.frameChunks.length, 0);
  } finally { await client.close(); await f.close(); }
});

test('rejects an oversized split frame header before reading its body', async () => {
  let peer;
  const f = await fixture((socket, msg) => {
    peer = socket;
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, maxFrame: 512 });
  try {
    await client.connect();
    const closed = new Promise(resolve => client.once('disconnect', resolve));
    const header = Buffer.alloc(4); header.writeUInt32LE(513);
    client.receive(header.subarray(0, 2));
    client.receive(header.subarray(2));
    const result = await closed;
    assert.match(result.error.message, /frame too large/);
    assert.equal(client.frameChunks.length, 0);
  } finally { peer?.destroy(); await client.close(); await f.close(); }
});

test('accepts a frame at the byte limit and rejects invalid JSON', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, maxFrame: 512 });
  try {
    await client.connect();
    let received;
    await client.subscribe('thread', change => { received = change.text; });
    const message = { type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', change: { text: '' } } };
    message.params.change.text = 'x'.repeat(512 - Buffer.byteLength(JSON.stringify(message)));
    const atLimit = frame(message);
    assert.equal(atLimit.readUInt32LE(), 512);
    client.receive(atLimit);
    assert.equal(received, message.params.change.text);
    const closed = new Promise(resolve => client.once('disconnect', resolve));
    client.receive(Buffer.from([1, 0, 0, 0, 123]));
    assert.match((await closed).error.message, /Invalid IPC JSON/);
  } finally { await client.close(); await f.close(); }
});

test('disconnect discards an incomplete frame and rejects pending requests', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test' } }));
    else if (msg.method === 'thread-owner-discovery') {
      const response = frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} });
      socket.end(response.subarray(0, 8));
    }
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    await assert.rejects(client.discover('thread'), /disconnect/i);
    assert.equal(client.frameLength, null);
    assert.equal(client.frameChunks.length, 0);
    assert.equal(client.frameBytes, 0);
  } finally { await client.close(); await f.close(); }
});

test('listener exceptions do not stop subsequent events', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
    else if (msg.method === 'thread-stream-following-changed' && msg.params.following) {
      for (const type of ['snapshot', 'patches']) socket.write(frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', change: { type } } }));
    }
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    const errors = [], received = [];
    client.on('listenerError', error => errors.push(error.message));
    await client.subscribe('thread', change => { received.push(change.type); if (change.type === 'snapshot') throw new Error('listener failed'); });
    await new Promise(resolve => setTimeout(resolve, 25));
    assert.deepEqual(errors, ['listener failed']);
    assert.deepEqual(received, ['snapshot', 'patches']);
  } finally { await client.close(); await f.close(); }
});

test('rejects pending discovery on disconnect', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else socket.destroy();
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try { await client.connect(); await assert.rejects(client.discover('thread'), /disconnect/i); }
  finally { await client.close(); await f.close(); }
});

test('a stale unsubscribe cannot cancel a replacement subscription', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    const old = await client.subscribe('thread', () => {});
    assert.equal(client.unsubscribe('thread'), true);
    const current = await client.subscribe('thread', () => {});
    assert.equal(old(), false);
    assert.equal(current(), true);
  } finally { await client.close(); await f.close(); }
});

test('reports a verified owner disconnect broadcast', async () => {
  let connection;
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') { connection = socket; socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } })); }
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect(); const events = []; client.on('ownerDisconnected', id => events.push(id));
    connection.write(frame({ type: 'broadcast', method: 'client-status-changed', sourceClientId: 'owner', params: { clientId: 'owner', status: 'disconnected' } }));
    connection.write(frame({ type: 'broadcast', method: 'client-status-changed', sourceClientId: 'other', params: { clientId: 'owner', status: 'disconnected' } }));
    await new Promise(resolve => setTimeout(resolve, 20)); assert.deepEqual(events, ['owner']);
  } finally { await client.close(); await f.close(); }
});

test('times out unanswered requests', async () => {
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 60 });
  try { await client.connect(); await assert.rejects(client.discover('thread'), /timed out/); assert.equal(client.pending.size, 0); }
  finally { await client.close(); await f.close(); }
});

test('routes explicit control operations to discovered owner with correct versions', async () => {
  const calls = [];
  const f = await fixture((socket, msg) => {
    calls.push(msg);
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
    else socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: { ok: true } }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    const options = { expectedOwnerId: 'owner' };
    const imagePath = join(tmpdir(), 'photo.png');
    const cwd = tmpdir();
    assert.deepEqual(await client.startTurn('thread', { request: { input: [] }, context: {} }, options), { ok: true });
    await client.steerTurn('thread', [{ type: 'text', text: 'hello' }, { type: 'localImage', path: imagePath }], { ...options, cwd, clientUserMessageId: 'message' });
    await client.interruptTurn('thread', 'turn', options);
    await client.replyCommandApproval('thread', 42, 'decline', options);
    await client.replyFileApproval('thread', 'req', 'accept', options);
    await client.replyUserInput('thread', 3, { answers: {} }, options);
    await client.setCollaborationMode('thread', 'plan', { model: 'model', reasoning_effort: 'high', developer_instructions: 'retain this' }, options);
    const writes = calls.filter(m => m.method.startsWith('thread-follower-'));
    assert.deepEqual(writes.map(m => [m.method, m.version, m.targetClientId]), [
      ['thread-follower-start-turn', 2, 'owner'], ['thread-follower-steer-turn', 1, 'owner'],
      ['thread-follower-interrupt-turn', 4, 'owner'], ['thread-follower-command-approval-decision', 1, 'owner'],
      ['thread-follower-file-approval-decision', 1, 'owner'], ['thread-follower-submit-user-input', 1, 'owner'],
      ['thread-follower-update-thread-settings', 2, 'owner'],
    ]);
    assert.deepEqual(writes[0].params, { conversationId: 'thread', turnStart: { request: { input: [] }, context: {} } });
    assert.deepEqual(writes[1].params.input, [{ type: 'text', text: 'hello' }, { type: 'localImage', path: imagePath }]);
    assert.equal(writes[1].params.clientUserMessageId, 'message');
    assert.equal(writes[1].params.restoreMessage.id, 'message');
    assert.equal(writes[1].params.restoreMessage.text, 'hello');
    assert.deepEqual(writes[1].params.restoreMessage.context.imageAttachments, [{ id: 'message:1', src: imagePath, localPath: imagePath }]);
    assert.deepEqual(writes[1].params.restoreMessage.context.workspaceRoots, [cwd]);
    await assert.rejects(client.steerTurn('thread', [{ type: 'text', text: 'hello' }]), /absolute cwd required/);
    assert.deepEqual(writes[2].params, { conversationId: 'thread', mode: 'user-stop', expectedTurnId: 'turn' });
    assert.deepEqual(writes[3].params, { conversationId: 'thread', requestId: 42, decision: 'decline' });
    assert.deepEqual(writes[4].params, { conversationId: 'thread', requestId: 'req', decision: 'accept' });
    assert.deepEqual(writes[5].params, { conversationId: 'thread', requestId: 3, response: { answers: {} } });
    assert.deepEqual(writes[6].params.threadSettings.collaborationMode, { mode: 'plan', settings: { model: 'model', reasoning_effort: 'high', developer_instructions: 'retain this' } });
    assert.equal(calls.filter(m => m.method === 'thread-owner-discovery').length, 7);
    await assert.rejects(client.replyCommandApproval('thread', 1, 'unknown'), /unsupported/);
  } finally { await client.close(); await f.close(); }
});

test('mode change rejects stale settings when state changes during owner discovery', async () => {
  let discoveries = 0, writes = 0;
  const state = model => ({ id: 'thread', threadRuntimeStatus: { type: 'idle' }, latestCollaborationMode: { mode: 'default', settings: { model, reasoning_effort: 'high', developer_instructions: null } }, turns: [] });
  const broadcast = (revision, model) => frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', hostId: 'local', change: { type: 'snapshot', revision, conversationState: state(model) } } });
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else if (msg.method === 'thread-owner-discovery') {
      discoveries++;
      const response = frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} });
      socket.write(discoveries === 2 ? Buffer.concat([broadcast(2, 'new-model'), response]) : response);
    } else if (msg.method === 'thread-stream-following-changed' && msg.params.following) socket.write(broadcast(1, 'old-model'));
    else if (msg.method === 'thread-follower-update-thread-settings') { writes++; socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: { applied: true } })); }
  });
  const session = new DesktopSession({ conversationId: 'thread', createClient: () => new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 }) });
  try {
    const ready = new Promise(resolve => session.on('state', event => { if (event.status === 'ready') resolve(); }));
    session.start();
    await ready;
    await assert.rejects(session.setCollaborationMode('plan'), { code: 'unavailable' });
    assert.equal(session.value.latestCollaborationMode.settings.model, 'new-model');
    assert.equal(writes, 0);
    assert.deepEqual(await session.setCollaborationMode('plan'), { applied: true });
    assert.equal(writes, 1);
  } finally { await session.close(); await f.close(); }
});

for (const runtime of ['idle', 'active']) {
  test(`message rejects stale ${runtime} state changed during owner discovery`, async () => {
    let discoveries = 0, writes = 0;
    const state = type => ({ id: 'thread', cwd: '/tmp', threadRuntimeStatus: { type }, turns: type === 'active' ? [{ turnId: 'turn', status: 'inProgress' }] : [] });
    const broadcast = (revision, type) => frame({ type: 'broadcast', method: 'thread-stream-state-changed', sourceClientId: 'owner', params: { conversationId: 'thread', hostId: 'local', change: { type: 'snapshot', revision, conversationState: state(type) } } });
    const f = await fixture((socket, msg) => {
      if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
      else if (msg.method === 'thread-owner-discovery') {
        discoveries++;
        const response = frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} });
        socket.write(discoveries === 2 ? Buffer.concat([broadcast(2, runtime === 'idle' ? 'active' : 'idle'), response]) : response);
      } else if (msg.method === 'thread-stream-following-changed' && msg.params.following) socket.write(broadcast(1, runtime));
      else if (msg.method === 'thread-follower-start-turn' || msg.method === 'thread-follower-steer-turn') writes++;
    });
    const session = new DesktopSession({ conversationId: 'thread', createClient: () => new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 }) });
    try {
      const ready = new Promise(resolve => session.on('state', event => { if (event.status === 'ready') resolve(); }));
      session.start(); await ready;
      await assert.rejects(session.sendText('test'), { code: 'unavailable' });
      assert.equal(writes, 0);
    } finally { await session.close(); await f.close(); }
  });
}

test('control reports owner errors and does not retry timed-out writes', async () => {
  let writes = 0;
  const f = await fixture((socket, msg) => {
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner', result: {} }));
    else if (++writes === 1) socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'error', error: 'owner-rejected' }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 60 });
  try {
    await client.connect();
    await assert.rejects(client.interruptTurn('thread', 'turn', { expectedOwnerId: 'owner' }), /IPC request failed/);
    await assert.rejects(client.interruptTurn('thread', 'turn', { expectedOwnerId: 'owner' }), /timed out/);
    assert.equal(writes, 2);
    assert.equal(client.pending.size, 0);
  } finally { await client.close(); await f.close(); }
});

test('rejects changed or missing owner before sending a write frame', async () => {
  const calls = [];
  const f = await fixture((socket, msg) => {
    calls.push(msg);
    if (msg.method === 'initialize') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', result: { clientId: 'test-client' } }));
    else if (msg.method === 'thread-owner-discovery') socket.write(frame({ type: 'response', requestId: msg.requestId, resultType: 'success', handledByClientId: 'owner-new', result: {} }));
  });
  const client = new DesktopIpc({ socketPath: f.socketPath, timeout: 1000 });
  try {
    await client.connect();
    await assert.rejects(client.steerTurn('thread', [{ type: 'text', text: 'hello' }], { cwd: tmpdir(), expectedOwnerId: 'owner-old' }), { code: 'unavailable' });
    await assert.rejects(client.interruptTurn('thread', 'turn'), /expectedOwnerId required/);
    assert.equal(calls.filter(msg => msg.method.startsWith('thread-follower-')).length, 0);
  } finally { await client.close(); await f.close(); }
});
