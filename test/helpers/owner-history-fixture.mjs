import net from 'node:net';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough, Writable } from 'node:stream';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { LocalOwner } from '../../src/desktop/local-owner.mjs';

export const threadId = '11111111-1111-4111-8111-111111111111';
export const turn = (id, startedAt = 1, itemsView = 'summary') => ({ id, startedAt, status: 'completed', itemsView,
  items: [{ id: `message-${id}`, type: 'agentMessage', text: `answer ${id}` }] });
const frame = value => {
  const body = Buffer.from(JSON.stringify(value));
  const header = Buffer.alloc(4); header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
};
export async function until(predicate, label = 'condition') {
  const deadline = Date.now() + 2500;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}`);
    await delay(5);
  }
}

// 1 GiB is a fixture metadata value, never a string/Buffer allocation.
// A mistaken full read is recorded; native tests explicitly release its reply.
export async function fixture(page, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'bounded-owner-test-'));
  const requests = [], frames = [], rawResponses = [], peers = new Set();
  let ownerSocket, child, readResponse, readError;
  const reads = [];
  const server = net.createServer(socket => {
    peers.add(socket); ownerSocket = socket;
    socket.once('close', () => peers.delete(socket));
    let input = Buffer.alloc(0);
    socket.on('data', chunk => {
      input = Buffer.concat([input, chunk]);
      while (input.length >= 4 && input.length >= input.readUInt32LE() + 4) {
        const length = input.readUInt32LE();
        const message = JSON.parse(input.subarray(4, length + 4));
        input = input.subarray(length + 4); frames.push(message);
        if (message.method === 'initialize' && message.type === 'request') {
          socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'success',
            result: { clientId: 'bounded-owner' } }));
        }
      }
    });
  });
  const socketPath = process.platform === 'win32'
    ? `\\\\.\\pipe\\bounded-owner-test-${randomUUID()}` : join(directory, 'ipc.sock');
  await new Promise(resolve => server.listen(socketPath, resolve));
  const metadata = { id: threadId, cwd: directory, model: 'actual-model', historyMode: 'paginated',
    turns: [], status: { type: 'idle' }, createdAt: 1, updatedAt: 2,
    extra: { fixtureRolloutBytes: 1024 ** 3 } };
  const emit = value => child.stdout.write(`${JSON.stringify(value)}\n`);
  const spawnProcess = () => {
    child = new EventEmitter();
    Object.assign(child, { pid: 1, exitCode: null, signalCode: null, stdout: new PassThrough(), stderr: new PassThrough() });
    child.stdin = new Writable({ write(chunk, _encoding, done) {
      for (const line of String(chunk).trim().split('\n')) {
        const request = JSON.parse(line);
        if (!request.method) { rawResponses.push(request); continue; }
        if (request.id == null) continue;
        requests.push(request);
        if (request.method === 'thread/unsubscribe' || options.holdMethods?.includes(request.method)) continue;
        if (request.method === 'thread/read') {
          reads.push(request);
          if (readError) queueMicrotask(() => emit({ id: request.id, error: { code: -1, message: 'fixture read failed' } }));
          else if (readResponse) queueMicrotask(() => emit({ id: request.id, result: readResponse }));
          continue;
        }
        const result = request.method === 'thread/resume'
          ? { thread: metadata, initialTurnsPage: page, model: 'actual-model', reasoningEffort: 'high' }
          : {};
        queueMicrotask(() => emit({ id: request.id, result }));
      }
      done();
    } });
    child.kill = () => { child.exitCode = 0; child.emit('exit', 0); child.emit('close', 0); };
    return child;
  };
  const local = await new LocalOwner({ binary: 'fake-only', cwd: directory, socketPath, spawnProcess,
    ...(options.graceMs !== undefined ? { allowInsecureForTests: true, idleReleaseGraceMsForTests: options.graceMs } : {}),
    ...(options.timeout !== undefined ? { timeout: options.timeout } : {}) }).start();
  const snapshots = () => frames.filter(message => message.method === 'thread-stream-state-changed'
    && message.params?.change?.type === 'snapshot');
  let serial = 0;
  return { local, metadata, requests, reads, frames, rawResponses, snapshots, socketPath,
    state: () => local.owner._debugSnapshot(threadId),
    async resume() { await local.resume(threadId); await until(() => snapshots().length, 'initial IPC snapshot'); },
    notify: emit,
    follower(following, sourceClientId = 'isolated-native-follower', { phone = false, source } = {}) {
      ownerSocket.write(frame({ type: 'broadcast', method: 'thread-stream-following-changed', sourceClientId,
        params: { conversationId: threadId, hostId: 'local', following,
          ...(phone || source ? { remodexFollowerSource: source || 'codex-phone-assistant' } : {}) } }));
    },
    disconnectFollower(clientId) {
      ownerSocket.write(frame({ type: 'broadcast', method: 'client-status-changed', sourceClientId: clientId,
        params: { clientId, status: 'disconnected' } }));
    },
    disconnectOwner() { ownerSocket.destroy(); },
    reply(request, result) {
      emit({ id: request.id, result });
      if (request.method === 'thread/unsubscribe' && ['unsubscribed', 'notSubscribed'].includes(result?.status)
          && options.disableAutoClosed !== true) {
        emit({ method: 'thread/closed', params: { threadId: request.params.threadId } });
      }
    },
    reject(request, message = 'fixture rejection') { emit({ id: request.id, error: { code: -1, message } }); },
    native(method, params = {}) {
      const requestId = `native-${++serial}`;
      ownerSocket.write(frame({ type: 'request', method, requestId,
        params: { conversationId: threadId, ...params }, sourceClientId: 'isolated-native-follower' }));
      return requestId;
    },
    nativeDiscovery(method, params = {}) {
      const requestId = `native-discovery-${++serial}`;
      ownerSocket.write(frame({ type: 'client-discovery-request', requestId,
        request: { method, params: { conversationId: threadId, ...params } } }));
      return requestId;
    },
    replyFor: id => frames.find(message => message.type === 'response' && message.requestId === id),
    fullRead(result) { readResponse = result; for (const request of reads) emit({ id: request.id, result }); },
    failRead() { readError = true; },
    async close() {
      await local.close({ force: true });
      for (const peer of peers) peer.destroy();
      await new Promise(resolve => server.close(resolve));
      await rm(directory, { recursive: true, force: true });
    },
  };
}

