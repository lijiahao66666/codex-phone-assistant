import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createPairRelay } from '../src/relay/server.mjs';
import { createPreviewConnector } from '../src/transport/preview-connector.mjs';
import { DesktopIpc } from '../src/desktop/ipc.mjs';
import { discoverDesktopOwner } from '../src/desktop/owner-runtime.mjs';
import { OwnerRouter } from '../src/desktop/owner-router.mjs';
import { CreationJournal } from '../src/desktop/creation-journal.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(predicate) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail('recovery did not settle');
}
function frame(value) {
  const body = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  return Buffer.concat([header, body]);
}

// All three transports are real sockets; both journals and the simulated
// desktop owner are isolated from the user's Codex data and native IPC bus.
async function fixture({ recoveryResponseTimeoutMs, requestTimeoutMs, discovery = async () => {}, resume = async () => {}, listThreads = async () => ({ projects: [], recent: [] }) } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'recovery-timeout-'));
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\recovery-${randomUUID()}` : join(directory, 'ipc.sock');
  let owned = false, discoveries = 0, resumes = 0;
  const ipcSockets = new Set();
  const ipcServer = createServer(socket => {
    ipcSockets.add(socket); socket.once('close', () => ipcSockets.delete(socket));
    let buffer = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE() + 4) {
        const length = buffer.readUInt32LE();
        const message = JSON.parse(buffer.subarray(4, length + 4)); buffer = buffer.subarray(length + 4);
        if (message.method === 'initialize') socket.write(frame({ type: 'response', requestId: message.requestId, resultType: 'success', result: { clientId: 'follower' } }));
        else if (message.method === 'thread-owner-discovery') {
          discoveries++;
          void (async () => {
            if (!owned) await discovery();
            if (!socket.destroyed) socket.write(frame(owned
              ? { type: 'response', requestId: message.requestId, resultType: 'success', handledByClientId: 'local-owner', result: {} }
              : { type: 'response', requestId: message.requestId, resultType: 'error', error: 'no-client-found' }));
          })();
        }
      }
    });
  });
  await new Promise(resolve => ipcServer.listen(socketPath, resolve));
  const reserve = createServer(); await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
  const port = reserve.address().port; await new Promise(resolve => reserve.close(resolve));
  const origin = `https://127.0.0.1:${port}`, base = `http://127.0.0.1:${port}`;
  const relay = createPairRelay({ origin, ...(recoveryResponseTimeoutMs === undefined ? {} : { recoveryResponseTimeoutMs }), ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }) });
  await relay.listen(port);
  const headers = { origin, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' };
  const post = (path, body, options = {}) => fetch(base + path, { ...options, method: 'POST', headers: { ...headers, ...options.headers }, body: JSON.stringify(body) });
  const host = await (await post('/api/enroll', { name: 'isolated-recovery-test' })).json();
  const code = await (await post('/api/host/pair-code', {}, { headers: { authorization: `Bearer ${host.secret}` } })).json();
  const paired = await post('/api/pair', { qrToken: code.qrToken }), phone = await paired.json();
  const cookie = paired.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
  const threadId = randomUUID(), journal = new CreationJournal(':memory:');
  const localOwner = { ownerId: () => 'local-owner', async resume() { resumes++; await resume(); owned = true; } };
  const router = new OwnerRouter({ discover: id => discoverDesktopOwner(id, () => new DesktopIpc({ socketPath })),
    localOwner, journal, hostId: host.hostId, projects: async () => [], competeUnknown: true });
  const route = router.route.bind(router);
  let isCancelled = () => false;
  router.route = (id, options) => { isCancelled = options.isCancelled; return route(id, options); };
  const started = deferred(), streamAbort = new AbortController();
  const connector = createPreviewConnector({ url: `ws://127.0.0.1:${port}/connector`, hostId: host.hostId, secret: host.secret,
    ownerRouter: router, allowInsecureForTests: true, listThreads, readHistory: async id => ({ id, title: 'Isolated', turns: [], requests: [] }),
    createSession: ({ conversationId }) => Object.assign(new EventEmitter(), { conversationId, start() { started.resolve(); }, async close() {} }),
  });
  connector.start();
  for (let attempt = 0; attempt < 200; attempt++) {
    const status = await fetch(base + '/api/host-status', { headers: { cookie, 'sec-fetch-site': 'same-origin' } });
    if ((await status.json()).online) break;
    await delay(10);
  }
  const stream = await fetch(base + `/api/threads/${threadId}/events`, { headers: { cookie, 'sec-fetch-site': 'same-origin' }, signal: streamAbort.signal });
  await started.promise;
  return { router, journal, threadId, hostId: host.hostId, deviceId: phone.deviceId,
    discoveries: () => discoveries, resumes: () => resumes,
    isCancelled: () => isCancelled(),
    list: () => fetch(base + '/api/threads', { headers: { cookie, 'sec-fetch-site': 'same-origin' } }),
    recover: (requestId, signal) => post(`/api/threads/${threadId}/recover`, { requestId }, { headers: { cookie }, signal }),
    attempt: requestId => journal.recoveryAttempt(host.hostId, phone.deviceId, threadId, requestId),
    async close() {
      streamAbort.abort(); await stream.body.cancel().catch(() => {});
      await connector.close(); await relay.close(); router.close(); journal.close();
      for (const socket of ipcSockets) socket.destroy();
      await new Promise(resolve => ipcServer.close(resolve)); await rm(directory, { recursive: true, force: true });
    },
  };
}

test('recovery completes after native-style discovery exceeds the ordinary 10 s relay deadline', { timeout: 20000 }, async () => {
  const f = await fixture({ discovery: () => delay(10020) });
  try {
    const requestId = randomUUID(), began = Date.now(), response = await f.recover(requestId);
    assert.equal(response.status, 202); assert.deepEqual(await response.json(), { status: 'accepted' });
    assert.ok(Date.now() - began >= 10000);
    assert.equal(f.discoveries(), 2, 'successful resume also rechecks ownership');
    assert.equal(f.resumes(), 1); assert.equal(f.attempt(requestId), 'accepted');
    assert.equal(f.router.isRecoveryLocked(f.threadId), false);
  } finally { await f.close(); }
});

for (const cancellation of ['relay-timeout', 'selection-abort']) {
  for (const phase of ['discovery', 'resume-success', 'resume-unknown']) {
    test(`${cancellation} during ${phase} preserves late-result and journal protections`, { timeout: 5000 }, async () => {
      const entered = deferred(), release = deferred();
      const wait = async () => { entered.resolve(); await release.promise; };
      const f = await fixture({ recoveryResponseTimeoutMs: cancellation === 'relay-timeout' ? 150 : 60000,
        discovery: phase === 'discovery' ? wait : undefined,
        resume: phase.startsWith('resume') ? async () => { await wait(); if (phase === 'resume-unknown') throw Object.assign(new Error('lost app-server result'), { code: 'outcome-unknown' }); } : undefined });
      const controller = new AbortController(), requestId = randomUUID();
      try {
        const outcome = f.recover(requestId, controller.signal).then(async response => ({ status: response.status, body: await response.json() }), error => ({ error }));
        await entered.promise;
        assert.equal(f.attempt(requestId), 'pending');
        assert.equal(f.router.isRecoveryLocked(f.threadId), phase.startsWith('resume'));
        if (cancellation === 'selection-abort') controller.abort();
        const response = await outcome;
        if (cancellation === 'relay-timeout') assert.deepEqual(response, { status: 504, body: { error: 'outcome-unknown' } });
        else assert.equal(response.error.name, 'AbortError');
        // The relay sends cancel-reply over the real connector socket. Wait for
        // that frame before releasing the simulated native/app-server result.
        await until(() => f.isCancelled()); release.resolve();
        const status = phase === 'resume-unknown' ? 'pending' : phase === 'resume-success' ? 'accepted' : 'rejected';
        await until(() => f.router.inFlight === 0 && f.attempt(requestId) === status);
        assert.equal(f.resumes(), phase.startsWith('resume') ? 1 : 0);
        assert.equal(f.attempt(requestId), status);
        assert.equal(f.router.isRecoveryLocked(f.threadId), phase === 'resume-unknown');
        if (phase === 'resume-unknown') {
          const retry = await f.recover(randomUUID());
          assert.equal(retry.status, 504); assert.deepEqual(await retry.json(), { error: 'outcome-unknown' });
          assert.equal(f.resumes(), 1, 'an uncertain late write cannot be dispatched twice');
        }
      } finally { release.resolve(); await until(() => f.router.inFlight === 0); await f.close(); }
    });
  }
}

test('ordinary request deadlines remain independent of the longer recovery budget', { timeout: 5000 }, async () => {
  const release = deferred();
  const f = await fixture({ requestTimeoutMs: 50, listThreads: async () => { await release.promise; return { projects: [], recent: [] }; } });
  try {
    const response = await f.list();
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: 'unavailable' });
    const recovery = await f.recover(randomUUID());
    assert.equal(recovery.status, 202); assert.equal(f.resumes(), 1);
  } finally { release.resolve(); await f.close(); }
});

test('recovery response budgets reject invalid values without starting a server', () => {
  for (const recoveryResponseTimeoutMs of [0, -1, 1.5, NaN, 120001]) {
    assert.throws(() => createPairRelay({ origin: 'https://relay.example.test', recoveryResponseTimeoutMs }), /Invalid recovery response timeout/);
  }
});
